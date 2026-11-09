/** Internal accumulator types shared between the probe scan, finalize and derive stages. */

export interface MutablePidStat {
  packets: number;
  payloadBytes: number;
  pusi: number;
  scrambled: number;
  ccErrors: number;
  duplicates: number;
  tei: number;
  pcrCount: number;
  lastCc?: number;
  /** Consecutive packets repeating the same continuity counter. */
  duplicateRun?: number;
  firstPacket?: number;
  firstPacketOffset?: number;
}

export interface PcrTrack {
  first: number;
  last: number;
  count: number;
  lastTicks?: number;
  maxGapTicks?: number;
  backwardsJumps?: number;
}

export interface SectionInfo {
  tableId: number;
  tableIdExtension?: number;
  version?: number;
  currentNext?: boolean;
  sectionNumber?: number;
  lastSectionNumber?: number;
  crcValid?: boolean;
  mode: 'long' | 'short';
  length: number;
}

/** Per table identity repetition/version tracking built during the scan. */
export interface TableTrack {
  firstPacket: number;
  lastPacket: number;
  maxGap: number;
  occurrences: number;
  versions: Set<number>;
  sectionsByVersion: Map<number, { seen: Set<number>; last: number }>;
}

/** PCR program clock reference wrap period, in 27 MHz ticks. */
export const PCR_WRAP = 0x200000000 * 300;

/** A period during which an emergency signal was continuously present. */
export interface EmergencySpan {
  /** Stream time (PCR-based, seconds from the first PCR in the sample). */
  startSec: number;
  /** Last stream time the signal was observed. */
  lastSeenSec: number;
}

/** EWS TRDW region presence over stream time. */
export interface EwsRegionSpan extends EmergencySpan {
  pid: number;
  disasterCode: number;
  locationTypeCode: number;
  packageId: number;
  locations: Array<{ code: string; description: string }>;
}

/** EWBS service presence over stream time. */
export interface EwbsServiceSpan extends EmergencySpan {
  serviceId: number;
  signalLevel: number;
  areaCodes: number[];
}
