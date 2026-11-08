import { isSectionCrcValid } from '../section/crc32.js';
import { readU16 } from '../util/bytes.js';

export interface LongSectionHeader {
  tableId: number;
  sectionSyntaxIndicator: boolean;
  sectionLength: number;
  totalLength: number;
  tableIdExtension: number;
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  crcValid: boolean;
}

export function parseLongSectionHeader(data: Uint8Array): LongSectionHeader | null {
  if (data.length < 12) return null;

  const tableId = data[0] as number;
  const b1 = data[1] as number;
  const b2 = data[2] as number;
  const sectionSyntaxIndicator = (b1 & 0x80) !== 0;
  if (!sectionSyntaxIndicator) return null;

  const sectionLength = ((b1 & 0x0f) << 8) | b2;
  const totalLength = 3 + sectionLength;
  if (totalLength < 12 || totalLength > data.length) return null;

  return {
    tableId,
    sectionSyntaxIndicator,
    sectionLength,
    totalLength,
    tableIdExtension: readU16(data, 3),
    version: ((data[5] as number) >> 1) & 0x1f,
    currentNext: ((data[5] as number) & 0x01) !== 0,
    sectionNumber: data[6] as number,
    lastSectionNumber: data[7] as number,
    crcValid: isSectionCrcValid(data.subarray(0, totalLength)),
  };
}

export const TABLE_NAMES: Record<number, string> = {
  0x00: 'PAT',
  0x01: 'CAT',
  0x02: 'PMT',
  0x03: 'TSDT',
  0x3b: 'DSM-CC Download',
  0x3c: 'DSM-CC DDB',
  0x3d: 'DSM-CC Section',
  0x3e: 'MPE Datagram',
  0x78: 'MPE-FEC',
  0x40: 'NIT (actual)',
  0x41: 'NIT (other)',
  0x42: 'SDT (actual)',
  0x46: 'SDT (other)',
  0x4a: 'BAT',
  0x4c: 'INT',
  0x4e: 'EIT p/f (actual)',
  0x4f: 'EIT p/f (other)',
  0x70: 'TDT',
  0x71: 'RST',
  0x72: 'ST',
  0x73: 'TOT',
  0x74: 'AIT',
  0x7e: 'DIT',
  0x7f: 'SIT',
  0xa0: 'SSU',
  0xc3: 'ISDB SDTT',
  0xc4: 'ISDB BIT',
  0xc5: 'ISDB NBIT',
  0xc6: 'ISDB NBIT (reference)',
  0xc7: 'ATSC MGT',
  0xc8: 'ATSC TVCT',
  0xc9: 'ATSC CVCT',
  0xca: 'ATSC RRT',
  0xcb: 'ATSC EIT',
  0xcc: 'ATSC ETT',
  0xcd: 'ATSC STT',
  0xd8: 'SCTE-18 EAS',
};

/**
 * ISDB and ATSC share table ids 0xC7/0xC8 (ISDB LDT/CDT, ATSC MGT/TVCT).
 * The caller resolves the collision from the detected standard.
 */
const ISDB_TABLE_NAMES: Record<number, string> = {
  0xc3: 'ISDB SDTT',
  0xc4: 'ISDB BIT',
  0xc5: 'ISDB NBIT',
  0xc6: 'ISDB NBIT (reference)',
  0xc7: 'ISDB LDT',
  0xc8: 'ISDB CDT',
};

export type TableStandard = 'DVB' | 'ATSC' | 'ISDB' | 'mixed' | 'unknown';

export function tableName(tableId: number, standard: TableStandard = 'ATSC'): string {
  if (standard === 'ISDB') {
    const isdbName = ISDB_TABLE_NAMES[tableId];
    if (isdbName) return isdbName;
  }
  if (tableId >= 0x50 && tableId <= 0x5f) {
    return `EIT schedule (actual, ${tableId - 0x50})`;
  }
  if (tableId >= 0x60 && tableId <= 0x6f) {
    return `EIT schedule (other, ${tableId - 0x60})`;
  }
  return TABLE_NAMES[tableId] ?? `Unknown (0x${tableId.toString(16).padStart(2, '0').toUpperCase()})`;
}

export interface ShortSectionHeader {
  tableId: number;
  sectionLength: number;
  totalLength: number;
}

export function parseShortSectionHeader(data: Uint8Array): ShortSectionHeader | null {
  if (data.length < 3) return null;
  const tableId = data[0] as number;
  const sectionLength = ((data[1] as number) & 0x0f) << 8 | (data[2] as number);
  const totalLength = 3 + sectionLength;
  if (totalLength > data.length) return null;
  return { tableId, sectionLength, totalLength };
}
