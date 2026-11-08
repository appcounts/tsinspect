import type { PacketFormat, PacketLayout } from '../model/types.js';
import { parseTsPacket, type TsPacket } from './packet.js';

interface Candidate {
  packetSize: 188 | 192 | 204 | 208;
  syncOffset: number;
  format: PacketFormat;
}

const CANDIDATES: Candidate[] = [
  { packetSize: 188, syncOffset: 0, format: 'ts' },
  { packetSize: 192, syncOffset: 4, format: 'm2ts' },
  { packetSize: 204, syncOffset: 0, format: 'isdb-tb' },
  { packetSize: 208, syncOffset: 0, format: 'rs208' },
];

interface Detection {
  layout: PacketLayout;
  score: number;
}

function headerLooksValid(data: Uint8Array, syncPos: number): boolean {
  if (syncPos + 3 >= data.length || data[syncPos] !== 0x47) return false;
  const b1 = data[syncPos + 1] as number;
  const b3 = data[syncPos + 3] as number;
  const pid = ((b1 & 0x1f) << 8) | (data[syncPos + 2] as number);
  const adaptationFieldControl = (b3 >> 4) & 0x03;
  return pid <= 0x1fff && adaptationFieldControl !== 0;
}

/**
 * Detect the packet layout by looking for a run of valid sync bytes and
 * plausible TS headers at the candidate stride. Supports 188, 192 (M2TS),
 * 204 (ISDB-Tb) and 208 byte packets.
 */
export function detectPacketLayout(data: Uint8Array): PacketLayout | null {
  if (data.length < 188 * 5) return null;

  const scanLimit = Math.min(data.length, 64 * 1024);
  let best: Detection | null = null;

  for (const candidate of CANDIDATES) {
    for (let syncPos = candidate.syncOffset; syncPos < scanLimit; syncPos += 1) {
      if (data[syncPos] !== 0x47) continue;
      const start = syncPos - candidate.syncOffset;
      if (start < 0) continue;

      let valid = 0;
      for (let i = 0; i < 48; i += 1) {
        const packetStart = start + i * candidate.packetSize;
        const packetSync = packetStart + candidate.syncOffset;
        if (packetStart + candidate.packetSize > data.length) break;
        if (!headerLooksValid(data, packetSync)) break;
        valid += 1;
      }

      if (valid < 5) continue;

      // Prefer longer runs. On a tie prefer the smaller packet size, which is
      // the canonical 188-byte layout.
      const score = valid * 1000 - candidate.packetSize;
      if (
        best === null ||
        score > best.score ||
        (score === best.score && start < best.layout.firstPacketOffset)
      ) {
        best = {
          score,
          layout: {
            packetSize: candidate.packetSize,
            syncOffset: candidate.syncOffset,
            format: candidate.format,
            firstPacketOffset: start,
          },
        };
      }

      // A long, clean run is conclusive for this candidate; no need to keep
      // scanning every sync byte for it.
      if (valid >= 24) break;
    }
  }

  return best?.layout ?? null;
}

export interface ScanOptions {
  /** Called when the reader cannot find a valid packet at the expected offset. */
  onSyncLoss?: (offset: number) => void;
}

/**
 * Iterate packets from a buffer, resynchronising on the next plausible packet
 * when a corrupt region is encountered.
 */
export function* scanPackets(
  data: Uint8Array,
  layout: PacketLayout,
  options: ScanOptions = {},
): Generator<TsPacket> {
  let offset = layout.firstPacketOffset;
  let index = 0;
  const step = layout.packetSize;

  while (offset + step <= data.length) {
    const packet = parseTsPacket(data, offset, layout, index);
    if (packet) {
      yield packet;
      index += 1;
      offset += step;
      continue;
    }

    let nextStart = -1;
    const searchEnd = Math.min(offset + step * 2, data.length);
    for (let p = offset + 1; p < searchEnd; p += 1) {
      if (data[p] !== 0x47) continue;
      const candidateStart = p - layout.syncOffset;
      if (candidateStart <= offset) continue;
      const nextSync = candidateStart + step + layout.syncOffset;
      if (nextSync < data.length && data[nextSync] === 0x47) {
        nextStart = candidateStart;
        break;
      }
    }

    options.onSyncLoss?.(offset);
    if (nextStart < 0) break;
    offset = nextStart;
  }
}
