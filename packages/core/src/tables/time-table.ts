import type { DescriptorInfo } from '../model/types.js';
import {
  describeDescriptors,
  parseRawDescriptors,
} from '../descriptors/descriptor.js';
import { readU16 } from '../util/bytes.js';
import { isSectionCrcValid } from '../section/crc32.js';
import { parseDvbDateTime, type DvbDateTime } from '../util/time.js';

export interface TimeTable {
  tableId: number;
  name: string;
  utc?: DvbDateTime;
  localTimeOffsetDescriptors: DescriptorInfo[];
  crcValid?: boolean;
}

/** TDT (0x70) and TOT (0x73) carry the current UTC time. */
export function parseTimeTable(data: Uint8Array): TimeTable | null {
  if (data.length < 8) return null;
  const tableId = data[0] as number;
  const sectionLength = ((data[1] as number) & 0x0f) << 8 | (data[2] as number);
  const totalLength = 3 + sectionLength;
  if (totalLength > data.length) return null;

  if (tableId === 0x70) {
    if (sectionLength < 5) return null;
    const utc = parseDvbDateTime(data, 3) ?? undefined;
    return {
      tableId,
      name: 'TDT',
      ...(utc ? { utc } : {}),
      localTimeOffsetDescriptors: [],
    };
  }

  if (tableId === 0x73) {
    if (sectionLength < 11) return null;
    const utc = parseDvbDateTime(data, 3) ?? undefined;
    const descriptorLength = readU16(data, 8) & 0x0fff;
    const descriptorStart = 10;
    const descriptorEnd = Math.min(totalLength - 4, descriptorStart + descriptorLength);
    const localTimeOffsetDescriptors = describeDescriptors(
      parseRawDescriptors(data, descriptorStart, descriptorEnd - descriptorStart),
    );
    return {
      tableId,
      name: 'TOT',
      ...(utc ? { utc } : {}),
      localTimeOffsetDescriptors,
      crcValid: isSectionCrcValid(data.subarray(0, totalLength)),
    };
  }

  return null;
}

export function parseTdt(data: Uint8Array): TimeTable | null {
  return data[0] === 0x70 ? parseTimeTable(data) : null;
}

export function parseTot(data: Uint8Array): TimeTable | null {
  return data[0] === 0x73 ? parseTimeTable(data) : null;
}
