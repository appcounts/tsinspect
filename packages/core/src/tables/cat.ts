import type { DescriptorInfo } from '../model/types.js';
import {
  describeDescriptors,
  parseRawDescriptors,
  type TextEncoding,
} from '../descriptors/descriptor.js';
import { readU16 } from '../util/bytes.js';
import { parseLongSectionHeader } from './common.js';

export interface CatSection {
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  descriptors: DescriptorInfo[];
  crcValid: boolean;
}

/** MPEG-2 Conditional Access Table (ISO/IEC 13818-1, 2.4.4.5). */
export function parseCat(
  data: Uint8Array,
  textEncoding: TextEncoding = 'dvb',
): CatSection | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId !== 0x01) return null;

  const end = header.totalLength - 4;
  if (end < 10) return null;

  const descriptorLength = readU16(data, 8) & 0x0fff;
  const descriptorStart = 10;
  const descriptorEnd = Math.min(end, descriptorStart + descriptorLength);
  return {
    version: header.version,
    currentNext: header.currentNext,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    descriptors: describeDescriptors(
      parseRawDescriptors(data, descriptorStart, descriptorEnd - descriptorStart),
      textEncoding,
    ),
    crcValid: header.crcValid,
  };
}
