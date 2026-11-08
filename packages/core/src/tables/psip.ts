import type {
  DescriptorInfo,
  ProbeRatingDimension,
  ProbeRatingRegion,
  ProbeRatingValue,
} from '../model/types.js';
import {
  describeDescriptors,
  parseRawDescriptors,
} from '../descriptors/descriptor.js';
import { decodeAtscMultipleString } from '../descriptors/atsc-string.js';
import { readU16, readU24, readU32, readU8 } from '../util/bytes.js';
import { parseLongSectionHeader } from './common.js';

/** ATSC GPS epoch: 1980-01-06T00:00:00Z. */
export const GPS_UNIX_EPOCH = 315_964_800;

/** Convert an ATSC GPS seconds count to Unix seconds, subtracting leap seconds. */
export function gpsToUnixSeconds(gpsSeconds: number, gpsUtcOffset: number): number {
  return GPS_UNIX_EPOCH + gpsSeconds - gpsUtcOffset;
}

export interface AtscStt {
  tableId: number;
  version: number;
  currentNext: boolean;
  protocolVersion: number;
  gpsSeconds: number;
  gpsUtcOffset: number;
  utcIso: string;
  daylightSaving: boolean;
  /** Signed time zone offset in quarter-hours, when Annex A encodes one. */
  timeZoneOffset?: number;
  descriptors: DescriptorInfo[];
  crcValid: boolean;
}

export interface AtscMgtTable {
  tableType: number;
  tableTypeHex: string;
  name: string;
  pid: number;
  version: number;
  numberOfBytes: number;
  descriptors: DescriptorInfo[];
}

export interface AtscMgt {
  tableId: number;
  version: number;
  currentNext: boolean;
  protocolVersion: number;
  tables: AtscMgtTable[];
  descriptors: DescriptorInfo[];
  crcValid: boolean;
}

export interface AtscChannel {
  shortName?: string;
  majorChannelNumber: number;
  minorChannelNumber: number;
  modulationMode: number;
  carrierFrequency?: number;
  channelTsid: number;
  programNumber: number;
  etmLocation: number;
  accessControlled: boolean;
  hidden: boolean;
  hideGuide: boolean;
  /** CVCT only: path 1/2 selection. */
  pathSelect?: boolean;
  /** CVCT only: out-of-band delivery. */
  outOfBand?: boolean;
  serviceType: number;
  sourceId: number;
  descriptors: DescriptorInfo[];
}

export interface AtscVct {
  tableId: number;
  kind: 'TVCT' | 'CVCT';
  transportStreamId: number;
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  protocolVersion: number;
  channels: AtscChannel[];
  additionalDescriptors: DescriptorInfo[];
  crcValid: boolean;
}

export interface AtscEitEvent {
  eventId: number;
  startGps: number;
  startTimeIso: string;
  etmLocation: number;
  durationSec: number;
  endTimeIso?: string;
  title?: string;
  descriptors: DescriptorInfo[];
}

export interface AtscEit {
  tableId: number;
  sourceId: number;
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  protocolVersion: number;
  events: AtscEitEvent[];
  crcValid: boolean;
}

export interface AtscEtt {
  tableId: number;
  tableIdExtension: number;
  version: number;
  currentNext: boolean;
  protocolVersion: number;
  etmId: number;
  sourceId: number;
  kind: 'event' | 'channel';
  eventId?: number;
  text: string;
  crcValid: boolean;
}

export function parseAtscStt(data: Uint8Array): AtscStt | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId !== 0xcd) return null;

  const protocolVersion = readU8(data, 8);
  const gpsSeconds = readU32(data, 9);
  const gpsUtcOffset = readU8(data, 13);
  const daylightSavingWord = readU16(data, 14);
  const daylightSaving = (daylightSavingWord & 0x8000) !== 0;
  const timeZoneOffset = signExtend5((daylightSavingWord >> 8) & 0x1f);

  return {
    tableId: header.tableId,
    version: header.version,
    currentNext: header.currentNext,
    protocolVersion,
    gpsSeconds,
    gpsUtcOffset,
    utcIso: new Date(gpsToUnixSeconds(gpsSeconds, gpsUtcOffset) * 1000).toISOString(),
    daylightSaving,
    ...(timeZoneOffset !== 0 ? { timeZoneOffset } : {}),
    descriptors: descriptorsFrom(data, 16, header.totalLength - 4),
    crcValid: header.crcValid,
  };
}

