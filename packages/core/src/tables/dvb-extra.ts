import type { DescriptorInfo } from '../model/types.js';
import {
  describeDescriptors,
  parseRawDescriptors,
  type TextEncoding,
} from '../descriptors/descriptor.js';
import { hex, readU16, readU24, readU32, readU8 } from '../util/bytes.js';
import { parseLongSectionHeader, parseShortSectionHeader } from './common.js';

const RUNNING_STATUS = ['undefined', 'not running', 'starts in a few seconds', 'pausing', 'running', 'off air'];

export interface BatTransportStream {
  transportStreamId: number;
  originalNetworkId: number;
  descriptors: DescriptorInfo[];
}

export interface BatSection {
  tableId: number;
  bouquetId: number;
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  bouquetName?: string;
  bouquetDescriptors: DescriptorInfo[];
  transports: BatTransportStream[];
  crcValid: boolean;
}

/** DVB Bouquet Association Table (ETSI EN 300 468, 5.2.2). */
export function parseBat(
  data: Uint8Array,
  textEncoding: TextEncoding = 'dvb',
): BatSection | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId !== 0x4a) return null;

  const end = header.totalLength - 4;
  if (end < 10) return null;

  let cursor = 8;
  const bouquetDescriptorLength = readU16(data, cursor) & 0x0fff;
  cursor += 2;
  const bouquetEnd = Math.min(end, cursor + bouquetDescriptorLength);
  const bouquetDescriptors = describeDescriptors(
    parseRawDescriptors(data, cursor, bouquetEnd - cursor),
    textEncoding,
  );
  const nameDescriptor = bouquetDescriptors.find((descriptor) => descriptor.tag === 0x47);

  cursor = bouquetEnd;
  const transports: BatTransportStream[] = [];
  if (cursor + 2 <= end) {
    const transportLoopLength = readU16(data, cursor) & 0x0fff;
    cursor += 2;
    const transportEnd = Math.min(end, cursor + transportLoopLength);
    while (cursor + 6 <= transportEnd) {
      const transportStreamId = readU16(data, cursor);
      const originalNetworkId = readU16(data, cursor + 2);
      const descriptorLength = readU16(data, cursor + 4) & 0x0fff;
      const descriptorStart = cursor + 6;
      const descriptorEnd = Math.min(transportEnd, descriptorStart + descriptorLength);
      transports.push({
        transportStreamId,
        originalNetworkId,
        descriptors: describeDescriptors(
          parseRawDescriptors(data, descriptorStart, descriptorEnd - descriptorStart),
          textEncoding,
        ),
      });
      cursor = descriptorEnd;
    }
  }

  return {
    tableId: header.tableId,
    bouquetId: header.tableIdExtension,
    version: header.version,
    currentNext: header.currentNext,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    ...(nameDescriptor?.fields?.name !== undefined
      ? { bouquetName: String(nameDescriptor.fields.name) }
      : {}),
    bouquetDescriptors,
    transports,
    crcValid: header.crcValid,
  };
}

export interface RstEntry {
  serviceId: number;
  eventId: number;
  runningStatus: number;
  runningStatusName?: string;
}

export interface RstSection {
  tableId: number;
  entries: RstEntry[];
}

/** DVB Running Status Table (ETSI EN 300 468, 5.2.7). */
export function parseRst(data: Uint8Array): RstSection | null {
  const header = parseShortSectionHeader(data);
  if (!header || header.tableId !== 0x71) return null;

  const entries: RstEntry[] = [];
  let cursor = 3;
  while (cursor + 5 <= header.totalLength) {
    const serviceId = readU16(data, cursor);
    const eventId = readU16(data, cursor + 2);
    const runningStatus = (readU8(data, cursor + 4) >> 5) & 0x07;
    entries.push({
      serviceId,
      eventId,
      runningStatus,
      ...(runningStatus > 0 && RUNNING_STATUS[runningStatus] !== undefined
        ? { runningStatusName: RUNNING_STATUS[runningStatus] as string }
        : {}),
    });
    cursor += 5;
  }

  return { tableId: header.tableId, entries };
}

