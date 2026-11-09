import type { DataBroadcastAccumulator } from '../data/databroadcast.js';
import { parseEsMetadata } from '../es/index.js';
import type {
  Diagnostic,
  EsMetadata,
  ProbeCaSystem,
  ProbeClock,
  ProbeEasAlert,
  ProbeEmergency,
  ProbeEmergencySegment,
  ProbeEvent,
  ProbeEwbsService,
  ProbeEws,
  ProbeEwsDisaster,
  ProbeEwsMessage,
  ProbeEwsRegion,
  ProbeRatingRegion,
  ProbeResult,
  ProbeTable,
} from '../model/types.js';
import { parsePesHeader } from '../pes/assembler.js';
import { tableName } from '../tables/common.js';
import { EWS_TABLE_ID, type EwsSection, ewsTableName } from '../tables/ews.js';
import type { NitTransportStream } from '../tables/nit.js';
import type { PmtSection } from '../tables/pmt.js';
import type { AtscChannel } from '../tables/psip.js';
import type { SdtService } from '../tables/sdt.js';
import { parseT2miBuffer } from '../ts/t2mi.js';
import { hex16 } from '../util/bytes.js';
import {
  applyAtscAdvisories,
  buildPids,
  buildServices,
  choosePcrPid,
  detectStandard,
} from './derive.js';
import type {
  EmergencySpan,
  EwbsServiceSpan,
  EwsRegionSpan,
  MutablePidStat,
  PcrTrack,
  TableTrack,
} from './internal.js';
import { PCR_WRAP } from './internal.js';

/** Capability flags collected during the scan, before the summary is derived. */
export interface CapabilityFlags {
  teletext: boolean;
  dvbSubtitles: boolean;
  atscCaptions: boolean;
  aribCaptions: boolean;
  vbi: boolean;
  scte35: boolean;
}

/** Nominal maximum repetition interval per table, in seconds (TR 101 290). */
function repeatIntervalLimit(tableId: number): number | undefined {
  switch (tableId) {
    case 0x00: // PAT
    case 0x01: // CAT
    case 0x02: // PMT
    case 0x70: // TDT
    case 0xc7: // ATSC MGT / ISDB LDT
    case 0xc8: // ATSC TVCT / ISDB CDT
    case 0xc9: // ATSC CVCT
    case 0xcd: // ATSC STT
      return 0.5;
    case 0x42: // SDT
    case 0x46: // SDT (other TS)
    case 0x4e: // EIT p/f (actual)
    case 0x4f: // EIT p/f (other)
      return 2;
    case 0x40: // NIT
    case 0x41: // NIT (other TS)
    case 0x4a: // BAT
      return 10;
    case 0x71: // RST
    case 0x72: // ST
    case 0x7e: // DIT
      return 1;
    default:
      return undefined;
  }
}

/** Read-only scan accumulators plus the mutable result being filled in. */
export interface FinalizeInput {
  base: ProbeResult;
  diagnostics: Diagnostic[];
  packetCount: number;
  syncLosses: number;
  firstSyncLoss: number | undefined;
  teiPackets: number;
  scrambledPackets: number;
  esLimitHit: boolean;
  tableLimitDropped: number;
  eventLimitDropped: number;
  ettLimitDropped: number;
  esTotalLimit: number;
  maxTables: number;
  maxEvents: number;
  maxEttText: number;
  sampleBytes: number;
  expectedSize: number | undefined;
  packetSize: number;
  patPrograms: Map<number, number>;
  stats: Map<number, MutablePidStat>;
  pmtByProgram: Map<number, PmtSection>;
  pmtPids: Set<number>;
  pcrPidCounts: Map<number, number>;
  pcrTracks: Map<number, PcrTrack>;
  esBuffers: Map<number, Uint8Array>;
  esLengths: Map<number, number>;
  sdtActualServiceById: Map<number, SdtService>;
  atscChannels: Map<number, AtscChannel>;
  patTsid: number | undefined;
  sdtActualTsid: number | undefined;
  sdtActualOnid: number | undefined;
  nitActualTransports: NitTransportStream[] | undefined;
  sdtActualServices: Set<number>;
  sdtOtherByTsid: Map<number, Set<number>>;
  t2miPids: Set<number>;
  ssuSignalled: boolean;
  caBySystem: Map<number, { ecm: Set<number>; emm: Set<number> }>;
  caSystems: Set<number>;
  capabilities: CapabilityFlags;
  eventsByKey: Map<string, ProbeEvent>;
  clock: ProbeClock | undefined;
  ratingsByRegion: Map<number, ProbeRatingRegion>;
  iipPid: number | undefined;
  trailerPackets: number;
  isdbLayers: Map<number, number>;
  iipPackets: number;
  emergencyControlPackets: number;
  tmccIdentifiers: Set<number>;
  frameHeadPackets: number;
  lastCountDownIndex: number | undefined;
  partialReception: { startServiceId: number; endServiceId: number } | undefined;
  bufferResetPackets: number;
  tables: Map<string, ProbeTable>;
  tableTracks: Map<string, TableTrack>;
  sectionMaxGap: Map<string, number>;
  t2miBuffers: Map<number, Uint8Array>;
  t2miLengths: Map<number, number>;
  catPidSeen: number | undefined;
  catVersionSeen: number | undefined;
  easAlerts: Map<string, ProbeEasAlert>;
  easPids: Set<number>;
  ewbsServices: Map<number, ProbeEwbsService>;
  ewsPids: Set<number>;
  ewsSections: Map<string, EwsSection>;
  ewsRegionSpans: EwsRegionSpan[];
  ewbsServiceSpans: EwbsServiceSpan[];
  ewbsFlagSpans: EmergencySpan[];
  streamEndSec: number;
  dataBroadcast: DataBroadcastAccumulator;
  epgTableIds: Map<number, Set<number>>;
  tableIds: Set<number>;
  descriptorTags: Set<number>;
  esTargetPids: Set<number>;
  dataPids: Set<number>;
  atscTablePids: Set<number>;
  networkPid: number | undefined;
  ptsDtsErrors: number;
}