export function parseAtscMgt(data: Uint8Array): AtscMgt | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId !== 0xc7) return null;

  const end = header.totalLength - 4;
  const protocolVersion = readU8(data, 8);
  const tablesDefined = readU16(data, 9);
  const tables: AtscMgtTable[] = [];
  let cursor = 11;

  for (let i = 0; i < tablesDefined && cursor + 11 <= end; i += 1) {
    const tableType = readU16(data, cursor);
    const pid = readU16(data, cursor + 2) & 0x1fff;
    const version = readU8(data, cursor + 4) >> 3;
    const numberOfBytes = readU32(data, cursor + 5);
    const descriptorLength = readU16(data, cursor + 9) & 0x0fff;
    const descriptorStart = cursor + 11;
    const descriptors = descriptorsFrom(
      data,
      descriptorStart,
      Math.min(descriptorLength, Math.max(0, end - descriptorStart)),
    );
    tables.push({
      tableType,
      tableTypeHex: `0x${tableType.toString(16).padStart(4, '0').toUpperCase()}`,
      name: atscTableTypeName(tableType),
      pid,
      version,
      numberOfBytes,
      descriptors,
    });
    cursor = descriptorStart + descriptorLength;
  }

  return {
    tableId: header.tableId,
    version: header.version,
    currentNext: header.currentNext,
    protocolVersion,
    tables,
    descriptors: descriptorsFrom(data, cursor, Math.max(0, end - cursor)),
    crcValid: header.crcValid,
  };
}

export function parseAtscVct(data: Uint8Array): AtscVct | null {
  const header = parseLongSectionHeader(data);
  if (!header || (header.tableId !== 0xc8 && header.tableId !== 0xc9)) return null;
  const cable = header.tableId === 0xc9;

  const end = header.totalLength - 4;
  const protocolVersion = readU8(data, 8);
  const numChannels = readU8(data, 9);
  const reader = new BitReader(data, 10 * 8);
  const channels: AtscChannel[] = [];

  for (let i = 0; i < numChannels; i += 1) {
    if (reader.byteOffset + 32 > end) break;

    const nameUnits: number[] = [];
    for (let unit = 0; unit < 7; unit += 1) nameUnits.push(reader.read(16));
    const shortName = decodeUtf16Units(nameUnits);

    reader.read(4); // reserved
    const majorChannelNumber = reader.read(10);
    const minorChannelNumber = reader.read(10);
    const modulationMode = reader.read(8);
    const carrierFrequency = reader.read(32);
    const channelTsid = reader.read(16);
    const programNumber = reader.read(16);

    const etmLocation = reader.read(2);
    const accessControlled = reader.read(1) !== 0;
    const hidden = reader.read(1) !== 0;
    let pathSelect: boolean | undefined;
    let outOfBand: boolean | undefined;
    if (cable) {
      pathSelect = reader.read(1) !== 0;
      outOfBand = reader.read(1) !== 0;
    } else {
      reader.read(2); // reserved
    }
    const hideGuide = reader.read(1) !== 0;
    reader.read(cable ? 2 : 3); // reserved

    const serviceType = reader.read(6);
    const sourceId = reader.read(16);
    reader.read(6); // reserved
    const descriptorLength = reader.read(10);
    reader.align();

    const descriptorStart = reader.byteOffset;
    const descriptors = descriptorsFrom(
      data,
      descriptorStart,
      Math.min(descriptorLength, Math.max(0, end - descriptorStart)),
    );
    reader.skipBytes(descriptorLength);

    channels.push({
      ...(shortName ? { shortName } : {}),
      majorChannelNumber,
      minorChannelNumber,
      modulationMode,
      ...(carrierFrequency !== 0 ? { carrierFrequency } : {}),
      channelTsid,
      programNumber,
      etmLocation,
      accessControlled,
      hidden,
      hideGuide,
      ...(pathSelect !== undefined ? { pathSelect } : {}),
      ...(outOfBand !== undefined ? { outOfBand } : {}),
      serviceType,
      sourceId,
      descriptors,
    });
  }

  reader.read(6); // reserved
  const additionalLength = reader.read(10);
  reader.align();
  const additionalStart = reader.byteOffset;
  const additionalDescriptors = descriptorsFrom(
    data,
    additionalStart,
    Math.min(additionalLength, Math.max(0, end - additionalStart)),
  );

  return {
    tableId: header.tableId,
    kind: cable ? 'CVCT' : 'TVCT',
    transportStreamId: header.tableIdExtension,
    version: header.version,
    currentNext: header.currentNext,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    protocolVersion,
    channels,
    additionalDescriptors,
    crcValid: header.crcValid,
  };
}

