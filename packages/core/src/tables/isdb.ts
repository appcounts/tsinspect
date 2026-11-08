import type { DescriptorInfo } from '../model/types.js';
import {
  describeDescriptors,
  parseRawDescriptors,
  type TextEncoding,
} from '../descriptors/descriptor.js';
import { hex, readU16, readU8 } from '../util/bytes.js';
import { decodeAribString } from '../descriptors/arib-string.js';
import { parseLongSectionHeader } from './common.js';

export interface BitBroadcaster {
  broadcasterId: number;
  descriptors: DescriptorInfo[];
}

export interface BitSection {
  originalNetworkId: number;
  broadcastViewPropriety: boolean;
  descriptors: DescriptorInfo[];
  broadcasters: BitBroadcaster[];
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  crcValid: boolean;
}

/**
 * ISDB Broadcaster Information Table (ARIB STD-B10, 5.2.13).
 *
 * table_id_extension is original_network_id. After the 8-byte long-section
 * header:
 *   reserved(3) | broadcast_view_propriety(1) | first_descriptors_length(12)
 *   descriptors...
 *   broadcaster_id(8) | reserved(4) | broadcaster_descriptors_length(12) | ...
 */
export function parseBit(
  data: Uint8Array,
  textEncoding: TextEncoding = 'arib',
): BitSection | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId !== 0xc4) return null;

  const end = header.totalLength - 4;
  if (end < 11) return null;

  const flags = readU8(data, 8);
  const broadcastViewPropriety = (flags & 0x10) !== 0;
  const firstDescriptorLength = ((flags & 0x0f) << 8) | readU8(data, 9);
  let cursor = 10;
  const firstEnd = Math.min(end, cursor + firstDescriptorLength);
  const descriptors = describeDescriptors(
    parseRawDescriptors(data, cursor, firstEnd - cursor),
    textEncoding,
  );

  const broadcasters: BitBroadcaster[] = [];
  cursor = firstEnd;
  while (cursor + 3 <= end) {
    const broadcasterId = readU8(data, cursor);
    const descriptorLength = ((readU8(data, cursor + 1) & 0x0f) << 8) | readU8(data, cursor + 2);
    const descriptorStart = cursor + 3;
    const descriptorEnd = Math.min(end, descriptorStart + descriptorLength);
    broadcasters.push({
      broadcasterId,
      descriptors: describeDescriptors(
        parseRawDescriptors(data, descriptorStart, descriptorEnd - descriptorStart),
        textEncoding,
      ),
    });
    cursor = descriptorEnd;
  }

  return {
    originalNetworkId: header.tableIdExtension,
    broadcastViewPropriety,
    descriptors,
    broadcasters,
    version: header.version,
    currentNext: header.currentNext,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    crcValid: header.crcValid,
  };
}

export interface LdtDescription {
  descriptionId: number;
  descriptors: DescriptorInfo[];
}

export interface LdtSection {
  originalServiceId: number;
  transportStreamId: number;
  originalNetworkId: number;
  descriptions: LdtDescription[];
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  crcValid: boolean;
}

/**
 * ISDB Linked Description Table (ARIB STD-B10, 5.2.15 / ABNT NBR 15603-2).
 *
 * After the 8-byte long-section header:
 *   transport_stream_id(16) | original_network_id(16)
 *   description_id(16) | reserved(4) | descriptors_loop_length(12) | ...
 */
export function parseLdt(
  data: Uint8Array,
  textEncoding: TextEncoding = 'arib',
): LdtSection | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId !== 0xc7) return null;

  const end = header.totalLength - 4;
  if (end < 12) return null;

  const transportStreamId = readU16(data, 8);
  const originalNetworkId = readU16(data, 10);
  const descriptions: LdtDescription[] = [];
  let cursor = 12;

  while (cursor + 4 <= end) {
    const descriptionId = readU16(data, cursor);
    const descriptorLength = ((readU8(data, cursor + 2) & 0x0f) << 8) | readU8(data, cursor + 3);
    const descriptorStart = cursor + 4;
    const descriptorEnd = Math.min(end, descriptorStart + descriptorLength);
    descriptions.push({
      descriptionId,
      descriptors: describeDescriptors(
        parseRawDescriptors(data, descriptorStart, descriptorEnd - descriptorStart),
        textEncoding,
      ),
    });
    cursor = descriptorEnd;
  }

  return {
    originalServiceId: header.tableIdExtension,
    transportStreamId,
    originalNetworkId,
    descriptions,
    version: header.version,
    currentNext: header.currentNext,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    crcValid: header.crcValid,
  };
}