export interface AitApplication {
  organizationId: number;
  applicationId: number;
  controlCode: number;
  descriptors: DescriptorInfo[];
}

export interface AitSection {
  applicationType: number;
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  commonDescriptors: DescriptorInfo[];
  applications: AitApplication[];
  crcValid: boolean;
}
export function parseAit(
  data: Uint8Array,
  textEncoding: TextEncoding = 'dvb',
): AitSection | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId !== 0x74) return null;

  const end = header.totalLength - 4;
  if (end < 10) return null;

  let cursor = 8;
  const commonDescriptorLength = readU16(data, cursor) & 0x0fff;
  cursor += 2;
  const commonEnd = Math.min(end, cursor + commonDescriptorLength);
  const commonDescriptors = describeDescriptors(
    parseRawDescriptors(data, cursor, commonEnd - cursor),
    textEncoding,
  );

  cursor = commonEnd;
  const applications: AitApplication[] = [];
  if (cursor + 2 <= end) {
    const applicationLoopLength = readU16(data, cursor) & 0x0fff;
    cursor += 2;
    const applicationEnd = Math.min(end, cursor + applicationLoopLength);
    while (cursor + 9 <= applicationEnd) {
      const organizationId = readU32(data, cursor);
      const applicationId = readU16(data, cursor + 4);
      const controlCode = readU8(data, cursor + 6);
      const descriptorLength = readU16(data, cursor + 7) & 0x0fff;
      const descriptorStart = cursor + 9;
      const descriptorEnd = Math.min(applicationEnd, descriptorStart + descriptorLength);
      applications.push({
        organizationId,
        applicationId,
        controlCode,
        descriptors: describeDescriptors(
          parseRawDescriptors(data, descriptorStart, descriptorEnd - descriptorStart),
          textEncoding,
        ),
      });
      cursor = descriptorEnd;
    }
  }

  return {
    applicationType: header.tableIdExtension,
    version: header.version,
    currentNext: header.currentNext,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    commonDescriptors,
    applications,
    crcValid: header.crcValid,
  };
}

export interface SitService {
  serviceId: number;
  runningStatus: number;
  runningStatusName?: string;
  descriptors: DescriptorInfo[];
}

export interface SitSection {
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  transmissionInfoDescriptors: DescriptorInfo[];
  services: SitService[];
  crcValid: boolean;
}

/** DVB Selection Information Table (ETSI EN 300 468, 7.1.2). */
export function parseSit(
  data: Uint8Array,
  textEncoding: TextEncoding = 'dvb',
): SitSection | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId !== 0x7f) return null;

  const end = header.totalLength - 4;
  if (end < 10) return null;

  let cursor = 8;
  const transmissionInfoLength = readU16(data, cursor) & 0x0fff;
  cursor += 2;
  const transmissionInfoEnd = Math.min(end, cursor + transmissionInfoLength);
  const transmissionInfoDescriptors = describeDescriptors(
    parseRawDescriptors(data, cursor, transmissionInfoEnd - cursor),
    textEncoding,
  );

  const services: SitService[] = [];
  cursor = transmissionInfoEnd;
  while (cursor + 4 <= end) {
    const serviceId = readU16(data, cursor);
    const flags = readU8(data, cursor + 2);
    const runningStatus = (flags >> 4) & 0x07;
    const descriptorLength = ((flags & 0x0f) << 8) | readU8(data, cursor + 3);
    const descriptorStart = cursor + 4;
    const descriptorEnd = Math.min(end, descriptorStart + descriptorLength);
    services.push({
      serviceId,
      runningStatus,
      ...(runningStatus > 0 && RUNNING_STATUS[runningStatus] !== undefined
        ? { runningStatusName: RUNNING_STATUS[runningStatus] as string }
        : {}),
      descriptors: describeDescriptors(
        parseRawDescriptors(data, descriptorStart, descriptorEnd - descriptorStart),
        textEncoding,
      ),
    });
    cursor = descriptorEnd;
  }

  return {
    version: header.version,
    currentNext: header.currentNext,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    transmissionInfoDescriptors,
    services,
    crcValid: header.crcValid,
  };
}

