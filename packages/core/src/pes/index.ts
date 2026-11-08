import type { PacketLayout } from '../model/types.js';
import { scanPackets } from '../ts/reader.js';
import { PesAssembler, parsePesHeader, pesStreamName, type PesPacket } from './assembler.js';

export interface PesStreamIndex {
  pid: number;
  streamId: number;
  streamName: string;
  packets: number;
  firstPacket: number;
  firstPts?: number;
  lastPts?: number;
  firstPtsSeconds?: number;
  lastPtsSeconds?: number;
}

/**
 * Lightweight PES stream index: counts PES starts and records the first/last
 * PTS without buffering elementary payloads.
 */
export function indexPesStreams(
  data: Uint8Array,
  layout: PacketLayout,
  pids?: Set<number>,
): PesStreamIndex[] {
  const streams = new Map<number, PesStreamIndex>();

  for (const packet of scanPackets(data, layout)) {
    if (!packet.payload || !packet.pusi) continue;
    if (pids !== undefined && !pids.has(packet.pid)) continue;
    const header = parsePesHeader(packet.payload);
    if (!header) continue;

    let stream = streams.get(packet.pid);
    if (!stream) {
      stream = {
        pid: packet.pid,
        streamId: header.streamId,
        streamName: pesStreamName(header.streamId),
        packets: 0,
        firstPacket: packet.index,
      };
      streams.set(packet.pid, stream);
    }
    stream.packets += 1;
    if (header.pts !== undefined) {
      if (stream.firstPts === undefined) {
        stream.firstPts = header.pts;
        stream.firstPtsSeconds = header.pts / 90_000;
      }
      stream.lastPts = header.pts;
      stream.lastPtsSeconds = header.pts / 90_000;
    }
  }

  return [...streams.values()].sort((a, b) => a.pid - b.pid);
}

/** Reassemble full PES packets for the selected PIDs. */
export function collectPesPackets(
  data: Uint8Array,
  layout: PacketLayout,
  pids: Set<number>,
): PesPacket[] {
  const assemblers = new Map<number, PesAssembler>();
  const packets: PesPacket[] = [];

  for (const packet of scanPackets(data, layout)) {
    if (!pids.has(packet.pid) || !packet.payload) continue;
    let assembler = assemblers.get(packet.pid);
    if (!assembler) {
      assembler = new PesAssembler(packet.pid);
      assemblers.set(packet.pid, assembler);
    }
    packets.push(
      ...assembler.push(packet.payload, packet.pusi, packet.index, packet.offset),
    );
  }

  for (const assembler of assemblers.values()) {
    packets.push(...assembler.flush());
  }

  return packets.sort((a, b) => a.firstPacket - b.firstPacket);
}