export interface SdttSection {
  transportStreamId: number;
  originalNetworkId: number;
  serviceId: number;
  contentCount: number;
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  crcValid: boolean;
}

/**
 * ISDB Software Download Trigger Table header (ARIB STD-B53 / STD-B21).
 * The content and schedule loops are left as raw payload for now.
 */
export function parseSdtt(data: Uint8Array): SdttSection | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId !== 0xc3) return null;

  const end = header.totalLength - 4;
  if (end < 15) return null;

  return {
    transportStreamId: readU16(data, 8),
    originalNetworkId: readU16(data, 10),
    serviceId: readU16(data, 12),
    contentCount: readU8(data, 14),
    version: header.version,
    currentNext: header.currentNext,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    crcValid: header.crcValid,
  };
}

export interface NbitSection {
  originalNetworkId: number;
  networkName?: string;
  descriptors: DescriptorInfo[];
  broadcasters: BitBroadcaster[];
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  crcValid: boolean;
}

/**
 * ISDB Network Board Information Table (ARIB STD-B10, 5.2.14).
 * table_id_extension is original_network_id; the body starts with a network
 * name followed by the broadcaster loop shared with the BIT.
 */
export function parseNbit(
  data: Uint8Array,
  textEncoding: TextEncoding = 'arib',
): NbitSection | null {
  const header = parseLongSectionHeader(data);
  if (!header || (header.tableId !== 0xc5 && header.tableId !== 0xc6)) return null;

  const end = header.totalLength - 4;
  if (end < 11) return null;

  const nameLength = readU16(data, 8) & 0x0fff;
  let cursor = Math.min(end, 10 + nameLength);
  const networkName =
    nameLength > 0 ? decodeNbitName(data.subarray(10, 10 + nameLength), textEncoding) : undefined;

  const descriptors: DescriptorInfo[] = [];
  if (cursor + 2 <= end) {
    const firstLength = readU16(data, cursor) & 0x0fff;
    const firstStart = cursor + 2;
    const firstEnd = Math.min(end, firstStart + firstLength);
    descriptors.push(
      ...describeDescriptors(
        parseRawDescriptors(data, firstStart, firstEnd - firstStart),
        textEncoding,
      ),
    );
    cursor = firstEnd;
  }

  const broadcasters: BitBroadcaster[] = [];
  while (cursor + 3 <= end) {
    const broadcasterId = readU8(data, cursor);
    const descriptorLength = readU16(data, cursor + 1) & 0x0fff;
    const descriptorStart = cursor + 3;
    const descriptorEnd = Math.min(end, descriptorStart + descriptorLength);
    broadcasters.push({
      broadcasterId,
      descriptors: describeDescriptors(
        parseRawDescriptors(data, descriptorStart, descriptorEnd - descriptorStart),
        textEncoding,
      ),
    });
    cursor = descriptorEnd;
  }

  return {
    originalNetworkId: header.tableIdExtension,
    ...(networkName !== undefined ? { networkName } : {}),
    descriptors,
    broadcasters,
    version: header.version,
    currentNext: header.currentNext,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    crcValid: header.crcValid,
  };
}

function decodeNbitName(value: Uint8Array, encoding: TextEncoding): string {
  if (encoding === 'dvb') return new TextDecoder('latin1').decode(value);
  return decodeAribString(value, encoding === 'sbtvd' ? { profile: 'brazil' } : undefined);
}

export interface CdtSection {
  originalNetworkId: number;
  dataType: number;
  dataModuleLength: number;
  dataModuleHex: string;
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  crcValid: boolean;
}

/**
 * ISDB Common Data Table header (ARIB STD-B21, 12.2.2.2).
 * The data module carries logo marks or other receiver-stored data.
 */
export function parseCdt(data: Uint8Array): CdtSection | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId !== 0xc8) return null;

  const end = header.totalLength - 4;
  if (end < 11) return null;

  const dataType = readU8(data, 10);
  const dataModuleStart = 11;
  return {
    originalNetworkId: readU16(data, 8),
    dataType,
    dataModuleLength: Math.max(0, end - dataModuleStart),
    dataModuleHex: hex(data.subarray(dataModuleStart, end)),
    version: header.version,
    currentNext: header.currentNext,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    crcValid: header.crcValid,
  };
}
