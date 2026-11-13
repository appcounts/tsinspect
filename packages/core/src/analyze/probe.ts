import { DataBroadcastAccumulator } from '../data/databroadcast.js';
import { resolveAribProfile } from '../descriptors/arib-profile.js';
import {
  parseEmergencyInformationDescriptor,
  type TextEncoding,
} from '../descriptors/descriptor.js';
import type {
  DescriptorInfo,
  Diagnostic,
  EventSource,
  ProbeClock,
  ProbeEasAlert,
  ProbeEvent,
  ProbeEwbsService,
  ProbeFieldValue,
  ProbeRatingRegion,
  ProbeResult,
  ProbeTable,
  SourceKind,
  Standard,
} from '../model/types.js';
import { parsePesHeader } from '../pes/assembler.js';
import { SectionAssembler } from '../section/assembler.js';
import { parseCat } from '../tables/cat.js';
import { tableName } from '../tables/common.js';
import {
  parseAit,
  parseBat,
  parseDit,
  parseIntTable,
  parseRst,
  parseSit,
  parseSsu,
} from '../tables/dvb-extra.js';
import { parseEit } from '../tables/eit.js';
import { EWS_TABLE_ID, type EwsSection, ewsTableName, parseEwsSection } from '../tables/ews.js';
import { parseBit, parseCdt, parseLdt, parseNbit, parseSdtt } from '../tables/isdb.js';
import { type NitSection, type NitTransportStream, parseNit } from '../tables/nit.js';
import { parsePat } from '../tables/pat.js';
import { type PmtSection, parsePmt } from '../tables/pmt.js';
import {
  type AtscChannel,
  type AtscStt,
  parseAtscEit,
  parseAtscEtt,
  parseAtscMgt,
  parseAtscRrt,
  parseAtscStt,
  parseAtscVct,
} from '../tables/psip.js';
import { parseScte18Eas } from '../tables/scte18.js';
import { parseSdt, type SdtService } from '../tables/sdt.js';
import { parseTimeTable } from '../tables/time-table.js';
import { parseIsdbTrailer } from '../ts/isdb-trailer.js';
import { streamTypeName } from '../ts/packet.js';
import { detectPacketLayout, scanPackets } from '../ts/reader.js';
import { hex16 } from '../util/bytes.js';
import {
  dedupeStreams,
  inspectSection,
  parseLocalOffset,
  summarizeEventDescriptors,
} from './derive.js';
import { finalizeProbe } from './finalize.js';
import {
  type EmergencySpan,
  type EwbsServiceSpan,
  type EwsRegionSpan,
  type MutablePidStat,
  PCR_WRAP,
  type PcrTrack,
  type TableTrack,
} from './internal.js';

export interface ProbeProgress {
  /** 1 for the first pass, 2 for the ISDB ARIB text re-parse. */
  pass: number;
  /** Packets scanned so far in this pass. */
  packets: number;
  totalPackets: number;
  /** Bytes covered by the scanned packets (equals totalBytes when done). */
  bytes: number;
  totalBytes: number;
}

export interface ProbeOptions {
  name: string;
  kind: SourceKind;
  size?: number;
  full?: boolean;
  toolVersion?: string;
  /** ARIB character-set profile; auto uses the signalled country, then packet size. */
  textProfile?: 'auto' | 'japan' | 'brazil';
  /** Called periodically while the packet loop runs. */
  onProgress?: (progress: ProbeProgress) => void;
  /**
   * Decompress DSM-CC modules signalled with the compressed_module_descriptor.
   * Node callers pass zlib; the browser build leaves carousels compressed.
   */
  inflate?: (data: Uint8Array) => Uint8Array;
}

const PSI_PIDS = new Set<number>([
  0x0000, // PAT
  0x0001, // CAT
  0x0002, // TSDT
  0x0010, // NIT/ST
  0x0011, // SDT/BAT
  0x0012, // EIT
  0x0013, // RST
  0x0014, // EIT
  0x001c, // INT / SSU
  0x001e, // AIT (common)
  0x001f, // SIT
  0x0023, // ISDB SDTT
  0x0024, // ISDB BIT (common)
  0x0025, // ISDB NBIT / LDT
  0x0028, // ISDB SDTT (partial reception)
  0x0029, // ISDB CDT
  0x1ffb, // ATSC PSIP
]);

export function probeBuffer(data: Uint8Array, options: ProbeOptions): ProbeResult {
  const result = probeBufferInternal(data, options, 'dvb', undefined, 1);
  if (result.standard.detected === 'ISDB') {
    // ISDB service names and EPG text use the ARIB STD-B24 code extension.
    // The standard is only known after the first pass, so re-parse the PSI/SI
    // text with the ARIB decoder once the transport is identified. The hint
    // also resolves table ids shared with ATSC (0xC7 LDT/MGT, 0xC8 CDT/TVCT).
    const profile = resolveAribProfile(result, options.textProfile ?? 'auto');
    const brazil = profile === 'brazil';
    return probeBufferInternal(data, options, brazil ? 'sbtvd' : 'arib', 'ISDB', 2);
  }
  return result;
}