/** Keep only the newest version of each Indonesian EWS table kind. */
function latestEwsSections(sections: EwsSection[]): EwsSection[] {
  const bestVersion = new Map<EwsSection['kind'], number>();
  for (const section of sections) {
    const best = bestVersion.get(section.kind);
    if (best === undefined || section.version > best)
      bestVersion.set(section.kind, section.version);
  }
  return sections.filter((section) => section.version === bestVersion.get(section.kind));
}

function buildEws(sections: Map<string, EwsSection>): ProbeEws | undefined {
  if (sections.size === 0) return undefined;
  const regions: ProbeEwsRegion[] = [];
  const disasters: ProbeEwsDisaster[] = [];
  const messages: ProbeEwsMessage[] = [];
  const regionKeys = new Set<string>();
  const disasterKeys = new Set<string>();
  const messageKeys = new Set<string>();
  for (const section of latestEwsSections([...sections.values()])) {
    for (const region of section.regions) {
      const key = `${region.disasterCode}:${region.locationTypeCode}:${region.packageId}:${region.locations
        .map((location) => location.code)
        .join('|')}`;
      if (regionKeys.has(key)) continue;
      regionKeys.add(key);
      regions.push(region);
    }
    for (const disaster of section.disasters) {
      const key = `${disaster.packageId}:${disaster.authority}:${disaster.disasterCode}:${disaster.name}`;
      if (disasterKeys.has(key)) continue;
      disasterKeys.add(key);
      disasters.push(disaster);
    }
    for (const message of section.messages) {
      const key = `${message.locationTypeCode}:${message.packageId}:${message.message}`;
      if (messageKeys.has(key)) continue;
      messageKeys.add(key);
      messages.push(message);
    }
  }
  if (regions.length === 0 && disasters.length === 0 && messages.length === 0) return undefined;
  regions.sort(
    (a, b) =>
      a.locationTypeCode - b.locationTypeCode ||
      a.disasterCode - b.disasterCode ||
      a.packageId - b.packageId,
  );
  disasters.sort((a, b) => a.disasterCode - b.disasterCode || a.packageId - b.packageId);
  messages.sort((a, b) => a.locationTypeCode - b.locationTypeCode || a.packageId - b.packageId);
  const pid = Math.min(...[...sections.keys()].map((key) => Number(key.split(':')[0])));
  return { pid, regions, disasters, messages };
}

/**
 * Build the time-segmented emergency view. Every warning (alert, EWS region or
 * EWBS service) becomes a segment in stream (PCR) time; a segment that is still
 * present near the end of the sample has no end time (ongoing).
 */
function buildEmergencyTimeline(input: {
  easAlerts: ProbeEasAlert[];
  ewsSections: Map<string, EwsSection>;
  ewsRegionSpans: EwsRegionSpan[];
  ewbsServiceSpans: EwbsServiceSpan[];
  ewbsFlagSpans: EmergencySpan[];
  streamEndSec: number;
}): ProbeEmergencySegment[] {
  const segments: ProbeEmergencySegment[] = [];
  const round = (seconds: number) => Math.round(seconds * 1000) / 1000;
  const endOf = (lastSeenSec: number): number | undefined =>
    lastSeenSec >= input.streamEndSec - 3 ? undefined : round(lastSeenSec);
  const ewsSections = [...input.ewsSections.values()];
  const ewsDisasters = ewsSections.flatMap((section) => section.disasters);
  const ewsMessages = ewsSections.flatMap((section) => section.messages);

  for (const alert of input.easAlerts) {
    const startSec = alert.firstSeenSec ?? 0;
    const durationEnd = alert.durationSec > 0 ? startSec + alert.durationSec : undefined;
    segments.push({
      kind: 'EAS',
      startSec: round(startSec),
      ...(durationEnd !== undefined
        ? { endSec: round(durationEnd) }
        : { endSec: endOf(alert.lastSeenSec ?? startSec) }),
      level: alert.priority,
      title: alert.alertText
        ? `${alert.eventCode} - ${alert.alertText}`
        : `${alert.eventCode} (${alert.originatorCode})`,
      areas: alert.locations
        .map(
          (location) =>
            `${location.stateCode}/${location.countySubdivision}/${location.countyCode}`,
        )
        .join(', '),
      pid: alert.pid,
    });
  }

  for (const span of input.ewsRegionSpans) {
    const disaster = ewsDisasters.find((entry) => entry.disasterCode === span.disasterCode);
    const messages = ewsMessages
      .filter((entry) => entry.locationTypeCode === span.locationTypeCode)
      .map((entry) => entry.message);
    segments.push({
      kind: 'EWS',
      startSec: round(span.startSec),
      ...(endOf(span.lastSeenSec) !== undefined ? { endSec: endOf(span.lastSeenSec) } : {}),
      level: span.locationTypeCode,
      title: disaster?.name || `disaster 0x${span.disasterCode.toString(16)}`,
      areas: span.locations
        .map((location) => `${location.code} ${location.description}`.trim())
        .join(', '),
      ...(messages.length > 0 ? { detail: [...new Set(messages)].join(' / ') } : {}),
      pid: span.pid,
    });
  }

  for (const span of input.ewbsServiceSpans) {
    segments.push({
      kind: 'EWBS',
      startSec: round(span.startSec),
      ...(endOf(span.lastSeenSec) !== undefined ? { endSec: endOf(span.lastSeenSec) } : {}),
      level: span.signalLevel,
      title: `service ${span.serviceId}`,
      areas: span.areaCodes.join(', '),
      detail: 'EWBS emergency information descriptor',
      serviceId: span.serviceId,
    });
  }

  for (const span of input.ewbsFlagSpans) {
    segments.push({
      kind: 'EWBS',
      startSec: round(span.startSec),
      ...(endOf(span.lastSeenSec) !== undefined ? { endSec: endOf(span.lastSeenSec) } : {}),
      title: 'TMCC emergency control flag',
    });
  }

  segments.sort(
    (a, b) =>
      a.startSec - b.startSec || a.kind.localeCompare(b.kind) || (a.level ?? 0) - (b.level ?? 0),
  );
  return segments;
}