export function parseAtscEit(data: Uint8Array, gpsUtcOffset = 0): AtscEit | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId !== 0xcb) return null;

  const end = header.totalLength - 4;
  const protocolVersion = readU8(data, 8);
  const numEvents = readU8(data, 9);
  const events: AtscEitEvent[] = [];
  let cursor = 10;

  for (let i = 0; i < numEvents && cursor + 12 <= end; i += 1) {
    const eventId = readU16(data, cursor) & 0x3fff;
    const startGps = readU32(data, cursor + 2);
    const etmLocation = (readU8(data, cursor + 6) >> 4) & 0x03;
    const durationSec = readU24(data, cursor + 6) & 0x0fffff;
    const titleLength = readU8(data, cursor + 9);
    const titleStart = cursor + 10;
    const titleEnd = Math.min(end, titleStart + titleLength);
    const title = titleLength > 0
      ? decodeAtscMultipleString(data.subarray(titleStart, titleEnd))
      : '';
    cursor = titleEnd;

    const descriptorLength = readU16(data, cursor) & 0x0fff;
    const descriptorStart = cursor + 2;
    const descriptors = descriptorsFrom(
      data,
      descriptorStart,
      Math.min(descriptorLength, Math.max(0, end - descriptorStart)),
    );
    cursor = descriptorStart + descriptorLength;

    events.push({
      eventId,
      startGps,
      startTimeIso: new Date(
        (GPS_UNIX_EPOCH + startGps - gpsUtcOffset) * 1000,
      ).toISOString(),
      etmLocation,
      durationSec,
      ...(durationSec > 0
        ? {
            endTimeIso: new Date(
              (GPS_UNIX_EPOCH + startGps - gpsUtcOffset + durationSec) * 1000,
            ).toISOString(),
          }
        : {}),
      ...(title ? { title } : {}),
      descriptors,
    });
  }

  return {
    tableId: header.tableId,
    sourceId: header.tableIdExtension,
    version: header.version,
    currentNext: header.currentNext,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    protocolVersion,
    events,
    crcValid: header.crcValid,
  };
}

export function parseAtscEtt(data: Uint8Array): AtscEtt | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId !== 0xcc) return null;

  const end = header.totalLength - 4;
  const protocolVersion = readU8(data, 8);
  const etmId = readU32(data, 9);
  const sourceId = (etmId >>> 16) & 0xffff;
  const isEvent = (etmId & 0x02) !== 0;
  const text = decodeAtscMultipleString(data.subarray(13, end));

  return {
    tableId: header.tableId,
    tableIdExtension: header.tableIdExtension,
    version: header.version,
    currentNext: header.currentNext,
    protocolVersion,
    etmId,
    sourceId,
    kind: isEvent ? 'event' : 'channel',
    ...(isEvent ? { eventId: (etmId >>> 2) & 0x3fff } : {}),
    text,
    crcValid: header.crcValid,
  };
}

/**
 * ATSC Rating Region Table (RRT), table_id 0xCA (A/65).
 *
 * table_id_extension = 0xFF00 | rating_region, so RRT5 carries rating_region 5.
 * The body holds the region name, each rating dimension with its abbreviated and
 * full value strings, and a trailing descriptor loop.
 */