function probeBufferInternal(
  data: Uint8Array,
  options: ProbeOptions,
  textEncoding: TextEncoding,
  standardHint?: Standard,
  pass = 1,
): ProbeResult {
  const toolVersion = options.toolVersion ?? '0.0.1';
  const diagnostics: Diagnostic[] = [];
  const base: ProbeResult = {
    schemaVersion: '1.0',
    tool: { name: 'tsinspect', version: toolVersion },
    source: {
      kind: options.kind,
      name: options.name,
      ...(options.size !== undefined ? { size: options.size } : {}),
      sampledBytes: data.length,
      full: options.full ?? (options.size !== undefined ? data.length >= options.size : false),
    },
    packet: { size: 0, format: 'ts', syncOffset: 0, firstPacketOffset: 0 },
    standard: { detected: 'unknown', confidence: 0, evidence: [] },
    transport: { packetCount: 0 },
    services: [],
    pids: [],
    tables: [],
    capabilities: {
      teletext: false,
      dvbSubtitles: false,
      atscCaptions: false,
      aribCaptions: false,
      vbi: false,
      scte35: false,
      scrambled: false,
      caSystems: [],
    },
    diagnostics,
    events: [],
  };

  const layout = detectPacketLayout(data);
  if (!layout) {
    diagnostics.push({
      code: 'TS_NO_SYNC',
      severity: 'error',
      message: 'No MPEG-TS sync pattern found in the sampled data.',
    });
    return base;
  }

  base.packet = {
    size: layout.packetSize,
    format: layout.format,
    syncOffset: layout.syncOffset,
    firstPacketOffset: layout.firstPacketOffset,
  };

  const totalPackets = Math.max(
    0,
    Math.floor((data.length - layout.firstPacketOffset) / layout.packetSize),
  );
  let lastProgressPackets = 0;
  const emitProgress = (): void => {
    if (!options.onProgress || packetCount === lastProgressPackets) return;
    lastProgressPackets = packetCount;
    options.onProgress({
      pass,
      packets: packetCount,
      totalPackets,
      bytes: Math.min(data.length, layout.firstPacketOffset + packetCount * layout.packetSize),
      totalBytes: data.length,
    });
  };

  const stats = new Map<number, MutablePidStat>();
  const assemblers = new Map<number, SectionAssembler>();
  const tables = new Map<string, ProbeTable>();
  const tableIds = new Set<number>();
  const pmtPids = new Set<number>();
  const patPrograms = new Map<number, number>();
  const pmtByProgram = new Map<number, PmtSection>();
  const sdtActualServiceById = new Map<number, SdtService>();
  const sdtActualServices = new Set<number>();
  const sdtOtherByTsid = new Map<number, Set<number>>();
  let sdtActualTsid: number | undefined;
  let sdtActualOnid: number | undefined;
  let nitActualTransports: NitTransportStream[] | undefined;
  const atscChannels = new Map<number, AtscChannel>();
  const atscTablePids = new Set<number>();
  const eventsByKey = new Map<string, ProbeEvent>();
  const ettTextBySource = new Map<string, string>();
  const ratingsByRegion = new Map<number, ProbeRatingRegion>();
  let atscStt: AtscStt | undefined;
  let clock: ProbeClock | undefined;
  const pcrTracks = new Map<number, PcrTrack>();
  const pcrPidCounts = new Map<number, number>();
  const crcDiagnostics = new Set<string>();
  const descriptorTags = new Set<number>();
  const capabilities = {
    teletext: false,
    dvbSubtitles: false,
    atscCaptions: false,
    aribCaptions: false,
    vbi: false,
    scte35: false,
  };
  const caSystems = new Set<number>();
  const noteDescriptor = (descriptor: {
    tag: number;
    fields?: Record<string, string | number | boolean>;
  }): void => {
    switch (descriptor.tag) {
      case 0x45: // VBI teletext descriptor
      case 0x46: // VBI data descriptor
        capabilities.vbi = true;
        break;
      case 0x56: // DVB teletext descriptor
        capabilities.teletext = true;
        break;
      case 0x59: // DVB subtitling descriptor
        capabilities.dvbSubtitles = true;
        break;
      case 0x86: // ATSC caption_service_descriptor
        capabilities.atscCaptions = true;
        break;
      case 0x09: // CA descriptor
      case 0xf6: {
        // ISDB access-control descriptor
        const systemId = descriptor.fields?.caSystemId;
        if (typeof systemId === 'number') caSystems.add(systemId);
        break;
      }
      case 0xfd: {
        // ISDB data_component_descriptor: 0x0008 caption, 0x0012 superimpose.
        const componentId = descriptor.fields?.dataComponentId;
        if (componentId === 0x0008 || componentId === 0x0012) {
          capabilities.aribCaptions = true;
        }
        break;
      }
      case 0xc6: {
        // ISDB partial_reception_descriptor.
        const start = descriptor.fields?.startServiceId;
        const end = descriptor.fields?.endServiceId;
        if (typeof start === 'number' && typeof end === 'number') {
          partialReception = { startServiceId: start, endServiceId: end };
        }
        break;
      }
      default:
        break;
    }
  };
  let patTsid: number | undefined;
  let networkId: number | undefined;
  let networkName: string | undefined;
  let networkPid: number | undefined;
  let syncLosses = 0;
  let firstSyncLoss: number | undefined;
  let packetCount = 0;
  let scrambledPackets = 0;
  let teiPackets = 0;
  let trailerPackets = 0;
  let iipPackets = 0;
  let iipPid: number | undefined;
  let emergencyControlPackets = 0;
  const isdbLayers = new Map<number, number>();
  const esTargetPids = new Set<number>();
  const esBuffers = new Map<number, Uint8Array>();
  const esLengths = new Map<number, number>();
  const ES_LIMIT = 4 * 1024 * 1024;
  const ES_TOTAL_LIMIT = 64 * 1024 * 1024;
  const MAX_TABLES = 8192;
  const MAX_EVENTS = 20_000;
  const MAX_ETT_TEXT = 20_000;
  let esBufferBytes = 0;
  let esLimitHit = false;
  let tableLimitDropped = 0;
  let eventLimitDropped = 0;
  let ettLimitDropped = 0;

  const tableTracks = new Map<string, TableTrack>();
  const sectionGaps = new Map<string, number>();
  const sectionMaxGap = new Map<string, number>();
  const caBySystem = new Map<number, { ecm: Set<number>; emm: Set<number> }>();
  let catVersionSeen: number | undefined;
  let catPidSeen: number | undefined;
  let ptsDtsErrors = 0;
  const t2miPids = new Set<number>();
  const t2miBuffers = new Map<number, Uint8Array>();
  const t2miLengths = new Map<number, number>();
  const T2MI_LIMIT = 1024 * 1024;
  const tmccIdentifiers = new Set<number>();
  let bufferResetPackets = 0;
  let frameHeadPackets = 0;
  let lastCountDownIndex: number | undefined;
  let partialReception: { startServiceId: number; endServiceId: number } | undefined;
  let ssuSignalled = false;
  const epgTableIds = new Map<number, Set<number>>();
  const easAlerts = new Map<string, ProbeEasAlert>();
  const easPids = new Set<number>();
  const ewbsServices = new Map<number, ProbeEwbsService>();
  const ewsPids = new Set<number>();
  const ewsSections = new Map<string, EwsSection>();
  // Emergency warnings are also tracked as intervals of stream time so the UI
  // can show which level/region applied during each period of the sample.
  let streamSec = 0;
  let pcrClockPid: number | undefined;
  let pcrClockAnchor: number | undefined;
  let pcrClockLast: number | undefined;
  let pcrClockWraps = 0;
  const ewsRegionSpans: EwsRegionSpan[] = [];
  const ewsRegionSpanByKey = new Map<string, EwsRegionSpan>();
  const ewbsServiceSpans: EwbsServiceSpan[] = [];
  const ewbsServiceSpanByKey = new Map<string, EwbsServiceSpan>();
  const ewbsFlagSpans: EmergencySpan[] = [];
  let ewbsFlagSpan: EmergencySpan | undefined;
  const dataPids = new Set<number>();
  const dataBroadcast = new DataBroadcastAccumulator(
    options.inflate ? { inflate: options.inflate } : {},
  );

  /**
   * Merge one emergency_information_descriptor (0xFC) into the EWBS state.
   * ARIB STD-B10 allows the descriptor in the PMT and in EIT events, so a
   * service is considered started as soon as any occurrence signals it and
   * its area codes are the union of every observation.
   */
  const recordEwbsDescriptor = (descriptor: DescriptorInfo): void => {
    if (descriptor.tag !== 0xfc) return;
    // Descriptor payloads are stored as space separated hex pairs.
    const hex = descriptor.raw.replace(/\s+/g, '');
    const bytes = new Uint8Array(Math.floor(hex.length / 2));
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    for (const event of parseEmergencyInformationDescriptor(bytes)) {
      if (event.started) {
        const areaKey = [...event.areaCodes].sort((a, b) => a - b).join(',');
        const spanKey = `${event.serviceId}:${event.signalLevel}:${areaKey}`;
        const span = ewbsServiceSpanByKey.get(spanKey);
        if (!span) {
          const created: EwbsServiceSpan = {
            serviceId: event.serviceId,
            signalLevel: event.signalLevel,
            areaCodes: [...event.areaCodes],
            startSec: streamSec,
            lastSeenSec: streamSec,
          };
          ewbsServiceSpans.push(created);
          ewbsServiceSpanByKey.set(spanKey, created);
        } else {
          span.lastSeenSec = streamSec;
        }
      }
      const existing = ewbsServices.get(event.serviceId);
      if (!existing) {
        ewbsServices.set(event.serviceId, {
          serviceId: event.serviceId,
          started: event.started,
          signalLevel: event.signalLevel,
          areaCodes: [...event.areaCodes],
          ...(event.started ? { firstSeenSec: streamSec, lastSeenSec: streamSec } : {}),
        });
        continue;
      }
      ewbsServices.set(event.serviceId, {
        serviceId: event.serviceId,
        started: existing.started || event.started,
        signalLevel: event.started && !existing.started ? event.signalLevel : existing.signalLevel,
        areaCodes: [...new Set([...existing.areaCodes, ...event.areaCodes])].sort((a, b) => a - b),
        ...(existing.firstSeenSec !== undefined
          ? { firstSeenSec: existing.firstSeenSec }
          : event.started
            ? { firstSeenSec: streamSec }
            : {}),
        ...(event.started
          ? { lastSeenSec: streamSec }
          : existing.lastSeenSec !== undefined
            ? { lastSeenSec: existing.lastSeenSec }
            : {}),
      });
    }
  };

  const getStat = (pid: number): MutablePidStat => {
    let stat = stats.get(pid);
    if (!stat) {
      stat = {
        packets: 0,
        payloadBytes: 0,
        pusi: 0,
        scrambled: 0,
        ccErrors: 0,
        duplicates: 0,
        tei: 0,
        pcrCount: 0,
      };
      stats.set(pid, stat);
    }
    return stat;
  };

  const setTableFields = (tableKey: string, fields: Record<string, ProbeFieldValue>): void => {
    const entry = tables.get(tableKey);
    if (entry) entry.fields = fields;
  };

  /** Cap child lists so a single large table cannot flood the summary. */
  const fieldItems = (items: unknown[]): ProbeFieldValue[] =>
    items.slice(0, 100) as unknown as ProbeFieldValue[];

  const descriptorItems = (descriptors: DescriptorInfo[]): ProbeFieldValue[] =>
    fieldItems(
      descriptors.map((descriptor) => ({ tag: descriptor.tagHex, name: descriptor.name })),
    );

  // stage: scan
  for (const packet of scanPackets(data, layout, {
    onSyncLoss: (offset) => {
      syncLosses += 1;
      if (firstSyncLoss === undefined) firstSyncLoss = offset;
    },
  })) {
    packetCount += 1;
    if (packetCount % 4096 === 0) emitProgress();
    const stat = getStat(packet.pid);
    if (stat.firstPacket === undefined) {
      stat.firstPacket = packet.index;
      stat.firstPacketOffset = packet.offset;
    }
    stat.packets += 1;
    if (packet.payload) stat.payloadBytes += packet.payload.length;
    if (packet.pusi) stat.pusi += 1;
    if (packet.scrambling !== 0) {
      stat.scrambled += 1;
      scrambledPackets += 1;
    }
    if (packet.transportError) {
      stat.tei += 1;
      teiPackets += 1;
    }

    if (layout.packetSize === 204 && packet.trailer) {
      const trailer = parseIsdbTrailer(packet.trailer);
      if (trailer) {
        trailerPackets += 1;
        isdbLayers.set(trailer.layerIndicator, (isdbLayers.get(trailer.layerIndicator) ?? 0) + 1);
        if (trailer.iip) {
          iipPackets += 1;
          if (iipPid === undefined) iipPid = packet.pid;
        }
        if (trailer.emergencyControlFlag) {
          emergencyControlPackets += 1;
          if (ewbsFlagSpan === undefined) {
            ewbsFlagSpan = { startSec: streamSec, lastSeenSec: streamSec };
          } else if (streamSec - ewbsFlagSpan.lastSeenSec > 2) {
            ewbsFlagSpans.push(ewbsFlagSpan);
            ewbsFlagSpan = { startSec: streamSec, lastSeenSec: streamSec };
          } else {
            ewbsFlagSpan.lastSeenSec = streamSec;
          }
        }
        tmccIdentifiers.add(trailer.tmccIdentifier);
        if (trailer.bufferResetControl) bufferResetPackets += 1;
        if (trailer.frameHead) frameHeadPackets += 1;
        lastCountDownIndex = trailer.countDownIndex;
      }
    }

    if (packet.hasPayload) {
      // stage: accumulate
      if (packet.adaptation?.discontinuity) {
        stat.lastCc = packet.continuityCounter;
      } else if (stat.lastCc !== undefined) {
        const expected = (stat.lastCc + 1) & 0x0f;
        if (packet.continuityCounter === stat.lastCc) {
          // A repeated continuity counter marks a duplicate packet. TR 101 290
          // tolerates one repetition but treats a third or later copy as an error.
          stat.duplicates += 1;
          stat.duplicateRun = (stat.duplicateRun ?? 0) + 1;
          if (stat.duplicateRun > 2) stat.ccErrors += 1;
        } else {
          if (packet.continuityCounter !== expected) stat.ccErrors += 1;
          stat.duplicateRun = 0;
        }
        stat.lastCc = packet.continuityCounter;
      } else {
        stat.lastCc = packet.continuityCounter;
      }
    }

    if (packet.adaptation?.pcr) {
      const pcr = packet.adaptation.pcr;
      stat.pcrCount += 1;
      pcrPidCounts.set(packet.pid, (pcrPidCounts.get(packet.pid) ?? 0) + 1);
      // Derive a single stream clock from the first PID that carries PCR. Any
      // PCR can be used for a timeline; the first one keeps the mapping stable.
      if (pcrClockPid === undefined) pcrClockPid = packet.pid;
      if (packet.pid === pcrClockPid) {
        if (
          pcrClockLast !== undefined &&
          pcr.ticks < pcrClockLast &&
          pcrClockLast - pcr.ticks > PCR_WRAP / 2
        ) {
          pcrClockWraps += 1;
        }
        pcrClockLast = pcr.ticks;
        if (pcrClockAnchor === undefined) pcrClockAnchor = pcr.ticks;
        const elapsed = (pcrClockWraps * PCR_WRAP + pcr.ticks - pcrClockAnchor) / 27_000_000;
        if (elapsed > streamSec) streamSec = elapsed;
      }
      const track = pcrTracks.get(packet.pid);
      if (!track) {
        pcrTracks.set(packet.pid, {
          first: pcr.ticks,
          last: pcr.ticks,
          count: 1,
          lastTicks: pcr.ticks,
        });
      } else {
        if (track.lastTicks !== undefined) {
          let gap = pcr.ticks - track.lastTicks;
          if (gap < 0) {
            if (gap > -PCR_WRAP / 2) {
              gap += PCR_WRAP;
            } else {
              track.backwardsJumps = (track.backwardsJumps ?? 0) + 1;
              gap = 0;
            }
          }
          if (gap > (track.maxGapTicks ?? 0)) track.maxGapTicks = gap;
        }
        track.last = pcr.ticks;
        track.lastTicks = pcr.ticks;
        track.count += 1;
      }
    }

    if (!packet.payload) continue;

    if (t2miPids.has(packet.pid)) {
      const length = t2miLengths.get(packet.pid) ?? 0;
      if (length < T2MI_LIMIT) {
        let buffer = t2miBuffers.get(packet.pid);
        if (!buffer) {
          buffer = new Uint8Array(T2MI_LIMIT);
          t2miBuffers.set(packet.pid, buffer);
        }
        const take = Math.min(packet.payload.length, T2MI_LIMIT - length);
        buffer.set(packet.payload.subarray(0, take), length);
        t2miLengths.set(packet.pid, length + take);
      }
    }

    if (packet.pusi && esTargetPids.has(packet.pid)) {
      const pes = parsePesHeader(packet.payload);
      if (pes?.pts !== undefined && pes.dts !== undefined && pes.dts > pes.pts) {
        ptsDtsErrors += 1;
      }
    }

    if (esTargetPids.has(packet.pid)) {
      let buffer = esBuffers.get(packet.pid);
      if (!buffer) {
        const remaining = ES_TOTAL_LIMIT - esBufferBytes;
        if (remaining < 1024) {
          esLimitHit = true;
        } else {
          buffer = new Uint8Array(Math.min(ES_LIMIT, remaining));
          esBufferBytes += buffer.length;
          esBuffers.set(packet.pid, buffer);
          esLengths.set(packet.pid, 0);
        }
      }
      if (buffer) {
        const length = esLengths.get(packet.pid) ?? 0;
        if (length < buffer.length) {
          const take = Math.min(packet.payload.length, buffer.length - length);
          buffer.set(packet.payload.subarray(0, take), length);
          esLengths.set(packet.pid, length + take);
        }
      }
    }

    // Scrambled payloads cannot be interpreted as sections.
    if (packet.scrambling !== 0) continue;

    if (
      !PSI_PIDS.has(packet.pid) &&
      !pmtPids.has(packet.pid) &&
      !atscTablePids.has(packet.pid) &&
      !dataPids.has(packet.pid) &&
      !ewsPids.has(packet.pid)
    ) {
      continue;
    }

    let assembler = assemblers.get(packet.pid);
    if (!assembler) {
      assembler = new SectionAssembler(packet.pid);
      assemblers.set(packet.pid, assembler);
    }

    for (const section of assembler.push(
      packet.payload,
      packet.pusi,
      packet.index,
      packet.offset,
    )) {
      const info = inspectSection(section.data);
      if (!info) continue;

      // A bad CRC means the section is corrupt, or a private payload whose
      // first bytes merely look like a PSI table id. Parsing those would
      // fabricate services, events and descriptors from random bytes, and
      // would also list them as tables that do not exist.
      if (info.crcValid === false) {
        const crcKey = `${packet.pid}:${info.tableId}:${info.tableIdExtension ?? 0}:${info.version ?? -1}`;
        if (!crcDiagnostics.has(crcKey)) {
          crcDiagnostics.add(crcKey);
          diagnostics.push({
            code: 'PSI_CRC_MISMATCH',
            severity: 'warning',
            message: `${tableName(info.tableId)} on PID ${hex16(packet.pid)} has an invalid CRC.`,
            pid: packet.pid,
            packet: section.packetIndex,
            tableId: info.tableId,
          });
        }
        continue;
      }

      // Data-broadcast PIDs carry arbitrary private sections (MPE, DSM-CC)
      // whose table ids collide with ATSC/DVB PSIP ids. They are parsed for
      // the data-broadcast view but must not vote on the transport standard.
      // Short sections have no CRC and their first byte is arbitrary payload
      // data, so they cannot vote either.
      if (!dataPids.has(packet.pid) && info.mode === 'long') {
        tableIds.add(info.tableId);
      }
      const extension = info.tableIdExtension ?? 0;
      const groupKey = `${packet.pid}:${info.tableId}:${extension}`;
      let tableTrack = tableTracks.get(groupKey);
      if (!tableTrack) {
        tableTrack = {
          firstPacket: section.packetIndex,
          lastPacket: section.packetIndex,
          maxGap: 0,
          occurrences: 0,
          versions: new Set<number>(),
          sectionsByVersion: new Map(),
        };
        tableTracks.set(groupKey, tableTrack);
      } else if (tableTrack.occurrences > 0) {
        const gap = section.packetIndex - tableTrack.lastPacket;
        if (gap > tableTrack.maxGap) tableTrack.maxGap = gap;
        tableTrack.lastPacket = section.packetIndex;
      }
      tableTrack.occurrences += 1;
      if (info.version !== undefined) {
        tableTrack.versions.add(info.version);
        if (info.sectionNumber !== undefined && info.lastSectionNumber !== undefined) {
          let versionInfo = tableTrack.sectionsByVersion.get(info.version);
          if (!versionInfo) {
            versionInfo = { seen: new Set<number>(), last: info.lastSectionNumber };
            tableTrack.sectionsByVersion.set(info.version, versionInfo);
          }
          versionInfo.seen.add(info.sectionNumber);
          versionInfo.last = Math.max(versionInfo.last, info.lastSectionNumber);
        }
      }
      const key = `${packet.pid}:${info.tableId}:${extension}:${info.version ?? -1}:${
        info.sectionNumber ?? -1
      }:${info.lastSectionNumber ?? -1}`;
      const existing = tables.get(key);
      if (existing) {
        existing.occurrences += 1;
      } else if (tables.size >= MAX_TABLES) {
        tableLimitDropped += 1;
      } else {
        tables.set(key, {
          pid: packet.pid,
          pidHex: hex16(packet.pid),
          tableId: info.tableId,
          tableIdHex: `0x${info.tableId.toString(16).padStart(2, '0').toUpperCase()}`,
          ...(info.tableIdExtension !== undefined
            ? { tableIdExtension: info.tableIdExtension }
            : {}),
          name: tableName(info.tableId),
          mode: info.mode,
          length: info.length,
          occurrences: 1,
          firstPacket: section.packetIndex,
          firstPacketOffset: section.packetOffset,
          ...(info.version !== undefined ? { version: info.version } : {}),
          ...(info.currentNext !== undefined ? { currentNext: info.currentNext } : {}),
          ...(info.sectionNumber !== undefined ? { sectionNumber: info.sectionNumber } : {}),
          ...(info.lastSectionNumber !== undefined
            ? { lastSectionNumber: info.lastSectionNumber }
            : {}),
          ...(info.crcValid !== undefined ? { crcValid: info.crcValid } : {}),
        });
      }

      const tableEntry = tables.get(key);
      if (tableEntry) {
        tableEntry.lastPacket = section.packetIndex;
        const previous = sectionGaps.get(key);
        if (previous !== undefined) {
          const gap = section.packetIndex - previous;
          if (gap > (sectionMaxGap.get(key) ?? 0)) sectionMaxGap.set(key, gap);
        } else {
          sectionMaxGap.set(key, 0);
        }
        sectionGaps.set(key, section.packetIndex);
      }

      // Indonesian EWS private tables (TRDW/TCDW/TMDW) are carried on a
      // user-private stream; parse them before the generic dispatcher.
      if (ewsPids.has(packet.pid)) {
        if (info.tableId === EWS_TABLE_ID && info.mode === 'long') {
          const parsed = parseEwsSection(section.data);
          if (parsed) {
            ewsSections.set(
              `${packet.pid}:${parsed.tableIdExtension}:${parsed.version}:${parsed.sectionNumber}`,
              parsed,
            );
            for (const region of parsed.regions) {
              const areaKey = region.locations.map((location) => location.code).join(',');
              const spanKey = `${packet.pid}:${region.disasterCode}:${region.locationTypeCode}:${region.packageId}:${areaKey}`;
              const span = ewsRegionSpanByKey.get(spanKey);
              if (span === undefined) {
                const created: EwsRegionSpan = {
                  pid: packet.pid,
                  disasterCode: region.disasterCode,
                  locationTypeCode: region.locationTypeCode,
                  packageId: region.packageId,
                  locations: region.locations,
                  startSec: streamSec,
                  lastSeenSec: streamSec,
                };
                ewsRegionSpans.push(created);
                ewsRegionSpanByKey.set(spanKey, created);
              } else if (streamSec - span.lastSeenSec > 3) {
                // The region disappeared for a while and is back: close the old
                // interval and start a new one.
                const created: EwsRegionSpan = {
                  pid: packet.pid,
                  disasterCode: region.disasterCode,
                  locationTypeCode: region.locationTypeCode,
                  packageId: region.packageId,
                  locations: region.locations,
                  startSec: streamSec,
                  lastSeenSec: streamSec,
                };
                ewsRegionSpans.push(created);
                ewsRegionSpanByKey.set(spanKey, created);
              } else {
                span.lastSeenSec = streamSec;
              }
            }
            if (tableEntry) tableEntry.name = ewsTableName(parsed.tableIdExtension);
          }
        }
        continue;
      }

      // Private data PIDs carry arbitrary section formats whose table ids
      // collide with PSI/SI and PSIP ids. Only the AIT is decoded semantically
      // there (it is the MHP/HbbTV signalling carrier); everything else is
      // handled by the data-broadcast accumulator.
      const dataPid = dataPids.has(packet.pid);
      if (dataPid && info.tableId !== 0x74) {
        const summary = dataBroadcast.pushSection(packet.pid, section.data);
        if (summary) setTableFields(key, summary.fields);
        continue;
      }

      if (packet.pid === 0x0000 && info.tableId === 0x00) {
        const pat = parsePat(section.data);
        if (pat) {
          if (patTsid === undefined) patTsid = pat.transportStreamId;
          if (pat.networkPid !== undefined) networkPid = pat.networkPid;
          for (const program of pat.programs) {
            patPrograms.set(program.programNumber, program.pid);
            pmtPids.add(program.pid);
          }
          setTableFields(key, {
            transportStreamId: pat.transportStreamId,
            programs: fieldItems(
              pat.programs.map((program) => ({
                programNumber: program.programNumber,
                pmtPid: hex16(program.pid),
              })),
            ),
          });
        }
      } else if (packet.pid === 0x0001 && info.tableId === 0x01) {
        const cat = parseCat(section.data, textEncoding);
        if (cat) {
          catPidSeen = packet.pid;
          catVersionSeen = cat.version;
          for (const descriptor of cat.descriptors) {
            descriptorTags.add(descriptor.tag);
            noteDescriptor(descriptor);
            if (descriptor.tag === 0x09) {
              const systemId = descriptor.fields?.caSystemId;
              const emmPid = descriptor.fields?.caPid;
              if (typeof systemId === 'number') {
                const entry = caBySystem.get(systemId) ?? {
                  ecm: new Set<number>(),
                  emm: new Set<number>(),
                };
                if (typeof emmPid === 'number') entry.emm.add(emmPid);
                caBySystem.set(systemId, entry);
              }
            } else if (descriptor.tag === 0x65) {
              const list = descriptor.fields?.caSystemIds;
              if (typeof list === 'string') {
                for (const part of list.split(',')) {
                  const systemId = Number(part.trim());
                  if (Number.isFinite(systemId)) {
                    if (!caBySystem.has(systemId)) {
                      caBySystem.set(systemId, { ecm: new Set<number>(), emm: new Set<number>() });
                    }
                  }
                }
              }
            }
          }
          setTableFields(key, {
            version: cat.version,
            descriptors: descriptorItems(cat.descriptors),
          });
        }
      } else if (pmtPids.has(packet.pid) && info.tableId === 0x02) {
        const pmt = parsePmt(section.data, textEncoding);
        if (pmt) {
          const previous = pmtByProgram.get(pmt.programNumber);
          const merged =
            previous && previous.version === pmt.version
              ? {
                  ...pmt,
                  streams: dedupeStreams([...previous.streams, ...pmt.streams]),
                }
              : pmt;
          pmtByProgram.set(pmt.programNumber, merged);
          setTableFields(key, {
            programNumber: pmt.programNumber,
            pcrPid: hex16(pmt.pcrPid),
            streams: fieldItems(
              merged.streams.map((stream) => ({
                pid: hex16(stream.pid),
                type: `${streamTypeName(stream.streamType)} (0x${stream.streamType.toString(16).padStart(2, '0').toUpperCase()})`,
                ...(stream.descriptors.length > 0
                  ? { descriptors: descriptorItems(stream.descriptors) }
                  : {}),
              })),
            ),
            ...(merged.programDescriptors.length > 0
              ? { programDescriptors: descriptorItems(merged.programDescriptors) }
              : {}),
          });
          for (const descriptor of merged.programDescriptors) {
            descriptorTags.add(descriptor.tag);
            noteDescriptor(descriptor);
          }
          for (const stream of merged.streams) {
            const dataStream =
              stream.streamType === 0x05 ||
              stream.streamType === 0x06 ||
              stream.streamType === 0x0b ||
              stream.streamType === 0x0c ||
              stream.streamType === 0x0d;
            if (dataStream) dataPids.add(stream.pid);
            else esTargetPids.add(stream.pid);
            // Indonesian EWS is carried as private sections on a user-private
            // stream (stream_type 0x80), e.g. the dedicated "EWS" service.
            if (stream.streamType === 0x80) ewsPids.add(stream.pid);
            if (stream.streamType === 0x86) capabilities.scte35 = true;
            for (const descriptor of stream.descriptors) {
              descriptorTags.add(descriptor.tag);
              noteDescriptor(descriptor);
              if (descriptor.tag === 0x05) {
                const identifier = descriptor.fields?.formatIdentifier;
                if (identifier === 'T2MI' || identifier === 'T2-MI') t2miPids.add(stream.pid);
                // SCTE-35 is frequently signalled as stream_type 0x06 plus a
                // registration descriptor instead of the dedicated 0x86 type.
                if (identifier === 'CUEI') capabilities.scte35 = true;
                if (
                  identifier === 'DATA' ||
                  identifier === 'HbbTV' ||
                  identifier === 'MHP' ||
                  identifier === 'MHEG'
                ) {
                  dataPids.add(stream.pid);
                }
              }
            }
          }
          const allDescriptors = [
            ...merged.programDescriptors,
            ...merged.streams.flatMap((stream) => stream.descriptors),
          ];
          for (const descriptor of allDescriptors) {
            if (descriptor.tag === 0x09 || descriptor.tag === 0xf6) {
              const systemId = descriptor.fields?.caSystemId;
              const ecmPid = descriptor.fields?.caPid ?? descriptor.fields?.ecmPid;
              if (typeof systemId === 'number') {
                const entry = caBySystem.get(systemId) ?? {
                  ecm: new Set<number>(),
                  emm: new Set<number>(),
                };
                if (typeof ecmPid === 'number') entry.ecm.add(ecmPid);
                caBySystem.set(systemId, entry);
              }
            } else if (descriptor.tag === 0x65) {
              const list = descriptor.fields?.caSystemIds;
              if (typeof list === 'string') {
                for (const part of list.split(',')) {
                  const systemId = Number(part.trim());
                  if (Number.isFinite(systemId) && !caBySystem.has(systemId)) {
                    caBySystem.set(systemId, { ecm: new Set<number>(), emm: new Set<number>() });
                  }
                }
              }
            } else if (descriptor.tag === 0x4a && descriptor.fields?.linkageType === 0x09) {
              ssuSignalled = true;
            } else if (descriptor.tag === 0xfc) {
              recordEwbsDescriptor(descriptor);
            }
          }
        }
      } else if (info.tableId === 0x42 || info.tableId === 0x46) {
        const sdt = parseSdt(section.data, textEncoding);
        if (sdt) {
          if (sdt.tableId === 0x42) {
            sdtActualTsid ??= sdt.transportStreamId;
            sdtActualOnid ??= sdt.originalNetworkId;
            for (const service of sdt.services) {
              sdtActualServices.add(service.serviceId);
              // Only the actual transport stream can be addressed by PAT
              // program numbers; SDT-other entries may reuse the same id.
              sdtActualServiceById.set(service.serviceId, service);
            }
          } else {
            let services = sdtOtherByTsid.get(sdt.transportStreamId);
            if (!services) {
              services = new Set<number>();
              sdtOtherByTsid.set(sdt.transportStreamId, services);
            }
            for (const service of sdt.services) services.add(service.serviceId);
          }
          setTableFields(key, {
            transportStreamId: sdt.transportStreamId,
            originalNetworkId: sdt.originalNetworkId,
            services: fieldItems(
              sdt.services.map((service) => ({
                serviceId: service.serviceId,
                ...(service.serviceName !== undefined ? { name: service.serviceName } : {}),
                ...(service.providerName !== undefined ? { provider: service.providerName } : {}),
                ...(service.serviceType !== undefined ? { type: service.serviceType } : {}),
                runningStatus: service.runningStatus,
                ...(service.freeCaMode ? { freeCaMode: true } : {}),
              })),
            ),
          });
        }
      } else if (info.tableId === 0x40 || info.tableId === 0x41) {
        const nit: NitSection | null = parseNit(section.data, textEncoding);
        if (nit) {
          if (nit.networkName !== undefined) networkName = nit.networkName;
          networkId = nit.networkId;
          if (nit.tableId === 0x40) nitActualTransports = nit.transports;
          setTableFields(key, {
            networkId: nit.networkId,
            ...(nit.networkName !== undefined ? { networkName: nit.networkName } : {}),
            transports: fieldItems(
              nit.transports.map((transport) => ({
                transportStreamId: transport.transportStreamId,
                originalNetworkId: transport.originalNetworkId,
              })),
            ),
            ...(nit.networkDescriptors.length > 0
              ? { networkDescriptors: descriptorItems(nit.networkDescriptors) }
              : {}),
          });
        }
      } else if (info.tableId === 0x4a) {
        const bat = parseBat(section.data, textEncoding);
        if (bat) {
          for (const descriptor of bat.bouquetDescriptors) {
            // BAT is DVB-only, so its bouquet descriptor tags use the DVB
            // private namespace. Tags such as 0x81 are not ATSC AC-3 here.
            noteDescriptor(descriptor);
          }
          const entry = tables.get(key);
          if (entry) {
            entry.fields = {
              bouquetId: bat.bouquetId,
              ...(bat.bouquetName !== undefined ? { bouquetName: bat.bouquetName } : {}),
              transports: fieldItems(
                bat.transports.map((transport) => ({
                  transportStreamId: transport.transportStreamId,
                  originalNetworkId: transport.originalNetworkId,
                })),
              ),
            };
          }
        }
      } else if (info.tableId === 0x71) {
        const rst = parseRst(section.data);
        if (rst) {
          const entry = tables.get(key);
          if (entry) {
            entry.fields = {
              running: rst.entries.filter((item) => item.runningStatus === 4).length,
              entries: fieldItems(
                rst.entries.map((item) => ({
                  serviceId: item.serviceId,
                  eventId: item.eventId,
                  runningStatus: item.runningStatusName ?? item.runningStatus,
                })),
              ),
            };
          }
        }
      } else if (info.tableId === 0x74) {
        const ait = parseAit(section.data, textEncoding);
        if (ait) {
          dataBroadcast.addAit(packet.pid, ait);
          for (const descriptor of ait.commonDescriptors) {
            // AIT descriptor tags overlap with ATSC/DVB tags; they only count
            // as standard evidence when the table sits on a PSI PID.
            if (!dataPid) descriptorTags.add(descriptor.tag);
            noteDescriptor(descriptor);
          }
          for (const application of ait.applications) {
            for (const descriptor of application.descriptors) {
              if (!dataPid) descriptorTags.add(descriptor.tag);
              noteDescriptor(descriptor);
            }
          }
          const entry = tables.get(key);
          if (entry) {
            entry.fields = {
              applicationType: ait.applicationType,
              applications: fieldItems(
                ait.applications.map((application) => ({
                  organizationId: application.organizationId,
                  applicationId: application.applicationId,
                  controlCode: application.controlCode,
                })),
              ),
            };
          }
        }
      } else if (info.tableId === 0x72) {
        const entry = tables.get(key);
        if (entry) entry.fields = { stuffing: true };
      } else if (info.tableId === 0x7f) {
        const sit = parseSit(section.data, textEncoding);
        if (sit) {
          setTableFields(key, {
            services: fieldItems(
              sit.services.map((service) => ({
                serviceId: service.serviceId,
                runningStatus: service.runningStatusName ?? service.runningStatus,
              })),
            ),
          });
        }
      } else if (info.tableId === 0x7e) {
        const dit = parseDit(section.data);
        if (dit) {
          setTableFields(key, { bytes: dit.bytes });
        }
      } else if (packet.pid === 0x001c && info.tableId === 0xa0) {
        const ssu = parseSsu(section.data, textEncoding);
        if (ssu) {
          ssuSignalled = true;
          for (const descriptor of ssu.descriptors) {
            descriptorTags.add(descriptor.tag);
            noteDescriptor(descriptor);
          }
          setTableFields(key, {
            groupId: ssu.groupId,
            payloadBytes: ssu.payloadBytes,
            descriptors: descriptorItems(ssu.descriptors),
          });
        }
      } else if (packet.pid === 0x001c && info.tableId === 0x4c) {
        const int = parseIntTable(section.data, textEncoding);
        if (int) {
          for (const descriptor of int.platformDescriptors) {
            descriptorTags.add(descriptor.tag);
            noteDescriptor(descriptor);
          }
          setTableFields(key, {
            actionType: int.actionType,
            platformId: int.platformId,
            processingOrder: int.processingOrder,
            devices: fieldItems(
              int.devices.map((device) => ({
                deviceId: device.deviceId,
                ...(device.descriptors.length > 0
                  ? { descriptors: descriptorItems(device.descriptors) }
                  : {}),
              })),
            ),
          });
        }
      } else if (info.tableId === 0x70 || info.tableId === 0x73) {
        const timeTable = parseTimeTable(section.data);
        let localOffsetSec = clock?.localOffsetSec;
        let localTimeOffset = clock?.localTimeOffset;
        let nextLocalTimeOffset = clock?.nextLocalTimeOffset;
        let timeOfChangeIso = clock?.timeOfChangeIso;
        let countryCode = clock?.countryCode;
        for (const descriptor of timeTable?.localTimeOffsetDescriptors ?? []) {
          if (descriptor.tag !== 0x58) continue;
          const offset = parseLocalOffset(descriptor.fields?.localTimeOffset);
          if (offset !== undefined) localOffsetSec = offset;
          if (typeof descriptor.fields?.localTimeOffset === 'string') {
            localTimeOffset = descriptor.fields.localTimeOffset;
          }
          if (typeof descriptor.fields?.nextTimeOffset === 'string') {
            nextLocalTimeOffset = descriptor.fields.nextTimeOffset;
          }
          if (typeof descriptor.fields?.timeOfChange === 'string') {
            timeOfChangeIso = descriptor.fields.timeOfChange;
          }
          if (typeof descriptor.fields?.countryCode === 'string') {
            countryCode = descriptor.fields.countryCode;
          }
        }
        if (timeTable?.utc) {
          const localIso =
            localOffsetSec !== undefined
              ? new Date((timeTable.utc.unixSeconds + localOffsetSec) * 1000).toISOString()
              : undefined;
          clock = {
            ...clock,
            utcIso: timeTable.utc.iso,
            utcFirstIso: clock?.utcFirstIso ?? timeTable.utc.iso,
            utcLastIso: timeTable.utc.iso,
            source: timeTable.name === 'TOT' ? 'TOT' : 'TDT',
            ...(localOffsetSec !== undefined
              ? {
                  localOffsetSec,
                  localFirstIso: clock?.localFirstIso ?? localIso,
                  localLastIso: localIso,
                }
              : {}),
            ...(localTimeOffset !== undefined ? { localTimeOffset } : {}),
            ...(nextLocalTimeOffset !== undefined ? { nextLocalTimeOffset } : {}),
            ...(timeOfChangeIso !== undefined ? { timeOfChangeIso } : {}),
            ...(countryCode !== undefined ? { countryCode } : {}),
            ...(timeTable.name === 'TOT' ? { totIso: timeTable.utc.iso } : {}),
          };
        }
        if (timeTable) {
          setTableFields(key, {
            source: timeTable.name,
            ...(timeTable.utc?.iso !== undefined ? { utc: timeTable.utc.iso } : {}),
            ...(localTimeOffset !== undefined ? { localTimeOffset } : {}),
            ...(nextLocalTimeOffset !== undefined ? { nextTimeOffset: nextLocalTimeOffset } : {}),
            ...(timeOfChangeIso !== undefined ? { timeOfChange: timeOfChangeIso } : {}),
            ...(countryCode !== undefined ? { countryCode } : {}),
          });
        }
      } else if (info.tableId >= 0x4e && info.tableId <= 0x6f) {
        const eit = parseEit(section.data, textEncoding);
        if (eit) {
          setTableFields(key, {
            serviceId: eit.serviceId,
            segmentLastSectionNumber: eit.segmentLastSectionNumber,
            lastTableId: eit.lastTableId,
            events: fieldItems(
              eit.events.map((event) => ({
                eventId: event.eventId,
                ...(event.name !== undefined ? { name: event.name } : {}),
                ...(event.startTimeIso !== undefined ? { start: event.startTimeIso } : {}),
                ...(event.durationSec !== undefined ? { durationSec: event.durationSec } : {}),
                ...(event.runningStatusName !== undefined
                  ? { runningStatus: event.runningStatusName }
                  : {}),
                ...(event.freeCaMode ? { freeCaMode: true } : {}),
              })),
            ),
          });
          let eitIds = epgTableIds.get(eit.serviceId);
          if (!eitIds) {
            eitIds = new Set<number>();
            epgTableIds.set(eit.serviceId, eitIds);
          }
          eitIds.add(info.tableId);
          for (const [eventIndex, event] of eit.events.entries()) {
            for (const descriptor of event.descriptors) {
              // Event-level EWBS/EWS signalling (ARIB STD-B10, 6.2.24).
              if (descriptor.tag === 0xfc) recordEwbsDescriptor(descriptor);
            }
            const key = `${eit.originalNetworkId}:${eit.transportStreamId}:${eit.serviceId}:${event.eventId}`;
            const existing = eventsByKey.get(key);
            if (existing === undefined && eventsByKey.size >= MAX_EVENTS) {
              eventLimitDropped += 1;
              continue;
            }
            const summary = summarizeEventDescriptors(event.descriptors);
            // A present/following section carries the authoritative running
            // status and is repeated more often than the schedule, so when the
            // same event also appears in a schedule section its fields win.
            // Schedule data still fills the fields p/f did not provide.
            const preferExisting =
              existing?.sources?.includes('present-following') === true && eit.kind === 'schedule';
            const pick = <T>(fresh: T | undefined, old: T | undefined): T | undefined =>
              preferExisting ? (old ?? fresh) : (fresh ?? old);
            const name = pick(event.name, existing?.name);
            const text = pick(event.text, existing?.text);
            const startTimeIso = pick(event.startTimeIso, existing?.startTimeIso);
            const durationSec = pick(event.durationSec, existing?.durationSec);
            const endTimeIso = pick(event.endTimeIso, existing?.endTimeIso);
            const content = pick(summary.content, existing?.content);
            const rating = pick(summary.rating, existing?.rating);
            const languages = pick(summary.languages, existing?.languages);
            const items = pick(summary.items, existing?.items);
            const seriesId = pick(summary.seriesId, existing?.seriesId);
            const seriesName = pick(summary.seriesName, existing?.seriesName);
            const linkage = pick(summary.linkage, existing?.linkage);
            const runningStatus =
              existing?.runningStatus !== undefined && (preferExisting || event.runningStatus === 0)
                ? existing.runningStatus
                : event.runningStatus;
            const runningStatusName = pick(event.runningStatusName, existing?.runningStatusName);
            // DVB assigns the present event to section_number 0 and the
            // following event to section_number 1. A few encoders put both
            // events in one section, so fall back to the event position within
            // the section. Schedule occurrences keep the p/f position.
            const presentFollowing =
              eit.kind === 'present-following'
                ? eit.sectionNumber === 0 && eventIndex === 0
                  ? 'present'
                  : 'following'
                : existing?.presentFollowing;
            const sources = [
              ...new Set<EventSource>([...(existing?.sources ?? []), eit.kind]),
            ].sort();
            eventsByKey.set(key, {
              serviceId: eit.serviceId,
              eventId: event.eventId,
              sources,
              ...(presentFollowing !== undefined ? { presentFollowing } : {}),
              ...(name !== undefined ? { name } : {}),
              ...(text !== undefined ? { text } : {}),
              ...(startTimeIso !== undefined ? { startTimeIso } : {}),
              ...(durationSec !== undefined ? { durationSec } : {}),
              ...(endTimeIso !== undefined ? { endTimeIso } : {}),
              runningStatus,
              ...(runningStatusName !== undefined ? { runningStatusName } : {}),
              ...(content !== undefined ? { content } : {}),
              ...(rating !== undefined ? { rating } : {}),
              ...(languages !== undefined ? { languages } : {}),
              ...(items !== undefined ? { items } : {}),
              ...(seriesId !== undefined ? { seriesId } : {}),
              ...(seriesName !== undefined ? { seriesName } : {}),
              ...(linkage !== undefined ? { linkage } : {}),
              descriptors: pick(event.descriptors, existing?.descriptors) ?? event.descriptors,
            });
          }
        }
      } else if (info.tableId === 0xc5 || info.tableId === 0xc6) {
        const nbit = parseNbit(section.data, textEncoding);
        if (nbit) {
          for (const descriptor of nbit.descriptors) {
            descriptorTags.add(descriptor.tag);
            noteDescriptor(descriptor);
          }
          for (const broadcaster of nbit.broadcasters) {
            for (const descriptor of broadcaster.descriptors) {
              descriptorTags.add(descriptor.tag);
              noteDescriptor(descriptor);
            }
          }
          setTableFields(key, {
            originalNetworkId: nbit.originalNetworkId,
            ...(nbit.networkName !== undefined ? { networkName: nbit.networkName } : {}),
            descriptors: nbit.descriptors.length,
            broadcasters: nbit.broadcasters.length,
          });
        }
      } else if (info.tableId === 0xc4) {
        const bit = parseBit(section.data, textEncoding);
        if (bit) {
          for (const descriptor of bit.descriptors) {
            descriptorTags.add(descriptor.tag);
            noteDescriptor(descriptor);
          }
          for (const broadcaster of bit.broadcasters) {
            for (const descriptor of broadcaster.descriptors) {
              descriptorTags.add(descriptor.tag);
              noteDescriptor(descriptor);
            }
          }
          setTableFields(key, {
            originalNetworkId: bit.originalNetworkId,
            broadcastViewPropriety: bit.broadcastViewPropriety,
            descriptors: bit.descriptors.length,
            broadcasters: bit.broadcasters.length,
          });
        }
      } else if (info.tableId === 0xc3) {
        const sdtt = parseSdtt(section.data);
        if (sdtt) {
          setTableFields(key, {
            transportStreamId: sdtt.transportStreamId,
            originalNetworkId: sdtt.originalNetworkId,
            serviceId: sdtt.serviceId,
            contents: sdtt.contentCount,
          });
        }
      } else if (info.tableId === 0xc7 && standardHint === 'ISDB') {
        const ldt = parseLdt(section.data, textEncoding);
        if (ldt) {
          for (const description of ldt.descriptions) {
            for (const descriptor of description.descriptors) {
              descriptorTags.add(descriptor.tag);
              noteDescriptor(descriptor);
            }
          }
          setTableFields(key, {
            originalServiceId: ldt.originalServiceId,
            transportStreamId: ldt.transportStreamId,
            originalNetworkId: ldt.originalNetworkId,
            descriptions: ldt.descriptions.length,
          });
        }
      } else if (info.tableId === 0xc8 && standardHint === 'ISDB') {
        const cdt = parseCdt(section.data);
        if (cdt) {
          setTableFields(key, {
            originalNetworkId: cdt.originalNetworkId,
            dataType: cdt.dataType,
            moduleBytes: cdt.dataModuleLength,
          });
        }
      } else if (info.tableId === 0xca && standardHint !== 'ISDB') {
        const rrt = parseAtscRrt(section.data);
        if (rrt) {
          ratingsByRegion.set(rrt.ratingRegion, rrt);
          setTableFields(key, {
            ratingRegion: rrt.ratingRegion,
            ...(rrt.name ? { regionName: rrt.name } : {}),
            dimensions: rrt.dimensions.length,
            ...(rrt.dimensions.length > 0
              ? {
                  dimensionNames: rrt.dimensions.map((dimension) => dimension.name).join(', '),
                }
              : {}),
          });
        }
      } else if (info.tableId === 0xcd) {
        const stt = parseAtscStt(section.data);
        if (stt) {
          atscStt = stt;
          clock = {
            ...clock,
            utcIso: stt.utcIso,
            utcFirstIso: clock?.utcFirstIso ?? stt.utcIso,
            utcLastIso: stt.utcIso,
            source: 'STT',
            gpsUtcOffset: stt.gpsUtcOffset,
          };
          setTableFields(key, { utc: stt.utcIso, gpsUtcOffset: stt.gpsUtcOffset });
        }
      } else if (info.tableId === 0xd8) {
        // SCTE 18 shares PID 0x1FFB with ATSC PSIP; the CRC guard above keeps
        // private data that happens to start with 0xD8 out of the alert list.
        const eas = parseScte18Eas(section.data, atscStt?.gpsUtcOffset ?? 0);
        if (eas) {
          easPids.add(packet.pid);
          const alertKey = `${packet.pid}:${eas.eventId}:${eas.eventCode}:${eas.priority}`;
          const existing = easAlerts.get(alertKey);
          // A long alert can span several sections; locations and descriptors
          // are additive, everything else is refreshed by the newest section.
          const locationKeys = new Set(
            (existing?.locations ?? []).map(
              (location) =>
                `${location.stateCode}:${location.countySubdivision}:${location.countyCode}`,
            ),
          );
          const locations = [...(existing?.locations ?? [])];
          for (const location of eas.locations) {
            const locationKey = `${location.stateCode}:${location.countySubdivision}:${location.countyCode}`;
            if (locationKeys.has(locationKey)) continue;
            locationKeys.add(locationKey);
            locations.push(location);
          }
          const descriptorKeys = new Set(
            (existing?.descriptors ?? []).map(
              (descriptor) => `${descriptor.tag}:${descriptor.raw}`,
            ),
          );
          const descriptors = [...(existing?.descriptors ?? [])];
          for (const descriptor of eas.descriptors) {
            const descriptorKey = `${descriptor.tag}:${descriptor.raw}`;
            if (descriptorKeys.has(descriptorKey)) continue;
            descriptorKeys.add(descriptorKey);
            descriptors.push(descriptor);
          }
          easAlerts.set(alertKey, {
            pid: packet.pid,
            sequenceNumber: eas.sequenceNumber,
            eventId: eas.eventId,
            originatorCode: eas.originatorCode,
            eventCode: eas.eventCode,
            priority: eas.priority,
            timeRemainingSec: eas.timeRemainingSec,
            ...(eas.startTimeIso ? { startTimeIso: eas.startTimeIso } : {}),
            durationSec: eas.durationSec,
            ...((existing?.natureOfActivation ?? eas.natureOfActivation)
              ? { natureOfActivation: existing?.natureOfActivation ?? eas.natureOfActivation }
              : {}),
            ...((existing?.alertText ?? eas.alertText)
              ? { alertText: existing?.alertText ?? eas.alertText }
              : {}),
            locations,
            exceptionCount: Math.max(existing?.exceptionCount ?? 0, eas.exceptions.length),
            descriptors,
            occurrences: (existing?.occurrences ?? 0) + 1,
            firstSeenSec: existing?.firstSeenSec ?? streamSec,
            lastSeenSec: streamSec,
          });
          setTableFields(key, {
            eventId: eas.eventId,
            eventCode: eas.eventCode,
            originatorCode: eas.originatorCode,
            priority: eas.priority,
            timeRemaining: eas.timeRemainingSec,
          });
        }
      } else if (info.tableId === 0xc7) {
        const mgt = parseAtscMgt(section.data);
        if (mgt) {
          setTableFields(key, {
            tableTypes: fieldItems(
              mgt.tables.map((table) => ({
                type: table.tableTypeHex,
                name: table.name,
                pid: hex16(table.pid),
              })),
            ),
          });
          // The MGT lists every PSIP table PID. Table types seen in the wild
          // do not always match the table_id carried on the PID (some
          // broadcasters announce EIT/ETT under private type codes), so listen
          // on every announced PID and dispatch on the section's table_id.
          for (const table of mgt.tables) {
            if (table.pid !== 0x1ffb && table.pid !== 0) atscTablePids.add(table.pid);
          }
        }
      } else if (info.tableId === 0xc8 || info.tableId === 0xc9) {
        const vct = parseAtscVct(section.data);
        if (vct) {
          for (const channel of vct.channels) atscChannels.set(channel.programNumber, channel);
          setTableFields(key, {
            channels: fieldItems(
              vct.channels.map((channel) => ({
                channel: `${channel.majorChannelNumber}-${channel.minorChannelNumber}`,
                ...(channel.shortName !== undefined ? { name: channel.shortName } : {}),
                programNumber: channel.programNumber,
              })),
            ),
          });
        }
      } else if (info.tableId === 0xcb) {
        const eit = parseAtscEit(section.data, atscStt?.gpsUtcOffset ?? 0);
        if (eit) {
          setTableFields(key, {
            sourceId: eit.sourceId,
            events: fieldItems(
              eit.events.map((event) => ({
                eventId: event.eventId,
                ...(event.title !== undefined ? { name: event.title } : {}),
                start: event.startTimeIso,
                durationSec: event.durationSec,
              })),
            ),
          });
          for (const event of eit.events) {
            const key = `${eit.sourceId}:${event.eventId}`;
            if (!eventsByKey.has(key) && eventsByKey.size >= MAX_EVENTS) {
              eventLimitDropped += 1;
              continue;
            }
            const text = ettTextBySource.get(key);
            eventsByKey.set(key, {
              serviceId: eit.sourceId,
              eventId: event.eventId,
              sources: ['schedule'],
              ...(event.title ? { name: event.title } : {}),
              ...(text ? { text } : {}),
              startTimeIso: event.startTimeIso,
              durationSec: event.durationSec,
              ...(event.endTimeIso ? { endTimeIso: event.endTimeIso } : {}),
              descriptors: event.descriptors,
            });
          }
        }
      } else if (info.tableId === 0xcc) {
        const ett = parseAtscEtt(section.data);
        if (ett?.kind === 'event' && ett.eventId !== undefined) {
          setTableFields(key, { sourceId: ett.sourceId, kind: ett.kind });
          const key2 = `${ett.sourceId}:${ett.eventId}`;
          if (!ettTextBySource.has(key2) && ettTextBySource.size >= MAX_ETT_TEXT) {
            ettLimitDropped += 1;
          } else {
            ettTextBySource.set(key2, ett.text);
          }
          const existing = eventsByKey.get(key2);
          if (existing) {
            eventsByKey.set(key2, {
              ...existing,
              ...(ett.text ? { text: ett.text } : {}),
            });
          }
        }
      } else if (dataPids.has(packet.pid)) {
        const summary = dataBroadcast.pushSection(packet.pid, section.data);
        if (summary) setTableFields(key, summary.fields);
      }
    }
  }

  if (totalPackets > 0) emitProgress();

  // stage: extract
  base.transport.packetCount = packetCount;
  base.transport.tsid = patTsid;
  base.transport.tsidHex = patTsid !== undefined ? hex16(patTsid) : undefined;
  base.transport.networkId = networkId;
  base.transport.networkName = networkName;
  base.transport.networkPid = networkPid;

  // stage: diagnose - post-scan diagnostics and summary.
  if (ewbsFlagSpan !== undefined) ewbsFlagSpans.push(ewbsFlagSpan);
  finalizeProbe({
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
    esTotalLimit: ES_TOTAL_LIMIT,
    maxTables: MAX_TABLES,
    maxEvents: MAX_EVENTS,
    maxEttText: MAX_ETT_TEXT,
    sampleBytes: data.length,
    expectedSize: options.size,
    packetSize: layout.packetSize,
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
    ewsPids,
    ewsSections,
    ewsRegionSpans,
    ewbsServiceSpans,
    ewbsFlagSpans,
    streamEndSec: streamSec,
    dataBroadcast,
    epgTableIds,
    tableIds,
    descriptorTags,
    esTargetPids,
    dataPids,
    atscTablePids,
    networkPid,
    ptsDtsErrors,
  });
  // Sections carried on a dedicated PID identify it better than the generic
  // "unknown" fallback, e.g. ATSC EIT/ETT PIDs beyond the classic PSI range.
  const namesByPid = new Map<number, Set<string>>();
  for (const table of base.tables) {
    if (!table.name) continue;
    let names = namesByPid.get(table.pid);
    if (!names) {
      names = new Set<string>();
      namesByPid.set(table.pid, names);
    }
    names.add(table.name);
  }
  for (const pid of base.pids) {
    if (pid.kind) continue;
    const names = namesByPid.get(pid.pid);
    if (names && names.size > 0) pid.kind = [...names].join(' / ');
  }

  return base;
}
