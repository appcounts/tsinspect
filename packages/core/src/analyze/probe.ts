import type {
  DescriptorInfo,
  Diagnostic,
  EventSource,
  ProbeCaSystem,
  ProbeClock,
  ProbeCapabilities,
  ProbeEasAlert,
  ProbeEmergency,
  ProbeEvent,
  ProbeEwbsService,
  ProbeFieldValue,
  ProbePid,
  ProbeRatingRegion,
  ProbeResult,
  ProbeService,
  ProbeStream,
  ProbeTable,
  SourceKind,
  Standard,
} from '../model/types.js';
import { isSectionCrcValid } from '../section/crc32.js';
import { SectionAssembler } from '../section/assembler.js';
import { parseNit, type NitSection, type NitTransportStream } from '../tables/nit.js';
import { parsePat } from '../tables/pat.js';
import { parsePmt, type PmtSection } from '../tables/pmt.js';
import { parseSdt, type SdtService } from '../tables/sdt.js';
import { parseEit } from '../tables/eit.js';
import { parseAit, parseBat, parseDit, parseIntTable, parseRst, parseSit, parseSsu } from '../tables/dvb-extra.js';
import { parseBit, parseCdt, parseLdt, parseNbit, parseSdtt } from '../tables/isdb.js';
import { parseCat } from '../tables/cat.js';
import { parseScte18Eas } from '../tables/scte18.js';
import { DataBroadcastAccumulator } from '../data/databroadcast.js';
import { parseEsMetadata } from '../es/index.js';
import { parsePesHeader } from '../pes/assembler.js';
import type { EsMetadata } from '../model/types.js';
import { parseTimeTable } from '../tables/time-table.js';
import {
  parseAtscEit,
  parseAtscEtt,
  parseAtscMgt,
  parseAtscRrt,
  parseAtscStt,
  parseAtscVct,
  type AtscChannel,
  type AtscMgt,
  type AtscStt,
} from '../tables/psip.js';
import { tableName } from '../tables/common.js';
import {
  parseEmergencyInformationDescriptor,
  type TextEncoding,
} from '../descriptors/descriptor.js';
import { detectPacketLayout, scanPackets } from '../ts/reader.js';
import { parseIsdbTrailer } from '../ts/isdb-trailer.js';
import { parseT2miBuffer } from '../ts/t2mi.js';
import { pidKind, streamTypeName } from '../ts/packet.js';
import { hex16, readU16 } from '../util/bytes.js';

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
  /** ARIB character-set profile; auto selects SBTVD for 204-byte ISDB-Tb. */
  textProfile?: 'auto' | 'japan' | 'brazil';
  /** Called periodically while the packet loop runs. */
  onProgress?: (progress: ProbeProgress) => void;
}

interface MutablePidStat {
  packets: number;
  payloadBytes: number;
  pusi: number;
  scrambled: number;
  ccErrors: number;
  duplicates: number;
  tei: number;
  pcrCount: number;
  lastCc?: number;
  /** Consecutive packets repeating the same continuity counter. */
  duplicateRun?: number;
  firstPacket?: number;
  firstPacketOffset?: number;
}

interface PcrTrack {
  first: number;
  last: number;
  count: number;
  lastTicks?: number;
  maxGapTicks?: number;
  backwardsJumps?: number;
}