/**
 * Post-scan diagnosis and summary: turn the collected accumulators into the
 * public ProbeResult and append the derived diagnostics. Mutates `base` and
 * `diagnostics`; the scan state itself is only read.
 */
export function finalizeProbe(input: FinalizeInput): void {
  const {
    base,
    diagnostics,
    packetCount,
    syncLosses,
    firstSyncLoss,
    teiPackets,
    scrambledPackets,
    esLimitHit,
    tableLimitDropped,
    eventLimitDropped,
    ettLimitDropped,
    esTotalLimit,
    maxTables,
    maxEvents,
    maxEttText,
    sampleBytes,
    expectedSize,
    packetSize,
    patPrograms,
    stats,
    pmtByProgram,
    pmtPids,
    pcrPidCounts,
    pcrTracks,
    esBuffers,
    esLengths,
    sdtActualServiceById,
    atscChannels,
    patTsid,
    sdtActualTsid,
    sdtActualOnid,
    nitActualTransports,
    sdtActualServices,
    sdtOtherByTsid,
    t2miPids,
    ssuSignalled,
    caBySystem,
    caSystems,
    capabilities,
    eventsByKey,
    clock,
    ratingsByRegion,
    iipPid,
    trailerPackets,
    isdbLayers,
    iipPackets,
    emergencyControlPackets,
    tmccIdentifiers,
    frameHeadPackets,
    lastCountDownIndex,
    partialReception,
    bufferResetPackets,
    tables,
    tableTracks,
    sectionMaxGap,
    t2miBuffers,
    t2miLengths,
    catPidSeen,
    catVersionSeen,
    easAlerts,
    easPids,
    ewbsServices,
    ewsSections,
    ewsRegionSpans,
    ewbsServiceSpans,
    ewbsFlagSpans,
    streamEndSec,
    dataBroadcast,
    epgTableIds,
    tableIds,
    descriptorTags,
    esTargetPids,
    dataPids,
    atscTablePids,
    networkPid,
    ptsDtsErrors,
  } = input;

  if (packetCount === 0) {
    diagnostics.push({
      code: 'TS_NO_PACKETS',
      severity: 'error',
      message: 'The sync pattern was found, but no complete TS packet could be parsed.',
    });
  }
  if (syncLosses > 0) {
    diagnostics.push({
      code: 'TS_SYNC_LOSS',
      severity: 'warning',
      message: `Lost packet sync ${syncLosses} time(s) in the sampled data.`,
      ...(firstSyncLoss !== undefined ? { packet: firstSyncLoss } : {}),
    });
  }
  if (teiPackets > 0) {
    diagnostics.push({
      code: 'TS_TEI',
      severity: 'warning',
      message: `${teiPackets} packet(s) have the transport_error_indicator set.`,
    });
  }
  if (scrambledPackets > 0) {
    diagnostics.push({
      code: 'TS_SCRAMBLED',
      severity: 'info',
      message: `${scrambledPackets} packet(s) are scrambled; elementary stream details may be unavailable.`,
    });
  }
  if (esLimitHit) {
    diagnostics.push({
      code: 'ES_BUFFER_LIMIT',
      severity: 'warning',
      message: `Elementary stream metadata buffering reached its ${esTotalLimit / (1024 * 1024)} MiB limit; some stream details were skipped.`,
    });
  }
  if (tableLimitDropped > 0) {
    diagnostics.push({
      code: 'TABLE_INDEX_LIMIT',
      severity: 'warning',
      message: `Table index reached its ${maxTables} entry limit; ${tableLimitDropped} additional section(s) were not indexed.`,
    });
  }
  if (eventLimitDropped > 0) {
    diagnostics.push({
      code: 'EVENT_INDEX_LIMIT',
      severity: 'warning',
      message: `EPG event index reached its ${maxEvents} entry limit; ${eventLimitDropped} additional event(s) were not indexed.`,
    });
  }
  if (ettLimitDropped > 0) {
    diagnostics.push({
      code: 'ETT_TEXT_LIMIT',
      severity: 'warning',
      message: `ATSC ETT text cache reached its ${maxEttText} entry limit; ${ettLimitDropped} additional text block(s) were not stored.`,
    });
  }
  if (patPrograms.size === 0) {
    diagnostics.push({
      code: 'PAT_MISSING',
      severity: 'error',
      message: 'No PAT with programs was found in the sampled data.',
    });
  }
  if (diagnostics.length === 0) {
    diagnostics.push({
      code: 'PROBE_OK',
      severity: 'info',
      message: 'No transport or PSI errors detected in the sampled data.',
    });
  }
  if (expectedSize !== undefined && sampleBytes < expectedSize) {
    diagnostics.push({
      code: 'SAMPLE_LIMITED',
      severity: 'info',
      message: `Only the first ${sampleBytes} of ${expectedSize} bytes were analysed.`,
    });
  }

  for (const [pid, stat] of stats) {
    if (stat.ccErrors > 0) {
      diagnostics.push({
        code: 'TS_CC_DISCONTINUITY',
        severity: 'warning',
        message: `PID ${hex16(pid)} has ${stat.ccErrors} continuity counter error(s).`,
        pid,
      });
    }
    if (stat.duplicates > 0) {
      diagnostics.push({
        code: 'TS_DUPLICATE_PACKET',
        severity: 'info',
        message: `PID ${hex16(pid)} repeats its continuity counter ${stat.duplicates} time(s); duplicate packets carry no new payload.`,
        pid,
      });
    }
  }

  for (const programNumber of patPrograms.keys()) {
    if (!pmtByProgram.has(programNumber)) {
      diagnostics.push({
        code: 'PMT_MISSING',
        severity: 'warning',
        message: `No PMT found for program ${programNumber}.`,
        tableId: 0x02,
      });
    }
  }

  const pcrPid = choosePcrPid(pmtByProgram, pcrPidCounts);
  base.transport.pcrPid = pcrPid;
  if (pcrPid !== undefined) {
    const track = pcrTracks.get(pcrPid);
    if (track && track.count > 1) {
      const durationTicks =
        track.last >= track.first ? track.last - track.first : track.last + PCR_WRAP - track.first;
      const durationSec = durationTicks / 27_000_000;
      if (durationSec > 0) {
        base.transport.durationSec = durationSec;
        base.transport.bitrateBps = (packetCount * 188 * 8) / durationSec;
      }
    }
  }

  const ALLOWED_ES_TYPES = new Set([
    0x01, 0x02, 0x03, 0x04, 0x0f, 0x11, 0x1b, 0x1c, 0x1f, 0x20, 0x24, 0x25, 0x26, 0x28, 0x29, 0x2a,
    0x2b, 0x06, 0x81, 0x84, 0x85, 0x87, 0x88, 0x8a,
  ]);
  const esByPid = new Map<number, EsMetadata>();
  for (const [pid, buffer] of esBuffers) {
    const length = esLengths.get(pid) ?? 0;
    if (length === 0) continue;
    let stream: PmtSection['streams'][number] | undefined;
    let owningPmt: PmtSection | undefined;
    for (const pmt of pmtByProgram.values()) {
      stream = pmt.streams.find((candidate) => candidate.pid === pid);
      if (stream) {
        owningPmt = pmt;
        break;
      }
    }
    if (!stream) continue;
    const stat = stats.get(pid);
    if (stat && stat.packets > 0 && stat.scrambled >= stat.packets * 0.5) continue;
    if (
      owningPmt?.programDescriptors.some(
        (descriptor) => descriptor.tag === 0x09 || descriptor.tag === 0xf6,
      )
    ) {
      continue;
    }
    if (
      stream.descriptors.some((descriptor) => descriptor.tag === 0x09 || descriptor.tag === 0xf6)
    ) {
      continue;
    }
    if (stream.descriptors.some((descriptor) => descriptor.tag === 0xfd)) continue;
    if (!ALLOWED_ES_TYPES.has(stream.streamType)) continue;
    const raw = buffer.subarray(0, length);
    const pes = parsePesHeader(raw);
    const payload = pes ? raw.subarray(pes.payloadOffset) : raw;
    const es = parseEsMetadata(
      stream.streamType,
      payload,
      new Set(stream.descriptors.map((descriptor) => descriptor.tag)),
      new Set(
        stream.descriptors
          .filter((descriptor) => descriptor.tag === 0x7f && descriptor.raw.length >= 2)
          .map((descriptor) => Number.parseInt(descriptor.raw.slice(0, 2), 16)),
      ),
    );
    if (es) esByPid.set(pid, es);
  }

  base.services = buildServices(
    patPrograms,
    pmtByProgram,
    sdtActualServiceById,
    atscChannels,
    esByPid,
    stats,
    packetSize,
    base.transport.durationSec,
    patTsid,
    t2miPids,
    ssuSignalled,
    caBySystem,
  );
  base.capabilities = {
    ...capabilities,
    scrambled: scrambledPackets > 0,
    caSystems: [...caSystems].sort((a, b) => a - b),
  };
  base.events = [...eventsByKey.values()].sort(
    (a, b) =>
      a.serviceId - b.serviceId ||
      (a.startTimeIso ?? '').localeCompare(b.startTimeIso ?? '') ||
      a.eventId - b.eventId,
  );
  if (clock) base.clock = clock;
  if (ratingsByRegion.size > 0) {
    base.ratings = [...ratingsByRegion.values()].sort((a, b) => a.ratingRegion - b.ratingRegion);
    applyAtscAdvisories(base.events, base.ratings);
  }
  if (clock?.countryCode !== undefined) {
    base.transport.country = clock.countryCode;
  }
  base.pids = buildPids(stats, pmtPids, pmtByProgram, pcrPid);
  if (iipPid !== undefined) {
    const iip = base.pids.find((pid) => pid.pid === iipPid);
    if (iip) {
      iip.kind = 'ISDB IIP';
      iip.iip = true;
    }
  }
  if (trailerPackets > 0) {
    base.isdb = {
      trailerPackets,
      layers: [...isdbLayers.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([layer, packets]) => ({ layer, packets })),
      iipPackets,
      ...(iipPid !== undefined ? { iipPid } : {}),
      emergencyControlPackets,
      ...(tmccIdentifiers.size > 0
        ? { tmccIdentifiers: [...tmccIdentifiers].sort((a, b) => a - b) }
        : {}),
      ...(frameHeadPackets > 0
        ? {
            frameIndicators: {
              frameHead: frameHeadPackets,
              countDown: lastCountDownIndex ?? 0,
            },
          }
        : {}),
      ...(partialReception !== undefined ? { partialReception } : {}),
      ...(bufferResetPackets > 0 ? { bufferResetPackets } : {}),
      ...(clock?.countryCode !== undefined ? { country: clock.countryCode } : {}),
    };
  }
  const overallBitrate = base.transport.bitrateBps;
  for (const [key, entry] of tables) {
    const groupKey = `${entry.pid}:${entry.tableId}:${entry.tableIdExtension ?? 0}`;
    const track = tableTracks.get(groupKey);
    if (track) {
      if (track.versions.size > 0) {
        entry.versions = [...track.versions].sort((a, b) => a - b);
      }
      if (entry.version !== undefined) {
        const versionInfo = track.sectionsByVersion.get(entry.version);
        if (versionInfo) {
          const missing: number[] = [];
          for (let number = 0; number <= versionInfo.last; number += 1) {
            if (!versionInfo.seen.has(number)) missing.push(number);
          }
          if (missing.length > 0) entry.missingSections = missing;
        }
      }
    }
    if (
      overallBitrate !== undefined &&
      overallBitrate > 0 &&
      entry.occurrences > 1 &&
      entry.lastPacket !== undefined
    ) {
      const elapsedSec = ((entry.lastPacket - entry.firstPacket) * packetSize * 8) / overallBitrate;
      if (elapsedSec > 0) entry.repeatIntervalSec = elapsedSec / (entry.occurrences - 1);
      const maxGap = sectionMaxGap.get(key);
      if (maxGap !== undefined && maxGap > 0) {
        entry.maxRepeatGapSec = (maxGap * packetSize * 8) / overallBitrate;
      }
    }
  }
  base.tables = [...tables.values()].sort(
    (a, b) =>
      a.pid - b.pid ||
      a.tableId - b.tableId ||
      (a.tableIdExtension ?? 0) - (b.tableIdExtension ?? 0) ||
      (a.sectionNumber ?? 0) - (b.sectionNumber ?? 0),
  );

  for (const [pid, buffer] of t2miBuffers) {
    const length = t2miLengths.get(pid) ?? 0;
    if (length === 0) continue;
    const summary = parseT2miBuffer(buffer.subarray(0, length));
    if (summary.packets === 0) continue;
    base.t2mi = {
      pid,
      packets: summary.packets,
      types: summary.types,
      tsPackets: summary.tsPackets,
      crcErrors: summary.crcErrors,
    };
    break;
  }

  const caSystemList: ProbeCaSystem[] = [];
  for (const [systemId, entry] of caBySystem) {
    caSystemList.push({
      caSystemId: systemId,
      ecmPids: [...entry.ecm].sort((a, b) => a - b),
      emmPids: [...entry.emm].sort((a, b) => a - b),
    });
  }
  if (caSystemList.length > 0 || catPidSeen !== undefined) {
    caSystemList.sort((a, b) => a.caSystemId - b.caSystemId);
    const ca = {
      ...(catPidSeen !== undefined ? { catPid: catPidSeen } : {}),
      ...(catVersionSeen !== undefined ? { catVersion: catVersionSeen } : {}),
      systems: caSystemList,
      ecmPids: [...new Set(caSystemList.flatMap((entry) => entry.ecmPids))].sort((a, b) => a - b),
      emmPids: [...new Set(caSystemList.flatMap((entry) => entry.emmPids))].sort((a, b) => a - b),
    };
    base.conditionalAccess = ca;
    for (const pid of base.pids) {
      if (ca.ecmPids.includes(pid.pid)) {
        pid.kind = 'ECM';
      } else if (ca.emmPids.includes(pid.pid)) {
        pid.kind = 'EMM';
      }
    }
  }

  const easList = [...easAlerts.values()].sort(
    (a, b) => a.priority - b.priority || a.eventId - b.eventId,
  );
  const ewbsServiceList = [...ewbsServices.values()].sort((a, b) => a.serviceId - b.serviceId);
  const emergency: ProbeEmergency = {};
  if (easList.length > 0) emergency.eas = easList;
  if (emergencyControlPackets > 0 || ewbsServiceList.length > 0) {
    emergency.ewbs = {
      activated: emergencyControlPackets > 0,
      activationPackets: emergencyControlPackets,
      services: ewbsServiceList,
      ...(tmccIdentifiers.size > 0
        ? { tmccIdentifiers: [...tmccIdentifiers].sort((a, b) => a - b) }
        : {}),
    };
  }
  const ews = buildEws(ewsSections);
  if (ews) emergency.ews = ews;
  const timeline = buildEmergencyTimeline({
    easAlerts: easList,
    ewsSections,
    ewsRegionSpans,
    ewbsServiceSpans,
    ewbsFlagSpans,
    streamEndSec,
  });
  if (timeline.length > 0) emergency.timeline = timeline;
  if (
    emergency.eas !== undefined ||
    emergency.ewbs !== undefined ||
    emergency.ews !== undefined ||
    emergency.timeline !== undefined
  ) {
    base.emergency = emergency;
    for (const pid of base.pids) {
      if (easPids.has(pid.pid)) pid.kind = 'EAS';
      if (ews?.pid === pid.pid) pid.kind = 'EWS';
    }
  }

  const broadcast = dataBroadcast.finish();
  if (broadcast) base.dataBroadcast = broadcast;

  for (const service of base.services) {
    const serviceKey = service.serviceId ?? service.sourceId;
    const ewbs = ewbsServices.get(serviceKey ?? -1) ?? ewbsServices.get(service.programNumber);
    if (ewbs) service.ewbs = ewbs;
    if (serviceKey === undefined) continue;
    const serviceEvents = base.events.filter(
      (event) =>
        event.serviceId === serviceKey &&
        event.startTimeIso !== undefined &&
        event.endTimeIso !== undefined,
    );
    if (serviceEvents.length === 0) continue;
    let firstStart = serviceEvents[0]?.startTimeIso;
    let lastEnd = serviceEvents[0]?.endTimeIso;
    for (const event of serviceEvents) {
      if (
        event.startTimeIso !== undefined &&
        (firstStart === undefined || event.startTimeIso < firstStart)
      ) {
        firstStart = event.startTimeIso;
      }
      if (event.endTimeIso !== undefined && (lastEnd === undefined || event.endTimeIso > lastEnd)) {
        lastEnd = event.endTimeIso;
      }
    }
    const firstMs = firstStart !== undefined ? Date.parse(firstStart) : Number.NaN;
    const lastMs = lastEnd !== undefined ? Date.parse(lastEnd) : Number.NaN;
    const days =
      Number.isFinite(firstMs) && Number.isFinite(lastMs) && lastMs > firstMs
        ? Math.max(1, Math.ceil((lastMs - firstMs) / 86_400_000))
        : 1;
    service.epg = {
      events: serviceEvents.length,
      ...(firstStart !== undefined ? { firstStartIso: firstStart } : {}),
      ...(lastEnd !== undefined ? { lastEndIso: lastEnd } : {}),
      days,
    };
    const ids = epgTableIds.get(serviceKey);
    if (ids) service.epg.tableIds = [...ids].sort((a, b) => a - b);
  }

  const detection = detectStandard({
    layoutSize: packetSize,
    tableIds,
    descriptorTags,
    pmtByProgram,
    hasAtscPsi: stats.has(0x1ffb),
  });
  base.standard = detection;
  for (const table of base.tables) {
    table.name = tableName(table.tableId, detection.detected);
    if (
      ews !== undefined &&
      table.pid === ews.pid &&
      table.tableId === EWS_TABLE_ID &&
      table.tableIdExtension !== undefined
    ) {
      table.name = ewsTableName(table.tableIdExtension);
    }
  }

  const extraDiagnostics: Diagnostic[] = [];
  let totalCcErrors = 0;
  for (const stat of stats.values()) totalCcErrors += stat.ccErrors;
  const reportedMissingSections = new Set<string>();
  for (const table of base.tables) {
    const sectionCompletenessRelevant =
      table.tableId <= 0x02 ||
      table.tableId === 0x40 ||
      table.tableId === 0x41 ||
      table.tableId === 0x42 ||
      table.tableId === 0x46 ||
      table.tableId === 0x4a ||
      table.tableId === 0x4c ||
      table.tableId === 0xa0 ||
      (table.tableId >= 0xc7 && table.tableId <= 0xcd);
    if (
      sectionCompletenessRelevant &&
      table.missingSections !== undefined &&
      table.missingSections.length > 0
    ) {
      const groupKey = `${table.pid}:${table.tableId}:${table.tableIdExtension ?? 0}`;
      if (!reportedMissingSections.has(groupKey)) {
        reportedMissingSections.add(groupKey);
        extraDiagnostics.push({
          code: 'PSI_SECTION_MISSING',
          severity: 'warning',
          message: `${table.name} on PID ${hex16(table.pid)} is missing section(s) ${table.missingSections.join(', ')}.`,
          pid: table.pid,
          tableId: table.tableId,
        });
      }
    }
    if (table.versions !== undefined && table.versions.length > 1) {
      extraDiagnostics.push({
        code: 'TABLE_VERSION_CHANGE',
        severity: 'info',
        message: `${table.name} on PID ${hex16(table.pid)} was seen with versions ${table.versions.join(', ')}.`,
        pid: table.pid,
        tableId: table.tableId,
      });
    }
    const limit = repeatIntervalLimit(table.tableId);
    if (
      limit !== undefined &&
      totalCcErrors === 0 &&
      table.repeatIntervalSec !== undefined &&
      table.occurrences >= 3 &&
      table.repeatIntervalSec > limit
    ) {
      extraDiagnostics.push({
        code: 'PSI_REPETITION_INTERVAL',
        severity: 'info',
        message: `${table.name} average repetition interval ${table.repeatIntervalSec.toFixed(2)} s exceeds ${limit} s.`,
        pid: table.pid,
        tableId: table.tableId,
      });
    }
  }

  // Cross-table consistency: PAT announces the transport_stream_id and SDT
  // actual must repeat it; the NIT entry for that TS must agree on the
  // original_network_id. SDT other sections for the current TS are also
  // expected to list the same services as SDT actual.
  if (patTsid !== undefined && sdtActualTsid !== undefined && patTsid !== sdtActualTsid) {
    extraDiagnostics.push({
      code: 'TSID_MISMATCH',
      severity: 'warning',
      message: `PAT transport_stream_id ${hex16(patTsid)} differs from SDT actual ${hex16(sdtActualTsid)}.`,
      tableId: 0x42,
    });
  }
  if (sdtActualOnid !== undefined && nitActualTransports !== undefined) {
    const nitEntry = nitActualTransports.find(
      (transport) => transport.transportStreamId === (sdtActualTsid ?? patTsid),
    );
    if (nitEntry !== undefined && nitEntry.originalNetworkId !== sdtActualOnid) {
      extraDiagnostics.push({
        code: 'ONID_MISMATCH',
        severity: 'warning',
        message: `SDT original_network_id ${hex16(sdtActualOnid)} differs from NIT entry ${hex16(nitEntry.originalNetworkId)} for the current transport stream.`,
        tableId: 0x40,
      });
    }
  }
  if (sdtActualTsid !== undefined && sdtActualServices.size > 0) {
    const other = sdtOtherByTsid.get(sdtActualTsid);
    if (other !== undefined) {
      const extraInOther = [...other].filter((serviceId) => !sdtActualServices.has(serviceId));
      const missingFromOther = [...sdtActualServices].filter((serviceId) => !other.has(serviceId));
      if (extraInOther.length > 0 || missingFromOther.length > 0) {
        extraDiagnostics.push({
          code: 'SDT_OTHER_INCONSISTENT',
          severity: 'info',
          message: `SDT other for TS ${hex16(sdtActualTsid)} lists ${other.size} service(s) but SDT actual lists ${sdtActualServices.size}; ${extraInOther.length} not in actual, ${missingFromOther.length} missing from other.`,
          tableId: 0x46,
        });
      }
    }
  }

  // PIDs that carry packets but are never referenced by PAT/PMT/PSI/SI are
  // usually private data, leftovers from re-multiplexing, or a missing
  // declaration. Aggregate them into a single diagnostic to avoid noise.
  const referencedPids = new Set<number>([
    0x0000, 0x0001, 0x0002, 0x0010, 0x0011, 0x0012, 0x0013, 0x0014, 0x1ff0, 0x1ffb, 0x1fff,
  ]);
  if (networkPid !== undefined) referencedPids.add(networkPid);
  if (pcrPid !== undefined) referencedPids.add(pcrPid);
  if (iipPid !== undefined) referencedPids.add(iipPid);
  for (const pid of pmtPids) referencedPids.add(pid);
  for (const pid of esTargetPids) referencedPids.add(pid);
  for (const pid of dataPids) referencedPids.add(pid);
  for (const pid of atscTablePids) referencedPids.add(pid);
  for (const pid of easPids) referencedPids.add(pid);
  for (const pid of t2miPids) referencedPids.add(pid);
  for (const entry of caBySystem.values()) {
    for (const pid of entry.ecm) referencedPids.add(pid);
    for (const pid of entry.emm) referencedPids.add(pid);
  }
  for (const table of base.tables) referencedPids.add(table.pid);
  for (const pid of base.pids) {
    if (pid.kind) referencedPids.add(pid.pid);
  }
  const unreferencedPids = [...stats.entries()]
    .filter(([pid, stat]) => stat.packets > 0 && !referencedPids.has(pid))
    .map(([pid]) => pid)
    .sort((a, b) => a - b);
  if (unreferencedPids.length > 0) {
    const sample = unreferencedPids
      .slice(0, 8)
      .map((pid) => hex16(pid))
      .join(', ');
    extraDiagnostics.push({
      code: 'UNREFERENCED_PID',
      severity: 'info',
      message: `${unreferencedPids.length} PID(s) carry packets but are not referenced by PAT/PMT/PSI/SI: ${sample}${unreferencedPids.length > 8 ? ', …' : ''}.`,
      pid: unreferencedPids[0],
    });
  }

  for (const [pid, track] of pcrTracks) {
    if (
      totalCcErrors === 0 &&
      track.maxGapTicks !== undefined &&
      track.maxGapTicks > 0.04 * 27_000_000
    ) {
      extraDiagnostics.push({
        code: 'PCR_INTERVAL',
        severity: 'warning',
        message: `PCR PID ${hex16(pid)} maximum interval ${(track.maxGapTicks / 27000).toFixed(1)} ms exceeds 40 ms.`,
        pid,
      });
    }
    if (track.backwardsJumps !== undefined && track.backwardsJumps > 0) {
      extraDiagnostics.push({
        code: 'PCR_DISCONTINUITY',
        severity: 'warning',
        message: `PCR PID ${hex16(pid)} has ${track.backwardsJumps} backwards discontinuity(ies).`,
        pid,
      });
    }
  }

  if (ptsDtsErrors > 0) {
    extraDiagnostics.push({
      code: 'PTS_DTS_ERROR',
      severity: 'warning',
      message: `DTS is greater than PTS in ${ptsDtsErrors} PES header(s).`,
    });
  }

  if (detection.detected !== 'ISDB' && scrambledPackets > 0 && catPidSeen === undefined) {
    extraDiagnostics.push({
      code: 'CA_CAT_MISSING',
      severity: 'warning',
      message: 'Scrambled packets are present but no CAT was found.',
    });
  }
  if (detection.detected !== 'ISDB') {
    for (const [systemId, entry] of caBySystem) {
      for (const ecmPid of entry.ecm) {
        if (ecmPid === 0x1fff) continue;
        const ecmStat = stats.get(ecmPid);
        if (!ecmStat || ecmStat.packets === 0) {
          extraDiagnostics.push({
            code: 'CA_ECM_MISSING',
            severity: 'warning',
            message: `CA system ${systemId} ECM PID ${hex16(ecmPid)} carries no packets.`,
            pid: ecmPid,
          });
        }
      }
    }
  }

  if (base.t2mi && base.t2mi.crcErrors > 0) {
    extraDiagnostics.push({
      code: 'T2MI_CRC_ERROR',
      severity: 'warning',
      message: `${base.t2mi.crcErrors} T2-MI packet(s) failed CRC verification.`,
      pid: base.t2mi.pid,
    });
  }

  for (const alert of easList) {
    extraDiagnostics.push({
      code: 'EAS_ALERT_ACTIVE',
      severity: 'info',
      message: `EAS ${alert.eventCode || 'alert'} from ${alert.originatorCode || 'unknown'} is active (priority ${alert.priority}, ${alert.timeRemainingSec}s remaining).`,
      pid: alert.pid,
    });
  }

  const startedEwbs = ewbsServiceList.filter((service) => service.started);
  if (emergency.ewbs) {
    emergency.ewbs.activated = emergencyControlPackets > 0 || startedEwbs.length > 0;
  }
  if (emergency.ewbs?.activated === true) {
    extraDiagnostics.push({
      code: 'EWBS_ACTIVE',
      severity: 'info',
      message: `EWBS activation is signalled (${emergencyControlPackets} TMCC trailer packet(s), ${startedEwbs.length} started service(s)).`,
    });
  }
  if (ews !== undefined && ews.regions.length > 0) {
    const names = [
      ...new Set(
        ews.regions.map((region) => {
          const disaster = ews.disasters.find(
            (entry) => entry.disasterCode === region.disasterCode,
          );
          return disaster?.name || `disaster 0x${region.disasterCode.toString(16)}`;
        }),
      ),
    ];
    const levels = [...new Set(ews.regions.map((region) => region.locationTypeCode))].sort();
    const locations = ews.regions.reduce((total, region) => total + region.locations.length, 0);
    extraDiagnostics.push({
      code: 'EWS_ACTIVE',
      severity: 'info',
      message: `Indonesian EWS warning is active: ${names.join(', ')} (level ${levels.join('/')}, ${locations} location code(s)).`,
      pid: ews.pid,
    });
  }
  if (ewbsServiceList.length > 0 && trailerPackets > 0) {
    if (startedEwbs.length > 0 && emergencyControlPackets === 0) {
      extraDiagnostics.push({
        code: 'EWBS_SIGNAL_MISMATCH',
        severity: 'warning',
        message: `Service ${startedEwbs[0]?.serviceId} signals EWBS start but no TMCC activation flag was seen.`,
      });
    } else if (startedEwbs.length === 0 && emergencyControlPackets > 0) {
      extraDiagnostics.push({
        code: 'EWBS_SIGNAL_MISMATCH',
        severity: 'warning',
        message: 'TMCC activation flag is set but no service signals EWBS start.',
      });
    }
  }

  if (detection.detected !== 'ATSC') {
    for (const service of base.services) {
      if (
        service.epg !== undefined &&
        service.epg.days < 8 &&
        service.epg.tableIds !== undefined &&
        service.epg.tableIds.some((tableId) => tableId >= 0x50)
      ) {
        extraDiagnostics.push({
          code: 'EPG_COVERAGE_SHORT',
          severity: 'info',
          message: `Service ${service.serviceId ?? service.programNumber} EPG covers ${service.epg.days} day(s), below the 8-day schedule window.`,
        });
      }
    }
  }

  if (extraDiagnostics.length > 0) {
    diagnostics.push(...extraDiagnostics);
    const okIndex = diagnostics.findIndex((diagnostic) => diagnostic.code === 'PROBE_OK');
    if (okIndex >= 0) diagnostics.splice(okIndex, 1);
  }
}
