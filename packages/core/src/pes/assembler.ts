import { readU16, readU8 } from '../util/bytes.js';

export interface PesHeader {
  streamId: number;
  packetLength: number;
  pts?: number;
  dts?: number;
  ptsSeconds?: number;
  dtsSeconds?: number;
  headerDataLength: number;
  /** Offset of the elementary payload inside the PES packet. */
  payloadOffset: number;
}

export interface PesPacket extends PesHeader {
  pid: number;
  payload: Uint8Array;
  firstPacket: number;
  firstPacketOffset: number;
  /** False when the packet was cut short by a new PUSI or the end of input. */
  complete: boolean;
}

function readTimestamp(data: Uint8Array, offset: number): number {
  const b0 = readU8(data, offset);
  const b1 = readU8(data, offset + 1);
  const b2 = readU8(data, offset + 2);
  const b3 = readU8(data, offset + 3);
  const b4 = readU8(data, offset + 4);
  const high = (b0 >> 1) & 0x07;
  const low =
    (b1 << 22) |
    (((b2 >> 1) & 0x7f) << 15) |
    (b3 << 7) |
    ((b4 >> 1) & 0x7f);
  return high * 0x40000000 + (low >>> 0);
}

/**
 * Stream ids whose PES packets carry no optional PES header: the elementary
 * payload starts right after the 6-byte header, so bytes 6/7 are payload and
 * must not be interpreted as flags or a header-data length.
 */
const NO_OPTIONAL_HEADER = new Set([
  0xbc, // program_stream_map
  0xbe, // padding_stream
  0xbf, // private_stream_2
  0xf0, // ECM
  0xf1, // EMM
  0xf2, // DSM-CC
  0xf8, // ITU-T H.222.1 type E
  0xff, // program_stream_directory
]);

/** Parse a standard MPEG-2 PES header at the start of `data`. */
export function parsePesHeader(data: Uint8Array): PesHeader | null {
  if (data.length < 6) return null;
  if (data[0] !== 0x00 || data[1] !== 0x00 || data[2] !== 0x01) return null;

  const streamId = readU8(data, 3);
  const packetLength = readU16(data, 4);
  if (NO_OPTIONAL_HEADER.has(streamId)) {
    return { streamId, packetLength, headerDataLength: 0, payloadOffset: 6 };
  }
  if (data.length < 9) return null;

  const flags = readU8(data, 7);
  const headerDataLength = readU8(data, 8);
  const payloadOffset = 9 + headerDataLength;
  if (payloadOffset > data.length) return null;

  const ptsDtsFlags = (flags >> 6) & 0x03;
  let pts: number | undefined;
  let dts: number | undefined;
  if ((ptsDtsFlags & 0x02) !== 0 && headerDataLength >= 5) {
    pts = readTimestamp(data, 9);
  }
  if ((ptsDtsFlags & 0x01) !== 0 && headerDataLength >= 10) {
    dts = readTimestamp(data, 14);
  }

  return {
    streamId,
    packetLength,
    ...(pts !== undefined ? { pts, ptsSeconds: pts / 90_000 } : {}),
    ...(dts !== undefined ? { dts, dtsSeconds: dts / 90_000 } : {}),
    headerDataLength,
    payloadOffset,
  };
}

export function pesStreamName(streamId: number): string {
  if (streamId === 0xbc) return 'Program stream map';
  if (streamId === 0xbd) return 'Private stream 1';
  if (streamId === 0xbe) return 'Padding stream';
  if (streamId === 0xbf) return 'Private stream 2';
  if (streamId >= 0xc0 && streamId <= 0xdf) return 'Audio stream';
  if (streamId >= 0xe0 && streamId <= 0xef) return 'Video stream';
  if (streamId === 0xf0) return 'ECM stream';
  if (streamId === 0xf1) return 'EMM stream';
  if (streamId === 0xf2) return 'DSM-CC stream';
  if (streamId === 0xf3) return 'ISO/IEC 13522 stream';
  if (streamId === 0xf8) return 'ITU-T H.222.1 stream';
  if (streamId === 0xf9) return 'Ancillary stream';
  if (streamId === 0xfc) return 'Metadata stream';
  if (streamId === 0xfd) return 'Extended stream';
  return `Stream 0x${streamId.toString(16).padStart(2, '0').toUpperCase()}`;
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Reassemble PES packets for one PID. Callers push TS payloads in order and
 * collect completed PES packets; `flush()` handles the final open packet.
 */
export class PesAssembler {
  private chunks: Uint8Array[] = [];
  private total = 0;
  private header: PesHeader | null = null;
  private firstPacket = 0;
  private firstPacketOffset = 0;

  constructor(readonly pid: number) {}

  get pendingBytes(): number {
    return this.total;
  }

  push(
    payload: Uint8Array,
    pusi: boolean,
    packetIndex: number,
    packetOffset: number,
  ): PesPacket[] {
    const out: PesPacket[] = [];

    if (pusi) {
      if (this.total > 0) {
        const previous = this.build(false);
        if (previous) out.push(previous);
        this.reset();
      }
      this.firstPacket = packetIndex;
      this.firstPacketOffset = packetOffset;
    } else if (this.total === 0) {
      return out;
    }

    this.chunks.push(payload);
    this.total += payload.length;

    // 6 bytes are enough to read the stream id and packet length, which is all
    // a header without optional fields needs; parsePesHeader reports null when
    // a standard header still needs its 3 extra bytes.
    if (!this.header && this.total >= 6) {
      this.header = parsePesHeader(concatChunks(this.chunks, this.total));
    }
    const header = this.header;
    if (header && header.packetLength > 0 && this.total >= 6 + header.packetLength) {
      const complete = this.build(true);
      if (complete) out.push(complete);
      this.reset();
    }

    return out;
  }

  flush(): PesPacket[] {
    if (this.total === 0) return [];
    const packet = this.build(false);
    this.reset();
    return packet ? [packet] : [];
  }

  private build(complete: boolean): PesPacket | null {
    const data = concatChunks(this.chunks, this.total);
    const header = this.header ?? parsePesHeader(data);
    if (!header) return null;
    // A PES packet may end before the TS payload does; the remaining bytes are
    // stuffing and must not be treated as elementary stream data.
    const end =
      header.packetLength > 0 ? Math.min(data.length, 6 + header.packetLength) : data.length;
    return {
      ...header,
      pid: this.pid,
      payload: data.subarray(header.payloadOffset, end),
      firstPacket: this.firstPacket,
      firstPacketOffset: this.firstPacketOffset,
      complete,
    };
  }

  private reset(): void {
    this.chunks = [];
    this.total = 0;
    this.header = null;
  }
}