interface SectionInfo {
  tableId: number;
  tableIdExtension?: number;
  version?: number;
  currentNext?: boolean;
  sectionNumber?: number;
  lastSectionNumber?: number;
  crcValid?: boolean;
  mode: 'long' | 'short';
  length: number;
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

const ATSC_TABLE_IDS = new Set([0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd]);
const ISDB_TABLE_IDS = new Set([0xc3, 0xc4, 0xc5, 0xc6]);
const ATSC_DESCRIPTOR_TAGS = new Set([0x81, 0x86, 0x87, 0xa0, 0xa1, 0xa2, 0xa3]);
const ISDB_DESCRIPTOR_TAGS = new Set([0xc1, 0xc8, 0xc9, 0xca, 0xcb, 0xf6, 0xfd]);
const DVB_DESCRIPTOR_TAGS = new Set([
  0x40, 0x41, 0x47, 0x48, 0x4d, 0x4e, 0x50, 0x54, 0x55, 0x56, 0x58, 0x59, 0x5a, 0x62, 0x6a,
  0x7a, 0x7c,
]);
const PCR_WRAP = 0x200000000 * 300;

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

export function probeBuffer(data: Uint8Array, options: ProbeOptions): ProbeResult {
  const result = probeBufferInternal(data, options, 'dvb', undefined, 1);
  if (result.standard.detected === 'ISDB') {
    // ISDB service names and EPG text use the ARIB STD-B24 code extension.
    // The standard is only known after the first pass, so re-parse the PSI/SI
    // text with the ARIB decoder once the transport is identified. The hint
    // also resolves table ids shared with ATSC (0xC7 LDT/MGT, 0xC8 CDT/TVCT).
    const profile = options.textProfile ?? 'auto';
    const brazil =
      profile === 'brazil' || (profile === 'auto' && result.packet.size === 204);
    return probeBufferInternal(
      data,
      options,
      brazil ? 'sbtvd' : 'arib',
      'ISDB',
      2,
    );
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
  let atscMgt: AtscMgt | undefined;
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

  interface TableTrack {
    firstPacket: number;
    lastPacket: number;
    maxGap: number;
    occurrences: number;
    versions: Set<number>;
    sectionsByVersion: Map<number, { seen: Set<number>; last: number }>;
  }
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
  const dataPids = new Set<number>();
  const dataBroadcast = new DataBroadcastAccumulator();

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
      const existing = ewbsServices.get(event.serviceId);
      if (!existing) {
        ewbsServices.set(event.serviceId, {
          serviceId: event.serviceId,
          started: event.started,
          signalLevel: event.signalLevel,
          areaCodes: [...event.areaCodes],
        });
        continue;
      }
      ewbsServices.set(event.serviceId, {
        serviceId: event.serviceId,
        started: existing.started || event.started,
        signalLevel:
          event.started && !existing.started ? event.signalLevel : existing.signalLevel,
        areaCodes: [...new Set([...existing.areaCodes, ...event.areaCodes])].sort(
          (a, b) => a - b,
        ),
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

  const setTableFields = (
    tableKey: string,
    fields: Record<string, ProbeFieldValue>,
  ): void => {
    const entry = tables.get(tableKey);
    if (entry) entry.fields = fields;
  };

  /** Cap child lists so a single large table cannot flood the summary. */
  const fieldItems = (items: unknown[]): ProbeFieldValue[] =>
    items.slice(0, 100) as unknown as ProbeFieldValue[];

  const descriptorItems = (descriptors: DescriptorInfo[]): ProbeFieldValue[] =>
    fieldItems(descriptors.map((descriptor) => ({ tag: descriptor.tagHex, name: descriptor.name })));

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
        isdbLayers.set(
          trailer.layerIndicator,
          (isdbLayers.get(trailer.layerIndicator) ?? 0) + 1,
        );
        if (trailer.iip) {
          iipPackets += 1;
          if (iipPid === undefined) iipPid = packet.pid;
        }
        if (trailer.emergencyControlFlag) emergencyControlPackets += 1;
        tmccIdentifiers.add(trailer.tmccIdentifier);
        if (trailer.bufferResetControl) bufferResetPackets += 1;
        if (trailer.frameHead) frameHeadPackets += 1;
        lastCountDownIndex = trailer.countDownIndex;
      }
    }

    if (packet.hasPayload) {
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
      !dataPids.has(packet.pid)
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

      // Data-broadcast PIDs carry arbitrary private sections (MPE, DSM-CC)
      // whose table ids collide with ATSC/DVB PSIP ids. They are parsed for
      // the data-broadcast view but must not vote on the transport standard.
      if (!dataPids.has(packet.pid)) tableIds.add(info.tableId);
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

      if (info.crcValid === false) {
        const crcKey = `${packet.pid}:${info.tableId}:${extension}:${info.version ?? -1}`;
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
            descriptorTags.add(descriptor.tag);
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
            ...(nextLocalTimeOffset !== undefined
              ? { nextTimeOffset: nextLocalTimeOffset }
              : {}),
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
              existing?.sources?.includes('present-following') === true &&
              eit.kind === 'schedule';
            const pick = <T>(fresh: T | undefined, old: T | undefined): T | undefined =>
              preferExisting ? old ?? fresh : fresh ?? old;
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
              existing?.runningStatus !== undefined &&
              (preferExisting || event.runningStatus === 0)
                ? existing.runningStatus
                : event.runningStatus;
            const runningStatusName = pick(
              event.runningStatusName,
              existing?.runningStatusName,
            );
            // Index 0 of a p/f section is the present event, the rest is the
            // following one. Schedule occurrences keep the existing position.
            const presentFollowing =
              eit.kind === 'present-following'
                ? eventIndex === 0
                  ? 'present'
                  : 'following'
                : existing?.presentFollowing;
            const sources = [...new Set<EventSource>([...(existing?.sources ?? []), eit.kind])].sort();
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
                  dimensionNames: rrt.dimensions
                    .map((dimension) => dimension.name)
                    .join(', '),
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
        // SCTE 18 shares PID 0x1FFB with ATSC PSIP. Require a valid CRC so
        // private data that happens to start with 0xD8 is not reported as an
        // emergency alert.
        const eas =
          info.crcValid === false
            ? null
            : parseScte18Eas(section.data, atscStt?.gpsUtcOffset ?? 0);
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
            (existing?.descriptors ?? []).map((descriptor) => `${descriptor.tag}:${descriptor.raw}`),
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
            ...(existing?.natureOfActivation ?? eas.natureOfActivation
              ? { natureOfActivation: existing?.natureOfActivation ?? eas.natureOfActivation }
              : {}),
            ...(existing?.alertText ?? eas.alertText
              ? { alertText: existing?.alertText ?? eas.alertText }
              : {}),
            locations,
            exceptionCount: Math.max(existing?.exceptionCount ?? 0, eas.exceptions.length),
            descriptors,
            occurrences: (existing?.occurrences ?? 0) + 1,
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
          atscMgt = mgt;
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

  base.transport.packetCount = packetCount;
  base.transport.tsid = patTsid;
  base.transport.tsidHex = patTsid !== undefined ? hex16(patTsid) : undefined;
  base.transport.networkId = networkId;
  base.transport.networkName = networkName;
  base.transport.networkPid = networkPid;

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
      message: `Elementary stream metadata buffering reached its ${ES_TOTAL_LIMIT / (1024 * 1024)} MiB limit; some stream details were skipped.`,
    });
  }
  if (tableLimitDropped > 0) {
    diagnostics.push({
      code: 'TABLE_INDEX_LIMIT',
      severity: 'warning',
      message: `Table index reached its ${MAX_TABLES} entry limit; ${tableLimitDropped} additional section(s) were not indexed.`,
    });
  }
  if (eventLimitDropped > 0) {
    diagnostics.push({
      code: 'EVENT_INDEX_LIMIT',
      severity: 'warning',
      message: `EPG event index reached its ${MAX_EVENTS} entry limit; ${eventLimitDropped} additional event(s) were not indexed.`,
    });
  }
  if (ettLimitDropped > 0) {
    diagnostics.push({
      code: 'ETT_TEXT_LIMIT',
      severity: 'warning',
      message: `ATSC ETT text cache reached its ${MAX_ETT_TEXT} entry limit; ${ettLimitDropped} additional text block(s) were not stored.`,
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
  if (options.size !== undefined && data.length < options.size) {
    diagnostics.push({
      code: 'SAMPLE_LIMITED',
      severity: 'info',
      message: `Only the first ${data.length} of ${options.size} bytes were analysed.`,
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
        base.transport.bitrateBps =
          (packetCount * 188 * 8) / durationSec;
      }
    }
  }

  const ALLOWED_ES_TYPES = new Set([
    0x01, 0x02, 0x03, 0x04, 0x0f, 0x11, 0x1b, 0x1c, 0x1f, 0x20,
    0x24, 0x25, 0x26, 0x28, 0x29, 0x2a, 0x2b, 0x06, 0x81, 0x84, 0x85, 0x87, 0x88, 0x8a,
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
    if (owningPmt?.programDescriptors.some((descriptor) => descriptor.tag === 0x09 || descriptor.tag === 0xf6)) {
      continue;
    }
    if (stream.descriptors.some((descriptor) => descriptor.tag === 0x09 || descriptor.tag === 0xf6)) {
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
    layout.packetSize,
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
    base.ratings = [...ratingsByRegion.values()].sort(
      (a, b) => a.ratingRegion - b.ratingRegion,
    );
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
      const elapsedSec =
        ((entry.lastPacket - entry.firstPacket) * layout.packetSize * 8) / overallBitrate;
      if (elapsedSec > 0) entry.repeatIntervalSec = elapsedSec / (entry.occurrences - 1);
      const maxGap = sectionMaxGap.get(key);
      if (maxGap !== undefined && maxGap > 0) {
        entry.maxRepeatGapSec = (maxGap * layout.packetSize * 8) / overallBitrate;
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
      ecmPids: [...new Set(caSystemList.flatMap((entry) => entry.ecmPids))].sort(
        (a, b) => a - b,
      ),
      emmPids: [...new Set(caSystemList.flatMap((entry) => entry.emmPids))].sort(
        (a, b) => a - b,
      ),
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
  if (emergency.eas !== undefined || emergency.ewbs !== undefined) {
    base.emergency = emergency;
    for (const pid of base.pids) {
      if (easPids.has(pid.pid)) pid.kind = 'EAS';
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
    layoutSize: layout.packetSize,
    tableIds,
    descriptorTags,
    pmtByProgram,
    hasAtscPsi: stats.has(0x1ffb),
  });
  base.standard = detection;
  for (const table of base.tables) {
    table.name = tableName(table.tableId, detection.detected);
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
      const missingFromOther = [...sdtActualServices].filter(
        (serviceId) => !other.has(serviceId),
      );
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

  if (
    detection.detected !== 'ISDB' &&
    scrambledPackets > 0 &&
    catPidSeen === undefined
  ) {
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

function inspectSection(data: Uint8Array): SectionInfo | null {
  if (data.length < 3) return null;
  const tableId = data[0] as number;
  if (tableId === 0xff) return null;
  const b1 = data[1] as number;
  const sectionLength = ((b1 & 0x0f) << 8) | (data[2] as number);
  if (3 + sectionLength !== data.length) return null;
  const long = (b1 & 0x80) !== 0;

  if (!long) {
    return {
      tableId,
      mode: 'short',
      length: data.length,
      ...(tableId === 0x73 && data.length >= 4
        ? { crcValid: isSectionCrcValid(data) }
        : {}),
    };
  }

  if (data.length < 12) return null;
  return {
    tableId,
    tableIdExtension: readU16(data, 3),
    version: ((data[5] as number) >> 1) & 0x1f,
    currentNext: ((data[5] as number) & 0x01) !== 0,
    sectionNumber: data[6] as number,
    lastSectionNumber: data[7] as number,
    crcValid: isSectionCrcValid(data),
    mode: 'long',
    length: data.length,
  };
}

function dedupeStreams(streams: PmtSection['streams']): PmtSection['streams'] {
  const map = new Map<number, PmtSection['streams'][number]>();
  for (const stream of streams) map.set(stream.pid, stream);
  return [...map.values()];
}

function summarizeEventDescriptors(
  descriptors: DescriptorInfo[],
): Pick<
  ProbeEvent,
  'content' | 'rating' | 'languages' | 'items' | 'seriesId' | 'seriesName' | 'linkage'
> {
  const contentDescriptor = descriptors.find((descriptor) => descriptor.tag === 0x54);
  const ratingDescriptor = descriptors.find((descriptor) => descriptor.tag === 0x55);
  const content = contentDescriptor?.fields?.contentName ?? contentDescriptor?.fields?.content;
  const rating = ratingDescriptor?.fields?.ratingSummary ?? ratingDescriptor?.fields?.ratings;
  const languages = new Set<string>();

  for (const descriptor of descriptors) {
    if (descriptor.tag === 0x4d || descriptor.tag === 0x4e) {
      const language = descriptor.fields?.language;
      if (typeof language === 'string' && language.trim().length > 0) {
        languages.add(language.trim());
      }
    }
    const list = descriptor.fields?.languages;
    if (typeof list === 'string') {
      for (const part of list.split(',')) {
        const code = part.trim().split(/\s+/)[0];
        if (code !== undefined && code.length > 0 && code !== 'undefined') languages.add(code);
      }
    }
  }

  const extended = descriptors.find((descriptor) => descriptor.tag === 0x4e);
  const itemsField = extended?.fields?.items;
  const items =
    typeof itemsField === 'string'
      ? itemsField
          .split(';')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : undefined;

  const series = descriptors.find((descriptor) => descriptor.tag === 0xd5);
  const seriesId =
    typeof series?.fields?.seriesId === 'number' ? series.fields.seriesId : undefined;
  const seriesName =
    typeof series?.fields?.seriesName === 'string' ? series.fields.seriesName : undefined;

  const linkageDescriptor = descriptors.find((descriptor) => descriptor.tag === 0x4a);
  const linkage = linkageDescriptor
    ? `${linkageDescriptor.fields?.linkageTypeName ?? 'linkage'} TS ${
        linkageDescriptor.fields?.transportStreamId ?? '-'
      } service ${linkageDescriptor.fields?.serviceId ?? '-'}`
    : undefined;

  return {
    ...(content !== undefined ? { content: String(content) } : {}),
    ...(rating !== undefined ? { rating: String(rating) } : {}),
    ...(languages.size > 0 ? { languages: [...languages] } : {}),
    ...(items !== undefined && items.length > 0 ? { items } : {}),
    ...(seriesId !== undefined ? { seriesId } : {}),
    ...(seriesName !== undefined ? { seriesName } : {}),
    ...(linkage !== undefined ? { linkage } : {}),
  };
}

function applyAtscAdvisories(
  events: ProbeEvent[],
  regions: ProbeRatingRegion[],
): void {
  const regionById = new Map(regions.map((region) => [region.ratingRegion, region]));
  for (const event of events) {
    if (event.rating) continue;
    const advisory = event.descriptors.find((descriptor) => descriptor.tag === 0x87);
    if (!advisory) continue;
    const regionId =
      typeof advisory.fields?.ratingRegion === 'number'
        ? advisory.fields.ratingRegion
        : undefined;
    const region = regionId !== undefined ? regionById.get(regionId) : undefined;
    const raw = typeof advisory.fields?.ratings === 'string' ? advisory.fields.ratings : '';
    const parts: string[] = [];
    for (const pair of raw.split(',')) {
      const match = /^\s*(\d+)\/(\d+)\s*$/.exec(pair);
      if (!match) continue;
      const dimensionIndex = Number(match[1]);
      const valueIndex = Number(match[2]);
      const dimension = region?.dimensions[dimensionIndex];
      const value = dimension?.values[valueIndex];
      const label = value?.abbrev || value?.text || `value ${valueIndex}`;
      const dimensionName = dimension?.name ? `${dimension.name} ` : '';
      parts.push(`${dimensionName}${label}`.trim());
    }
    if (parts.length === 0) continue;
    event.rating = `${regionId !== undefined ? `RRT${regionId}` : 'ATSC'} ${parts.join(', ')}`;
  }
}

function choosePcrPid(
  pmtByProgram: Map<number, PmtSection>,
  pcrPidCounts: Map<number, number>,
): number | undefined {
  for (const pmt of pmtByProgram.values()) {
    if (pmt.pcrPid !== 0x1fff && pcrPidCounts.has(pmt.pcrPid)) return pmt.pcrPid;
  }
  let best: number | undefined;
  let bestCount = 0;
  for (const [pid, count] of pcrPidCounts) {
    if (count > bestCount) {
      best = pid;
      bestCount = count;
    }
  }
  return best;
}

function parseLocalOffset(value: string | number | boolean | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60;
  return match[1] === '-' ? -seconds : seconds;
}

function descriptorLanguage(descriptors: ProbeStream['descriptors']): string | undefined {
  for (const descriptor of descriptors) {
    const fields = descriptor.fields ?? {};
    if (typeof fields.language === 'string') return fields.language;
    if (typeof fields.languages === 'string') {
      return fields.languages.split(',')[0]?.trim();
    }
  }
  return undefined;
}

function channelModeName(channels: number): string {
  if (channels === 1) return 'mono';
  if (channels === 2) return 'stereo';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return `${channels} ch`;
}

function formatNumber(value: number, maximumFractionDigits = 3): string {
  return value.toLocaleString('en-US', { maximumFractionDigits });
}

function streamDescriptionDetails(stream: ProbeStream): string | undefined {
  const es = stream.es;
  if (!es) return undefined;
  const parts: string[] = [];
  if (es.kind === 'video') {
    if (es.width !== undefined && es.height !== undefined) {
      parts.push(`${es.width}x${es.height}${es.interlaced ? 'i' : 'p'}`);
    }
    if (es.frameRate !== undefined) parts.push(`@${formatNumber(es.frameRate)} Hz`);
    if (es.aspectRatio !== undefined) parts.push(es.aspectRatio);
    const profileLevel = [es.profile, es.level].filter(Boolean).join('/');
    if (profileLevel.length > 0) parts.push(profileLevel);
  } else if (es.kind === 'audio') {
    const language = descriptorLanguage(stream.descriptors);
    if (language !== undefined) parts.push(language);
    if (es.codec !== undefined) parts.push(es.codec);
    if (es.channels !== undefined) parts.push(channelModeName(es.channels));
    if (es.sampleRate !== undefined) parts.push(`@${formatNumber(es.sampleRate, 0)} Hz`);
    const ac3 = stream.descriptors.find((descriptor) => descriptor.tag === 0x81)?.fields;
    if (typeof ac3?.audioServiceTypeName === 'string') {
      parts.push(ac3.audioServiceTypeName);
    }
    if (typeof ac3?.bsid === 'number') parts.push(`bsid ${ac3.bsid}`);
    const supplementary = stream.descriptors.find(
      (descriptor) =>
        descriptor.tag === 0x7f && descriptor.fields?.extensionTag === 0x06,
    )?.fields;
    if (typeof supplementary?.editorialClassificationName === 'string') {
      parts.push(supplementary.editorialClassificationName);
    }
  } else if (es.kind === 'subtitle') {
    const language = descriptorLanguage(stream.descriptors);
    if (language !== undefined) parts.push(language);
    if (es.codec !== undefined) parts.push(es.codec);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function dvbServiceTypeName(type: number): string {
  switch (type) {
    case 0x01:
      return 'digital television';
    case 0x02:
      return 'digital radio';
    case 0x03:
      return 'teletext';
    case 0x04:
      return 'NVOD reference';
    case 0x05:
      return 'NVOD time-shifted';
    case 0x06:
      return 'mosaic';
    case 0x07:
      return 'FM radio';
    case 0x08:
      return 'DVB SRM';
    case 0x09:
      return 'advanced codec digital radio';
    case 0x0a:
      return 'advanced codec mosaic';
    case 0x0b:
      return 'advanced codec data broadcast';
    case 0x16:
      return 'AVC digital television';
    case 0x19:
      return 'HEVC digital television';
    case 0x1f:
      return 'HEVC UHD digital television';
    case 0xc0:
      return 'ISDB data service';
    default:
      return `service type 0x${type.toString(16).padStart(2, '0')}`;
  }
}

function buildServices(
  patPrograms: Map<number, number>,
  pmtByProgram: Map<number, PmtSection>,
  sdtServicesById: Map<number, SdtService>,
  atscChannels: Map<number, AtscChannel>,
  esByPid: Map<number, EsMetadata>,
  stats: Map<number, MutablePidStat>,
  packetSize: number,
  durationSec: number | undefined,
  tsid: number | undefined,
  t2miPids: Set<number>,
  ssuSignalled: boolean,
  caBySystem: Map<number, { ecm: Set<number>; emm: Set<number> }>,
): ProbeService[] {
  const services: ProbeService[] = [];
  const programNumbers = new Set<number>([
    ...patPrograms.keys(),
    ...pmtByProgram.keys(),
    ...atscChannels.keys(),
  ]);

  for (const programNumber of programNumbers) {
    const pmt = pmtByProgram.get(programNumber);
    const sdt = sdtServicesById.get(programNumber);
    const vct = atscChannels.get(programNumber);
    const streams: ProbeStream[] = (pmt?.streams ?? []).map((stream) => {
      const candidate: ProbeStream = {
        streamType: stream.streamType,
        streamTypeHex: `0x${stream.streamType.toString(16).padStart(2, '0').toUpperCase()}`,
        pid: stream.pid,
        pidHex: hex16(stream.pid),
        description: streamTypeName(stream.streamType),
        descriptors: stream.descriptors,
        ...(esByPid.has(stream.pid) ? { es: esByPid.get(stream.pid) } : {}),
      };
      const details = streamDescriptionDetails(candidate);
      return details !== undefined ? { ...candidate, descriptionDetails: details } : candidate;
    });

    const serviceCaSystems = new Set<number>();
    const serviceEcmPids = new Set<number>();
    const serviceEmmPids = new Set<number>();
    if (pmt) {
      const descriptors = [
        ...pmt.programDescriptors,
        ...pmt.streams.flatMap((stream) => stream.descriptors),
      ];
      for (const descriptor of descriptors) {
        if (descriptor.tag !== 0x09 && descriptor.tag !== 0xf6) continue;
        const systemId = descriptor.fields?.caSystemId;
        if (typeof systemId === 'number') serviceCaSystems.add(systemId);
        const ecmPid = descriptor.fields?.caPid ?? descriptor.fields?.ecmPid;
        if (typeof ecmPid === 'number') serviceEcmPids.add(ecmPid);
      }
    }
    for (const systemId of serviceCaSystems) {
      for (const emmPid of caBySystem.get(systemId)?.emm ?? []) serviceEmmPids.add(emmPid);
    }

    const pmtPid = patPrograms.get(programNumber) ?? 0;
    const servicePids = new Set<number>();
    if (pmtPid > 0) servicePids.add(pmtPid);
    if (pmt && pmt.pcrPid !== 0x1fff) servicePids.add(pmt.pcrPid);
    for (const stream of streams) servicePids.add(stream.pid);
    const pids = [...servicePids].sort((a, b) => a - b);
    let packets = 0;
    for (const pid of pids) packets += stats.get(pid)?.packets ?? 0;
    const bitrateBps =
      durationSec !== undefined && durationSec > 0
        ? (packets * packetSize * 8) / durationSec
        : undefined;
    const serviceCa =
      pmt?.programDescriptors.some(
        (descriptor) => descriptor.tag === 0x09 || descriptor.tag === 0xf6,
      ) ?? false;
    let scrambledComponents = 0;
    for (const pid of pids) {
      const stat = stats.get(pid);
      const stream = pmt?.streams.find((entry) => entry.pid === pid);
      const descriptorScrambled =
        serviceCa ||
        (stream?.descriptors.some(
          (descriptor) => descriptor.tag === 0x09 || descriptor.tag === 0xf6,
        ) ??
          false);
      const pidScrambled =
        stat !== undefined && stat.packets > 0 && stat.scrambled >= stat.packets * 0.5;
      if (descriptorScrambled || pidScrambled) scrambledComponents += 1;
    }
    const components = {
      total: pids.length,
      clear: pids.length - scrambledComponents,
      scrambled: scrambledComponents,
    };

    const serviceType = sdt?.serviceType ?? vct?.serviceType;
    services.push({
      programNumber,
      programNumberHex: hex16(programNumber),
      ...(sdt?.serviceId !== undefined
        ? { serviceId: sdt.serviceId }
        : vct?.sourceId !== undefined
          ? { serviceId: vct.sourceId }
          : {}),
      ...(sdt?.serviceName !== undefined
        ? { name: sdt.serviceName }
        : vct?.shortName !== undefined
          ? { name: vct.shortName }
          : {}),
      ...(sdt?.providerName !== undefined ? { providerName: sdt.providerName } : {}),
      ...(serviceType !== undefined ? { serviceType } : {}),
      ...(vct !== undefined
        ? { serviceTypeName: atscServiceTypeName(vct.serviceType) }
        : sdt?.serviceType !== undefined
          ? { serviceTypeName: dvbServiceTypeName(sdt.serviceType) }
          : {}),
      ...(vct !== undefined
        ? {
            majorChannelNumber: vct.majorChannelNumber,
            minorChannelNumber: vct.minorChannelNumber,
            sourceId: vct.sourceId,
            channelTsid: vct.channelTsid,
            modulationMode: vct.modulationMode,
          }
        : {}),
      ...(tsid !== undefined ? { tsid } : {}),
      ...(sdt?.originalNetworkId !== undefined
        ? { originalNetworkId: sdt.originalNetworkId }
        : vct !== undefined
          ? { originalNetworkId: 0 }
          : {}),
      hidden: vct?.hidden ?? false,
      packets,
      ...(bitrateBps !== undefined
        ? { bitrateBps, bitrate204Bps: (bitrateBps * 204) / 188 }
        : {}),
      pids,
      components,
      isScrambled: scrambledComponents > 0,
      ...(serviceCaSystems.size > 0
        ? {
            conditionalAccess: {
              systems: [...serviceCaSystems].sort((a, b) => a - b),
              ecmPids: [...serviceEcmPids].sort((a, b) => a - b),
              emmPids: [...serviceEmmPids].sort((a, b) => a - b),
            },
          }
        : {}),
      ssu: ssuSignalled,
      t2mi: streams.some((stream) => t2miPids.has(stream.pid)),
      pmtPid,
      ...(pmt && pmt.pcrPid !== 0x1fff ? { pcrPid: pmt.pcrPid } : {}),
      descriptors: pmt?.programDescriptors ?? [],
      streams,
    });
  }

  return services.sort((a, b) => a.programNumber - b.programNumber);
}

function atscServiceTypeName(type: number): string {
  switch (type) {
    case 0x01:
      return 'analog television';
    case 0x02:
      return 'ATSC digital television';
    case 0x03:
      return 'ATSC audio';
    case 0x04:
      return 'ATSC data only';
    default:
      return 'reserved';
  }
}

function buildPids(
  stats: Map<number, MutablePidStat>,
  pmtPids: Set<number>,
  pmtByProgram: Map<number, PmtSection>,
  pcrPid: number | undefined,
): ProbePid[] {
  const kindByPid = new Map<number, string>();
  for (const pmtPid of pmtPids) kindByPid.set(pmtPid, 'PMT');
  for (const pmt of pmtByProgram.values()) {
    for (const stream of pmt.streams) {
      kindByPid.set(stream.pid, streamTypeName(stream.streamType));
    }
  }
  if (pcrPid !== undefined && !kindByPid.has(pcrPid)) kindByPid.set(pcrPid, 'PCR');

  const pids: ProbePid[] = [];
  for (const [pid, stat] of stats) {
    const kind = kindByPid.get(pid) ?? pidKind(pid);
    pids.push({
      pid,
      pidHex: hex16(pid),
      packets: stat.packets,
      payloadBytes: stat.payloadBytes,
      pusi: stat.pusi,
      scrambled: stat.scrambled,
      ccErrors: stat.ccErrors,
      tei: stat.tei,
      pcrCount: stat.pcrCount,
      ...(stat.lastCc !== undefined ? { lastCc: stat.lastCc } : {}),
      ...(stat.firstPacket !== undefined ? { firstPacket: stat.firstPacket } : {}),
      ...(stat.firstPacketOffset !== undefined
        ? { firstPacketOffset: stat.firstPacketOffset }
        : {}),
      ...(kind ? { kind } : {}),
    });
  }
  return pids.sort((a, b) => a.pid - b.pid);
}

interface DetectionInput {
  layoutSize: number;
  tableIds: Set<number>;
  descriptorTags: Set<number>;
  pmtByProgram: Map<number, PmtSection>;
  hasAtscPsi: boolean;
}

function detectStandard(input: DetectionInput): ProbeResult['standard'] {
  let atsc = 0;
  let isdb = 0;
  let dvb = 0;
  const evidence: string[] = [];
  const seen = new Set<string>();
  const add = (text: string): void => {
    if (!seen.has(text)) {
      seen.add(text);
      evidence.push(text);
    }
  };

  const isdbStrong =
    input.layoutSize === 204 ||
    [...input.descriptorTags].some((tag) => ISDB_DESCRIPTOR_TAGS.has(tag)) ||
    [...input.tableIds].some((tableId) => tableId >= 0xc3 && tableId <= 0xc6);
  const atscStrong =
    input.hasAtscPsi ||
    [...input.descriptorTags].some((tag) => ATSC_DESCRIPTOR_TAGS.has(tag)) ||
    [...input.tableIds].some((tableId) => tableId >= 0xc9 && tableId <= 0xcd) ||
    [...input.pmtByProgram.values()].some((pmt) =>
      pmt.programDescriptors.some(
        (descriptor) =>
          descriptor.tag === 0x05 && descriptor.fields?.formatIdentifier === 'GA94',
      ),
    );

  for (const tableId of input.tableIds) {
    const hex = tableId.toString(16).padStart(2, '0').toUpperCase();
    if (tableId === 0xc7 || tableId === 0xc8) {
      // ISDB LDT/CDT and ATSC MGT/TVCT share table ids 0xC7/0xC8.
      const isdbName = tableId === 0xc7 ? 'ISDB LDT' : 'ISDB CDT';
      const atscName = tableId === 0xc7 ? 'ATSC MGT' : 'ATSC TVCT';
      if (isdbStrong && !atscStrong) {
        isdb += 1;
        add(`${isdbName} (0x${hex})`);
      } else if (atscStrong && !isdbStrong) {
        atsc += 1;
        add(`${atscName} (0x${hex})`);
      } else if (isdbStrong && atscStrong) {
        isdb += 1;
        atsc += 1;
        add(`shared table 0x${hex} (${isdbName} / ${atscName})`);
      } else {
        atsc += 1;
        add(`${atscName} (0x${hex})`);
      }
      continue;
    }
    const label = `${tableName(
      tableId,
      tableId >= 0xc3 && tableId <= 0xc6 ? 'ISDB' : ATSC_TABLE_IDS.has(tableId) ? 'ATSC' : 'DVB',
    )} (0x${hex})`;
    if (ATSC_TABLE_IDS.has(tableId)) {
      atsc += 1;
      add(label);
    } else if (ISDB_TABLE_IDS.has(tableId)) {
      isdb += 1;
      add(label);
    } else if (
      tableId === 0x40 ||
      tableId === 0x41 ||
      tableId === 0x42 ||
      tableId === 0x46 ||
      tableId === 0x4a ||
      (tableId >= 0x4e && tableId <= 0x6f) ||
      (tableId >= 0x70 && tableId <= 0x74) ||
      tableId === 0x7e ||
      tableId === 0x7f
    ) {
      dvb += 1;
      add(label);
    }
  }

  for (const tag of input.descriptorTags) {
    const label = `descriptor 0x${tag.toString(16).padStart(2, '0').toUpperCase()}`;
    if (ATSC_DESCRIPTOR_TAGS.has(tag)) {
      atsc += 1;
      add(label);
    }
    if (ISDB_DESCRIPTOR_TAGS.has(tag)) {
      isdb += 1;
      add(label);
    }
    if (DVB_DESCRIPTOR_TAGS.has(tag)) {
      dvb += 1;
      add(label);
    }
  }

  for (const pmt of input.pmtByProgram.values()) {
    for (const descriptor of pmt.programDescriptors) {
      if (descriptor.tag === 0x05 && descriptor.fields?.formatIdentifier === 'GA94') {
        atsc += 2;
        add('registration GA94 (ATSC)');
      }
    }
  }

  if (input.hasAtscPsi) {
    atsc += 2;
    add('ATSC PSIP PID 0x1FFB');
  }
  if (input.layoutSize === 204) {
    isdb += 2;
    add('204-byte ISDB-Tb packets');
  }
  if (input.layoutSize === 192) {
    add('192-byte M2TS packets');
  }

  let detected: Standard = 'unknown';
  if (atsc > 0 && (isdb > 0 || dvb > 0)) detected = 'mixed';
  else if (atsc > 0) detected = 'ATSC';
  else if (isdb > 0) detected = 'ISDB';
  else if (dvb > 0) detected = 'DVB';

  const strength = Math.max(atsc, isdb, dvb);
  const confidence =
    detected === 'unknown'
      ? 0.2
      : detected === 'mixed'
        ? 0.8
        : Math.min(0.99, 0.7 + strength * 0.03);

  return { detected, confidence, evidence };
}
