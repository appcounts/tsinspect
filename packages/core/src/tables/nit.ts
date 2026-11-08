import type { DescriptorInfo } from '../model/types.js';
import {
  describeDescriptors,
  parseRawDescriptors,
  type TextEncoding,
} from '../descriptors/descriptor.js';
import { readU16 } from '../util/bytes.js';
import { parseLongSectionHeader } from './common.js';

export interface NitTransportStream {
  transportStreamId: number;
  originalNetworkId: number;
  descriptors: DescriptorInfo[];
}

export interface NitSection {
  tableId: number;
  networkId: number;
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  networkName?: string;
  networkDescriptors: DescriptorInfo[];
  transports: NitTransportStream[];
  crcValid: boolean;
}

export function parseNit(
  data: Uint8Array,
  textEncoding: TextEncoding = 'dvb',
): NitSection | null {
  const header = parseLongSectionHeader(data);
  if (!header || (header.tableId !== 0x40 && header.tableId !== 0x41)) return null;

  const end = header.totalLength - 4;
  if (end < 10) return null;

  const networkDescriptorLength = readU16(data, 8) & 0x0fff;
  const networkDescriptorStart = 10;
  const networkDescriptorEnd = Math.min(end, networkDescriptorStart + networkDescriptorLength);

  const networkDescriptors = describeDescriptors(
    parseRawDescriptors(
      data,
      networkDescriptorStart,
      networkDescriptorEnd - networkDescriptorStart,
    ),
    textEncoding,
  );

  const nameDescriptor = networkDescriptors.find((descriptor) => descriptor.tag === 0x40);

  const transports: NitTransportStream[] = [];
  let cursor = networkDescriptorEnd;
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
    networkId: header.tableIdExtension,
    version: header.version,
    currentNext: header.currentNext,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    ...(nameDescriptor?.fields?.name !== undefined
      ? { networkName: String(nameDescriptor.fields.name) }
      : {}),
    networkDescriptors,
    transports,
    crcValid: header.crcValid,
  };
}
