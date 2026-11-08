import { readU16 } from '../util/bytes.js';
import { parseLongSectionHeader } from './common.js';

export interface PatProgram {
  programNumber: number;
  pid: number;
}

export interface PatSection {
  tableId: number;
  transportStreamId: number;
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  networkPid?: number;
  programs: PatProgram[];
  crcValid: boolean;
}

export function parsePat(data: Uint8Array): PatSection | null {
  const header = parseLongSectionHeader(data);
  if (!header || header.tableId !== 0x00) return null;

  const programs: PatProgram[] = [];
  let networkPid: number | undefined;
  const end = header.totalLength - 4;

  for (let cursor = 8; cursor + 4 <= end; cursor += 4) {
    const programNumber = readU16(data, cursor);
    const pid = readU16(data, cursor + 2) & 0x1fff;
    if (programNumber === 0) {
      networkPid = pid;
    } else {
      programs.push({ programNumber, pid });
    }
  }

  return {
    tableId: header.tableId,
    transportStreamId: header.tableIdExtension,
    version: header.version,
    currentNext: header.currentNext,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    ...(networkPid !== undefined ? { networkPid } : {}),
    programs,
    crcValid: header.crcValid,
  };
}
