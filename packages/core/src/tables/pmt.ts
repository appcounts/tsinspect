import type { DescriptorInfo } from '../model/types.js';
import {
  describeDescriptors,
  parseRawDescriptors,
  type RawDescriptor,
  type TextEncoding,
} from '../descriptors/descriptor.js';
import { streamTypeName } from '../ts/packet.js';
import { readU16, readU8 } from '../util/bytes.js';
import { parseLongSectionHeader } from './common.js';

export interface PmtStream {
  streamType: number;
  pid: number;
  esInfoLength: number;
  descriptors: DescriptorInfo[];
}

export interface PmtSection {
  tableId: number;
  programNumber: number;
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  pcrPid: number;
  programInfoLength: number;
  programDescriptors: DescriptorInfo[];
  streams: PmtStream[];
  crcValid: boolean;
}

export function parsePmt(
  data: Uint8Array,
  textEncoding: TextEncoding = 'dvb',
): PmtSection | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId !== 0x02) return null;

  const end = header.totalLength - 4;
  if (end < 12) return null;

  const pcrPid = readU16(data, 8) & 0x1fff;
  const programInfoLength = readU16(data, 10) & 0x0fff;
  const programInfoStart = 12;
  const programInfoEnd = Math.min(end, programInfoStart + programInfoLength);

  const programDescriptors = describeDescriptors(
    parseRawDescriptors(data, programInfoStart, programInfoEnd - programInfoStart),
    textEncoding,
  );

  const streams: PmtStream[] = [];
  let cursor = programInfoEnd;

  while (cursor + 5 <= end) {
    const streamType = readU8(data, cursor);
    const pid = readU16(data, cursor + 1) & 0x1fff;
    const esInfoLength = readU16(data, cursor + 3) & 0x0fff;
    const esInfoStart = cursor + 5;
    const esInfoEnd = Math.min(end, esInfoStart + esInfoLength);

    streams.push({
      streamType,
      pid,
      esInfoLength,
      descriptors: describeDescriptors(
        parseRawDescriptors(data, esInfoStart, esInfoEnd - esInfoStart),
        textEncoding,
      ),
    });

    cursor = esInfoEnd;
  }

  return {
    tableId: header.tableId,
    programNumber: header.tableIdExtension,
    version: header.version,
    currentNext: header.currentNext,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    pcrPid,
    programInfoLength,
    programDescriptors,
    streams,
    crcValid: header.crcValid,
  };
}

export function pmtStreamDescription(streamType: number): string {
  return streamTypeName(streamType);
}