export function parseAtscRrt(data: Uint8Array): ProbeRatingRegion | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId !== 0xca) return null;

  const end = header.totalLength - 4;
  let cursor = 8;
  if (cursor >= end) return null;

  const protocolVersion = readU8(data, cursor);
  cursor += 1;

  const nameLength = readU8(data, cursor);
  cursor += 1;
  if (cursor + nameLength > end) return null;
  const name =
    nameLength > 0
      ? decodeAtscMultipleString(data.subarray(cursor, cursor + nameLength))
      : '';
  cursor += nameLength;

  if (cursor >= end) return null;
  const dimensionsDefined = readU8(data, cursor);
  cursor += 1;
  const dimensions: ProbeRatingDimension[] = [];

  for (let i = 0; i < dimensionsDefined && cursor < end; i += 1) {
    if (cursor + 1 > end) break;
    const dimensionNameLength = readU8(data, cursor);
    cursor += 1;
    if (cursor + dimensionNameLength > end) break;
    const dimensionName =
      dimensionNameLength > 0
        ? decodeAtscMultipleString(
            data.subarray(cursor, cursor + dimensionNameLength),
          )
        : '';
    cursor += dimensionNameLength;

    if (cursor + 1 > end) break;
    const flags = readU8(data, cursor);
    cursor += 1;
    const graduatedScale = (flags & 0x10) !== 0;
    const valuesDefined = flags & 0x0f;
    const values: ProbeRatingValue[] = [];

    for (let j = 0; j < valuesDefined && cursor < end; j += 1) {
      const abbrevLength = readU8(data, cursor);
      cursor += 1;
      if (cursor + abbrevLength > end) break;
      const abbrev =
        abbrevLength > 0
          ? decodeAtscMultipleString(data.subarray(cursor, cursor + abbrevLength))
          : '';
      cursor += abbrevLength;

      if (cursor + 1 > end) break;
      const textLength = readU8(data, cursor);
      cursor += 1;
      if (cursor + textLength > end) break;
      const text =
        textLength > 0
          ? decodeAtscMultipleString(data.subarray(cursor, cursor + textLength))
          : '';
      cursor += textLength;

      values.push({ abbrev, text });
    }

    dimensions.push({ name: dimensionName, graduatedScale, values });
  }

  let descriptors: DescriptorInfo[] = [];
  if (cursor + 2 <= end) {
    const descriptorsLength = readU16(data, cursor) & 0x03ff;
    cursor += 2;
    const descriptorEnd = Math.min(end, cursor + descriptorsLength);
    descriptors = describeDescriptors(
      parseRawDescriptors(data, cursor, descriptorEnd - cursor),
    );
  }

  return {
    ratingRegion: header.tableIdExtension & 0xff,
    protocolVersion,
    name,
    dimensions,
    descriptors,
  };
}

/** Human-readable name for an MGT table_type value (ATSC A/65). */
export function atscTableTypeName(tableType: number): string {
  switch (tableType) {
    case 0x0000:
      return 'TVCT-current';
    case 0x0001:
      return 'CVCT-current';
    case 0x0002:
      return 'TVCT-next';
    case 0x0003:
      return 'CVCT-next';
    case 0x0004:
      return 'ETT (event)';
    case 0x0005:
      return 'ETT (channel)';
    default:
      break;
  }
  if (tableType >= 0x0100 && tableType <= 0x017f) return `EIT-${tableType - 0x0100}`;
  if (tableType >= 0x0200 && tableType <= 0x027f) return `ETT-${tableType - 0x0200}`;
  if (tableType >= 0x0300 && tableType <= 0x03ff) return `RRT-${tableType - 0x0300}`;
  if (tableType <= 0x00ff) return `ATSC reserved (0x${tableType.toString(16).padStart(4, '0').toUpperCase()})`;
  if (tableType >= 0x0400 && tableType <= 0x0fff) return 'User private';
  return `Private (0x${tableType.toString(16).padStart(4, '0').toUpperCase()})`;
}

class BitReader {
  private position: number;

  constructor(
    private readonly data: Uint8Array,
    bitOffset = 0,
  ) {
    this.position = bitOffset;
  }

  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const byteIndex = this.position >> 3;
      if (byteIndex >= this.data.length) {
        value <<= 1;
        this.position += 1;
        continue;
      }
      const bit = ((this.data[byteIndex] as number) >> (7 - (this.position & 7))) & 1;
      value = (value << 1) | bit;
      this.position += 1;
    }
    return value;
  }

  skipBytes(count: number): void {
    this.position += count * 8;
  }

  align(): void {
    this.position = (this.position + 7) & ~7;
  }

  get byteOffset(): number {
    return this.position >> 3;
  }
}

function descriptorsFrom(
  data: Uint8Array,
  start: number,
  length: number,
): DescriptorInfo[] {
  if (length <= 0 || start >= data.length) return [];
  return describeDescriptors(parseRawDescriptors(data, start, length));
}

function decodeUtf16Units(units: number[]): string {
  let out = '';
  for (const unit of units) {
    if (unit === 0) break;
    out += String.fromCharCode(unit);
  }
  return out.replace(/\s+$/g, '');
}

function signExtend5(value: number): number {
  return value & 0x10 ? value - 0x20 : value;
}
