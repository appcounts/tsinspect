import { parseAtscMultipleString } from '../descriptors/atsc-string.js';
import {
  describeDescriptors,
  parseRawDescriptors,
} from '../descriptors/descriptor.js';
import type { DescriptorInfo } from '../model/types.js';
import { readU16, readU32, readU8 } from '../util/bytes.js';
import { parseLongSectionHeader } from './common.js';
import { gpsToUnixSeconds } from './psip.js';

/** SCTE 18 cable EAS table id. */
export const SCTE18_TABLE_ID = 0xd8;

export interface Scte18Location {
  /** FIPS state code. */
  stateCode: number;
  countySubdivision: number;
  countyCode: number;
}

export interface Scte18Exception {
  inBand: boolean;
  majorChannelNumber?: number;
  minorChannelNumber?: number;
  oobSourceId?: number;
}

/** ANSI/SCTE 18 cable_emergency_alert_table() payload. */
export interface Scte18Eas {
  tableId: number;
  /** Section version field, used by SCTE 18 as the EAS sequence number. */
  sequenceNumber: number;
  sectionNumber: number;
  lastSectionNumber: number;
  crcValid: boolean;
  protocolVersion: number;
  eventId: number;
  /** Three-letter originator code, for example PEP, WXR, CIV or EAS. */
  originatorCode: string;
  /** Event code such as EAN, TOR, RMT or a locally defined code. */
  eventCode: string;
  natureOfActivation?: string;
  timeRemainingSec: number;
  startTimeIso?: string;
  durationSec: number;
  /** Alert priority, 0 (highest) to 15 (lowest). */
  priority: number;
  detailsOobSourceId?: number;
  detailsMajorChannelNumber?: number;
  detailsMinorChannelNumber?: number;
  audioOobSourceId?: number;
  alertText?: string;
  locations: Scte18Location[];
  exceptions: Scte18Exception[];
  descriptors: DescriptorInfo[];
}

/**
 * Parse an ANSI/SCTE 18 Emergency Alert System section.
 *
 * `gpsUtcOffset` is the current GPS-UTC leap-second offset from the ATSC STT,
 * used to turn the event start time into a UTC instant.
 */
export function parseScte18Eas(data: Uint8Array, gpsUtcOffset = 0): Scte18Eas | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId !== SCTE18_TABLE_ID) return null;

  const end = header.totalLength - 4;
  let cursor = 8;
  const available = (count: number): boolean => cursor + count <= end;
  const u8 = (): number => (available(1) ? readU8(data, cursor++) : 0);
  const u16 = (): number => {
    if (!available(2)) {
      cursor = end;
      return 0;
    }
    const value = readU16(data, cursor);
    cursor += 2;
    return value;
  };
  const skip = (count: number): void => {
    cursor = Math.min(end, cursor + count);
  };
  const mss = (lengthBytes: number): string => {
    const length = lengthBytes === 1 ? u8() : u16();
    if (length <= 0) return '';
    const bytes = data.subarray(cursor, Math.min(end, cursor + length));
    cursor = Math.min(end, cursor + length);
    return parseAtscMultipleString(bytes)
      .map((entry) => entry.text)
      .filter((text) => text.length > 0)
      .join(' / ');
  };

  if (!available(6)) return null;

  const protocolVersion = u8();
  const eventId = u16();
  const originatorCode = ascii(data.subarray(cursor, Math.min(end, cursor + 3)));
  skip(3);
  const eventCodeLength = u8();
  const eventCode = ascii(data.subarray(cursor, Math.min(end, cursor + eventCodeLength)));
  skip(eventCodeLength);
  const natureOfActivation = mss(1);
  const timeRemainingSec = u8();
  const startGps = available(4) ? readU32(data, cursor) : 0;
  skip(4);
  const durationSec = u16();
  skip(1); // reserved
  const priority = u8() & 0x0f;
  const detailsOobSourceId = u16();
  const detailsMajorChannelNumber = available(2)
    ? ((readU8(data, cursor) & 0x03) << 8) | readU8(data, cursor + 1)
    : undefined;
  skip(2);
  const detailsMinorChannelNumber = available(2)
    ? ((readU8(data, cursor) & 0x03) << 8) | readU8(data, cursor + 1)
    : undefined;
  skip(2);
  const audioOobSourceId = u16();
  const alertText = mss(2);

  const locations: Scte18Location[] = [];
  const locationCount = u8();
  for (let i = 0; i < locationCount && available(4); i += 1) {
    const stateCode = u8();
    const packed = u16();
    locations.push({
      stateCode,
      countySubdivision: (packed >> 12) & 0x0f,
      countyCode: packed & 0x0fff,
    });
  }

  const exceptions: Scte18Exception[] = [];
  const exceptionCount = u8();
  for (let i = 0; i < exceptionCount && available(5); i += 1) {
    const flags = u8();
    const inBand = (flags & 0x80) !== 0;
    if (inBand) {
      const majorChannelNumber = ((readU8(data, cursor) & 0x03) << 8) | readU8(data, cursor + 1);
      const minorChannelNumber =
        ((readU8(data, cursor + 2) & 0x03) << 8) | readU8(data, cursor + 3);
      skip(4);
      exceptions.push({ inBand, majorChannelNumber, minorChannelNumber });
    } else {
      skip(2);
      exceptions.push({ inBand, oobSourceId: u16() });
    }
  }

  let descriptors: DescriptorInfo[] = [];
  if (available(2)) {
    const descriptorLength = ((readU8(data, cursor) & 0x03) << 8) | readU8(data, cursor + 1);
    skip(2);
    const raw = parseRawDescriptors(data, cursor, Math.min(descriptorLength, end - cursor));
    descriptors = describeDescriptors(raw);
  }

  const startTimeIso =
    startGps > 0
      ? new Date(gpsToUnixSeconds(startGps, gpsUtcOffset) * 1000).toISOString()
      : undefined;

  return {
    tableId: header.tableId,
    sequenceNumber: header.version,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    crcValid: header.crcValid,
    protocolVersion,
    eventId,
    originatorCode: originatorCode.trim(),
    eventCode: eventCode.trim(),
    ...(natureOfActivation ? { natureOfActivation } : {}),
    timeRemainingSec,
    ...(startTimeIso ? { startTimeIso } : {}),
    durationSec,
    priority,
    ...(detailsOobSourceId !== undefined ? { detailsOobSourceId } : {}),
    ...(detailsMajorChannelNumber !== undefined ? { detailsMajorChannelNumber } : {}),
    ...(detailsMinorChannelNumber !== undefined ? { detailsMinorChannelNumber } : {}),
    ...(audioOobSourceId !== undefined ? { audioOobSourceId } : {}),
    ...(alertText ? { alertText } : {}),
    locations,
    exceptions,
    descriptors,
  };
}

function ascii(data: Uint8Array): string {
  let text = '';
  for (const byte of data) {
    text += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ' ';
  }
  return text;
}
