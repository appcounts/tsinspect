import type { DescriptorInfo } from '../model/types.js';
import {
  describeDescriptors,
  parseRawDescriptors,
  type TextEncoding,
} from '../descriptors/descriptor.js';
import { readU16, readU8 } from '../util/bytes.js';
import { parseDvbDateTime, parseDvbDurationSeconds, type DvbDateTime } from '../util/time.js';
import { parseLongSectionHeader } from './common.js';

export interface EitEvent {
  eventId: number;
  startTime?: DvbDateTime;
  startTimeIso?: string;
  durationSec?: number;
  endTimeIso?: string;
  runningStatus: number;
  runningStatusName?: string;
  freeCaMode: boolean;
  /** Decoded short event name (descriptor 0x4D), if present. */
  name?: string;
  /** Decoded short/extended event text, if present. */
  text?: string;
  descriptors: DescriptorInfo[];
}

export interface EitSection {
  tableId: number;
  serviceId: number;
  transportStreamId: number;
  originalNetworkId: number;
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  segmentLastSectionNumber: number;
  lastTableId: number;
  kind: 'present-following' | 'schedule';
  events: EitEvent[];
  crcValid: boolean;
}

const RUNNING_STATUS = ['undefined', 'not running', 'starts in a few seconds', 'pausing', 'running', 'off air'];

export function parseEit(
  data: Uint8Array,
  textEncoding: TextEncoding = 'dvb',
): EitSection | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId < 0x4e || header.tableId > 0x6f) return null;

  const end = header.totalLength - 4;
  if (end < 14) return null;

  const events: EitEvent[] = [];
  let cursor = 14;

  while (cursor + 12 <= end) {
    const eventId = readU16(data, cursor);
    const startTime = parseDvbDateTime(data, cursor + 2) ?? undefined;
    const durationSec = parseDvbDurationSeconds(data, cursor + 7) ?? undefined;
    const flags = readU8(data, cursor + 10);
    const descriptorLength = ((flags & 0x0f) << 8) | readU8(data, cursor + 11);
    const descriptorStart = cursor + 12;
    const descriptorEnd = Math.min(end, descriptorStart + descriptorLength);
    if (descriptorEnd < descriptorStart) break;

    const descriptors = describeDescriptors(
      parseRawDescriptors(data, descriptorStart, descriptorEnd - descriptorStart),
      textEncoding,
    );
    const shortEvent = descriptors.find((descriptor) => descriptor.tag === 0x4d);
    const extendedEvents = descriptors
      .filter(
        (descriptor) =>
          descriptor.tag === 0x4e || (textEncoding === 'arib' && descriptor.tag === 0xc4),
      )
      .sort(
        (a, b) =>
          Number(a.fields?.descriptorNumber ?? 0) - Number(b.fields?.descriptorNumber ?? 0),
      );
    const extendedText = extendedEvents
      .map((descriptor) =>
        typeof descriptor.fields?.text === 'string' ? descriptor.fields.text : '',
      )
      .filter((text) => text.length > 0)
      .join('');
    const runningStatus = (flags >> 5) & 0x07;
    const runningStatusName = RUNNING_STATUS[runningStatus];

    events.push({
      eventId,
      ...(startTime ? { startTime } : {}),
      ...(startTime ? { startTimeIso: startTime.iso } : {}),
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(startTime && durationSec !== undefined
        ? { endTimeIso: new Date((startTime.unixSeconds + durationSec) * 1000).toISOString() }
        : {}),
      runningStatus,
      ...(runningStatus > 0 && runningStatusName !== undefined
        ? { runningStatusName }
        : {}),
      freeCaMode: (flags & 0x10) !== 0,
      ...(shortEvent?.fields?.eventName !== undefined
        ? { name: String(shortEvent.fields.eventName) }
        : {}),
      ...(shortEvent?.fields?.text !== undefined
        ? { text: String(shortEvent.fields.text) }
        : extendedText.length > 0
          ? { text: extendedText }
          : {}),
      descriptors,
    });

    cursor = descriptorEnd;
  }

  return {
    tableId: header.tableId,
    serviceId: header.tableIdExtension,
    transportStreamId: readU16(data, 8),
    originalNetworkId: readU16(data, 10),
    version: header.version,
    currentNext: header.currentNext,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    segmentLastSectionNumber: readU8(data, 12),
    lastTableId: readU8(data, 13),
    kind: header.tableId === 0x4e || header.tableId === 0x4f ? 'present-following' : 'schedule',
    events,
    crcValid: header.crcValid,
  };
}
