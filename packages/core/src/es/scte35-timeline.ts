import type { PacketLayout } from '../model/types.js';
import { collectPesPackets } from '../pes/index.js';
import { SectionAssembler } from '../section/assembler.js';
import { scanPackets } from '../ts/reader.js';
import { hex16 } from '../util/bytes.js';
import { parseScte35Section, type Scte35Section } from './scte35.js';

/** One SCTE-35 splice event placed on the stream timeline. */
export interface Scte35TimelineEvent {
  pid: number;
  pidHex: string;
  /** Zero-based packet index of the section or PES start. */
  packet: number;
  /** Byte offset of the packet in the scanned buffer. */
  offset?: number;
  /** Estimated position in the scanned stream, in seconds. */
  timeSec?: number;
  /** pts_adjustment + splice_time, wrapped to 33 bits. */
  splicePts?: number;
  /** splicePts / 90 000, still on the 33-bit PTS clock. */
  spliceSeconds?: number;
  /** PES PTS for sections carried inside private PES packets. */
  pts?: number;
  ptsSeconds?: number;
  commandType: number;
  commandName: string;
  eventId?: number;
  eventCancel?: boolean;
  outOfNetwork?: boolean;
  spliceImmediate?: boolean;
  spliceTime?: number;
  breakDuration?: number;
  autoReturn?: boolean;
  uniqueProgramId?: number;
  availNum?: number;
  availsExpected?: number;
  segmentationEventId?: number;
  segmentationTypeId?: number;
  segmentationTypeName?: string;
  segmentationDuration?: number;
  upidType?: number;
  upid?: string;
  segmentNum?: number;
  segmentsExpected?: number;
  subSegmentNum?: number;
  subSegmentsExpected?: number;
  source: 'section' | 'pes';
  crcValid: boolean;
  /** Total occurrences when the same section was repeated within the window. */
  repeats?: number;
}

/** A splice/segmentation interval derived from break or segmentation durations. */
export interface Scte35TimelineBreak {
  pid: number;
  pidHex: string;
  startPacket: number;
  /** Estimated start in seconds, when packet timing is known. */
  startSec?: number;
  endSec?: number;
  durationSec: number;
  commandName: string;
  eventId?: number;
  segmentationEventId?: number;
  segmentationTypeName?: string;
  outOfNetwork: boolean;
  autoReturn: boolean;
  availNum?: number;
  availsExpected?: number;
  uniqueProgramId?: number;
}

export interface Scte35Timeline {
  events: Scte35TimelineEvent[];
  breaks: Scte35TimelineBreak[];
  /** PIDs that produced at least one event. */
  pids: number[];
  count: number;
  /** True when maxEvents stopped collection early. */
  truncated: boolean;
}

export interface Scte35TimelineOptions {
  /** PIDs to scan. An empty or absent set scans every PID for 0xFC sections. */
  pids?: Set<number>;
  /** Transport bitrate used to estimate event times when duration is unknown. */
  bitrateBps?: number;
  /** Duration of the scanned range, used together with the packet count. */
  durationSec?: number;
  /** Safety limit; default 10 000 events. */
  maxEvents?: number;
  /**
   * Collapse repeated transmissions of the same event occurring within this
   * many seconds (default 2). Set to 0 to keep every occurrence.
   */
  dedupeWindowSec?: number;
}

const SCTE35_TABLE_ID = 0xfc;
const PTS_WRAP = 0x2_0000_0000;

function adjustedSpliceTime(section: Scte35Section): number | undefined {
  if (section.spliceTime === undefined) return undefined;
  return (section.spliceTime + section.ptsAdjustment) % PTS_WRAP;
}

function eventKey(event: Scte35TimelineEvent): string {
  return [
    event.pid,
    event.commandType,
    event.eventId ?? '',
    event.eventCancel ?? '',
    event.spliceTime ?? '',
    event.breakDuration ?? '',
    event.segmentationEventId ?? '',
    event.segmentationTypeId ?? '',
    event.availNum ?? '',
  ].join('|');
}