export interface DitSection {
  tableId: number;
  bytes: number;
  dataHex: string;
}

/**
 * DVB Discontinuity Information Table (ETSI EN 300 468, 7.1.1).
 * Short section with an unspecified payload; exposed for completeness.
 */
export function parseDit(data: Uint8Array): DitSection | null {
  const header = parseShortSectionHeader(data);
  if (!header || header.tableId !== 0x7e) return null;
  const payload = data.subarray(3, header.totalLength);
  return { tableId: header.tableId, bytes: payload.length, dataHex: hex(payload) };
}

export interface SsuSection {
  groupId: number;
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  descriptors: DescriptorInfo[];
  crcValid: boolean;
  payloadBytes: number;
}

/**
 * System Software Update table (ETSI TS 102 006, 5.2). The group id is the
 * table id extension; the body carries a descriptor loop.
 */
export function parseSsu(
  data: Uint8Array,
  textEncoding: TextEncoding = 'dvb',
): SsuSection | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId !== 0xa0) return null;

  const end = header.totalLength - 4;
  if (end < 10) return null;

  const descriptorLength = readU16(data, 8) & 0x0fff;
  const descriptorStart = 10;
  const descriptorEnd = Math.min(end, descriptorStart + descriptorLength);
  return {
    groupId: header.tableIdExtension,
    version: header.version,
    currentNext: header.currentNext,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    descriptors: describeDescriptors(
      parseRawDescriptors(data, descriptorStart, descriptorEnd - descriptorStart),
      textEncoding,
    ),
    crcValid: header.crcValid,
    payloadBytes: Math.max(0, end - descriptorEnd),
  };
}

export interface IntDevice {
  deviceId: number;
  descriptors: DescriptorInfo[];
}

export interface IntSection {
  actionType: number;
  platformId: number;
  processingOrder: number;
  platformDescriptors: DescriptorInfo[];
  devices: IntDevice[];
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  crcValid: boolean;
}

/** DVB IP/MAC Notification Table (ETSI EN 301 192, 8.4). */
export function parseIntTable(
  data: Uint8Array,
  textEncoding: TextEncoding = 'dvb',
): IntSection | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId !== 0x4c) return null;

  const end = header.totalLength - 4;
  if (end < 13) return null;

  const actionType = readU8(data, 8);
  const platformId = readU24(data, 9);
  const processingOrder = readU8(data, 12);

  let cursor = 13;
  const platformDescriptorLength = readU16(data, cursor) & 0x0fff;
  cursor += 2;
  const platformEnd = Math.min(end, cursor + platformDescriptorLength);
  const platformDescriptors = describeDescriptors(
    parseRawDescriptors(data, cursor, platformEnd - cursor),
    textEncoding,
  );

  const devices: IntDevice[] = [];
  cursor = platformEnd;
  while (cursor + 3 <= end) {
    const deviceId = readU8(data, cursor);
    const descriptorLength = readU16(data, cursor + 1) & 0x0fff;
    const descriptorStart = cursor + 3;
    const descriptorEnd = Math.min(end, descriptorStart + descriptorLength);
    devices.push({
      deviceId,
      descriptors: describeDescriptors(
        parseRawDescriptors(data, descriptorStart, descriptorEnd - descriptorStart),
        textEncoding,
      ),
    });
    cursor = descriptorEnd;
  }

  return {
    actionType,
    platformId,
    processingOrder,
    platformDescriptors,
    devices,
    version: header.version,
    currentNext: header.currentNext,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    crcValid: header.crcValid,
  };
}
