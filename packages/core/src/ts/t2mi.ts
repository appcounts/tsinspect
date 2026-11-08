import { crc32Mpeg2 } from '../section/crc32.js';

const TYPE_NAMES: Record<number, string> = {
  0x00: 'TS',
  0x01: 'PES',
  0x02: 'L1 current',
  0x03: 'L1 future',
};

export interface T2miTypeCount {
  type: number;
  name: string;
  packets: number;
}

export interface T2miSummary {
  packets: number;
  types: T2miTypeCount[];
  tsPackets: number;
  crcErrors: number;
}

export function t2miTypeName(type: number): string {
  return TYPE_NAMES[type] ?? `T2-MI type 0x${type.toString(16).padStart(2, '0').toUpperCase()}`;
}

/**
 * Parse a T2-MI byte stream (ETSI EN 302 755, Annex A). A T2-MI packet is a
 * 3-byte header (type, 16-bit payload length), the payload and a trailing
 * CRC-32/MPEG-2.
 */
export function parseT2miBuffer(buffer: Uint8Array): T2miSummary {
  let packets = 0;
  let tsPackets = 0;
  let crcErrors = 0;
  const counts = new Map<number, number>();
  let offset = 0;

  while (offset + 7 <= buffer.length) {
    const type = buffer[offset] as number;
    const length = ((buffer[offset + 1] as number) << 8) | (buffer[offset + 2] as number);
    const total = 3 + length + 4;
    if (offset + total > buffer.length) break;
    if (crc32Mpeg2(buffer, offset, offset + total) !== 0) crcErrors += 1;
    packets += 1;
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (type === 0x00) tsPackets += Math.floor(length / 188);
    offset += total;
  }

  const types: T2miTypeCount[] = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([type, count]) => ({ type, name: t2miTypeName(type), packets: count }));

  return { packets, types, tsPackets, crcErrors };
}