/**
 * Collect SCTE-35 splice_info_section occurrences from MPEG-TS packets and
 * private PES payloads, order them by packet position and derive break
 * intervals from break_duration/segmentation_duration fields.
 */
export function collectScte35Timeline(
  data: Uint8Array,
  layout: PacketLayout,
  options: Scte35TimelineOptions = {},
): Scte35Timeline {
  const maxEvents = options.maxEvents ?? 10_000;
  const dedupeWindowSec = options.dedupeWindowSec ?? 2;
  const targetPids = options.pids !== undefined && options.pids.size > 0 ? options.pids : undefined;
  const events: Scte35TimelineEvent[] = [];
  const eventPids = new Set<number>();
  const sectionPids = new Set<number>();
  const allPids = new Set<number>();
  const lastByKey = new Map<string, Scte35TimelineEvent>();
  const assemblers = new Map<number, SectionAssembler>();
  let packetCount = 0;
  let truncated = false;

  const addEvent = (
    source: 'section' | 'pes',
    pid: number,
    packet: number,
    offset: number | undefined,
    section: Scte35Section,
    pts?: number,
  ): void => {
    const segmentation = section.segmentation;
    const splicePts = adjustedSpliceTime(section);
    const event: Scte35TimelineEvent = {
      pid,
      pidHex: hex16(pid),
      packet,
      ...(offset !== undefined ? { offset } : {}),
      ...(splicePts !== undefined ? { splicePts, spliceSeconds: splicePts / 90_000 } : {}),
      ...(pts !== undefined ? { pts, ptsSeconds: pts / 90_000 } : {}),
      commandType: section.commandType,
      commandName: section.commandName,
      ...(section.eventId !== undefined ? { eventId: section.eventId } : {}),
      ...(section.eventCancel !== undefined ? { eventCancel: section.eventCancel } : {}),
      ...(section.outOfNetwork !== undefined ? { outOfNetwork: section.outOfNetwork } : {}),
      ...(section.spliceImmediate !== undefined
        ? { spliceImmediate: section.spliceImmediate }
        : {}),
      ...(section.spliceTime !== undefined ? { spliceTime: section.spliceTime } : {}),
      ...(section.breakDuration !== undefined ? { breakDuration: section.breakDuration } : {}),
      ...(section.autoReturn !== undefined ? { autoReturn: section.autoReturn } : {}),
      ...(section.uniqueProgramId !== undefined
        ? { uniqueProgramId: section.uniqueProgramId }
        : {}),
      ...(section.availNum !== undefined ? { availNum: section.availNum } : {}),
      ...(section.availsExpected !== undefined
        ? { availsExpected: section.availsExpected }
        : {}),
      ...(segmentation?.eventId !== undefined
        ? { segmentationEventId: segmentation.eventId }
        : {}),
      ...(segmentation?.typeId !== undefined ? { segmentationTypeId: segmentation.typeId } : {}),
      ...(segmentation?.typeName !== undefined
        ? { segmentationTypeName: segmentation.typeName }
        : {}),
      ...(segmentation?.duration !== undefined
        ? { segmentationDuration: segmentation.duration }
        : {}),
      ...(segmentation?.upidType !== undefined ? { upidType: segmentation.upidType } : {}),
      ...(segmentation?.upid !== undefined ? { upid: segmentation.upid } : {}),
      ...(segmentation?.segmentNum !== undefined ? { segmentNum: segmentation.segmentNum } : {}),
      ...(segmentation?.segmentsExpected !== undefined
        ? { segmentsExpected: segmentation.segmentsExpected }
        : {}),
      ...(segmentation?.subSegmentNum !== undefined
        ? { subSegmentNum: segmentation.subSegmentNum }
        : {}),
      ...(segmentation?.subSegmentsExpected !== undefined
        ? { subSegmentsExpected: segmentation.subSegmentsExpected }
        : {}),
      source,
      crcValid: section.crcValid,
    };

    if (dedupeWindowSec > 0) {
      const key = eventKey(event);
      const previous = lastByKey.get(key);
      if (previous) {
        const packetGap = event.packet - previous.packet;
        const secondsGap =
          options.bitrateBps !== undefined && options.bitrateBps > 0
            ? (packetGap * layout.packetSize * 8) / options.bitrateBps
            : undefined;
        const within =
          secondsGap !== undefined ? secondsGap <= dedupeWindowSec : packetGap <= 500;
        if (within) {
          previous.repeats = (previous.repeats ?? 1) + 1;
          return;
        }
      }
      lastByKey.set(key, event);
    }

    if (events.length >= maxEvents) {
      truncated = true;
      return;
    }
    events.push(event);
    eventPids.add(pid);
  };

  for (const packet of scanPackets(data, layout)) {
    packetCount += 1;
    allPids.add(packet.pid);
    if (targetPids !== undefined && !targetPids.has(packet.pid)) continue;
    if (!packet.payload) continue;
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
      if (section.data[0] !== SCTE35_TABLE_ID) continue;
      const parsed = parseScte35Section(section.data);
      if (!parsed || !parsed.crcValid) continue;
      sectionPids.add(packet.pid);
      addEvent('section', packet.pid, section.packetIndex, section.packetOffset, parsed);
    }
  }

  // Some streams carry splice_info_section inside private PES packets. Without
  // a PMT hint, restrict the PES pass to PIDs that actually carried packets.
  const pesPids = targetPids ?? (sectionPids.size > 0 ? sectionPids : allPids);
  if (pesPids.size > 0) {
    for (const pes of collectPesPackets(data, layout, pesPids)) {
      const payload = pes.payload;
      for (let i = 0; i + 3 <= payload.length; i += 1) {
        if (payload[i] !== SCTE35_TABLE_ID) continue;
        const sectionLength = (((payload[i + 1] as number) & 0x0f) << 8) | (payload[i + 2] as number);
        const end = i + 3 + sectionLength;
        if (end > payload.length) continue;
        const parsed = parseScte35Section(payload.subarray(i, end));
        if (!parsed || !parsed.crcValid) continue;
        addEvent('pes', pes.pid, pes.firstPacket, pes.firstPacketOffset, parsed, pes.pts);
        i = end - 1;
      }
    }
  }

  events.sort((a, b) => a.packet - b.packet || a.pid - b.pid);

  for (const event of events) {
    if (options.durationSec !== undefined && options.durationSec > 0 && packetCount > 1) {
      event.timeSec = (event.packet / (packetCount - 1)) * options.durationSec;
    } else if (options.bitrateBps !== undefined && options.bitrateBps > 0) {
      event.timeSec = (event.packet * layout.packetSize * 8) / options.bitrateBps;
    }
  }

  const breaks: Scte35TimelineBreak[] = [];
  for (const event of events) {
    const ticks = event.breakDuration ?? event.segmentationDuration;
    if (ticks === undefined || ticks <= 0) continue;
    const durationSec = ticks / 90_000;
    breaks.push({
      pid: event.pid,
      pidHex: event.pidHex,
      startPacket: event.packet,
      ...(event.timeSec !== undefined
        ? { startSec: event.timeSec, endSec: event.timeSec + durationSec }
        : {}),
      durationSec,
      commandName: event.commandName,
      ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
      ...(event.segmentationEventId !== undefined
        ? { segmentationEventId: event.segmentationEventId }
        : {}),
      ...(event.segmentationTypeName !== undefined
        ? { segmentationTypeName: event.segmentationTypeName }
        : {}),
      outOfNetwork: event.outOfNetwork ?? false,
      autoReturn: event.autoReturn ?? false,
      ...(event.availNum !== undefined ? { availNum: event.availNum } : {}),
      ...(event.availsExpected !== undefined ? { availsExpected: event.availsExpected } : {}),
      ...(event.uniqueProgramId !== undefined
        ? { uniqueProgramId: event.uniqueProgramId }
        : {}),
    });
  }
  breaks.sort((a, b) => a.startPacket - b.startPacket || a.pid - b.pid);

  return {
    events,
    breaks,
    pids: [...eventPids].sort((a, b) => a - b),
    count: events.length,
    truncated,
  };
}
