import type { PacketLayout } from '../model/types.js';
import { readPcrTicks, readU8, readU16 } from '../util/bytes.js';

export interface AdaptationField {
  length: number;
  discontinuity: boolean;
  randomAccess: boolean;
  esPriority: boolean;
  pcr?: {
    base: number;
    extension: number;
    /** 27 MHz ticks. */
    ticks: number;
    /** Seconds since the PCR epoch, wrapped as a 33-bit counter. */
    seconds: number;
  };
  opcr?: {
    ticks: number;
  };
  spliceCountdown?: number;
  hasPrivateData: boolean;
  hasExtension: boolean;
}

export interface TsPacket {
  /** Absolute byte offset of the packet start (before a 192-byte prefix). */
  offset: number;
  /** Zero-based packet number in the scanned range. */
  index: number;
  raw: Uint8Array;
  pid: number;
  pusi: boolean;
  transportError: boolean;
  priority: boolean;
  scrambling: number;
  adaptationFieldControl: number;
  continuityCounter: number;
  hasAdaptation: boolean;
  hasPayload: boolean;
  adaptation?: AdaptationField;
  payload?: Uint8Array;
  /** Extra trailer bytes for 204/208-byte packet layouts. */
  trailer?: Uint8Array;
}

/**
 * Parse one transport packet. Returns null when the packet is too short or its
 * sync byte is not where the detected layout says it should be.
 */
export function parseTsPacket(
  data: Uint8Array,
  packetStart: number,
  layout: PacketLayout,
  index: number,
): TsPacket | null {
  const syncPos = packetStart + layout.syncOffset;
  const tsEnd = syncPos + 188;
  if (packetStart < 0 || syncPos >= data.length || data[syncPos] !== 0x47) return null;
  if (packetStart + layout.packetSize > data.length || tsEnd > data.length) return null;

  const b1 = readU8(data, syncPos + 1);
  const b2 = readU8(data, syncPos + 2);
  const b3 = readU8(data, syncPos + 3);

  const pid = ((b1 & 0x1f) << 8) | b2;
  const adaptationFieldControl = (b3 >> 4) & 0x03;
  const hasAdaptation = adaptationFieldControl === 2 || adaptationFieldControl === 3;
  const hasPayload = adaptationFieldControl === 1 || adaptationFieldControl === 3;

  let adaptation: AdaptationField | undefined;
  let payloadOffset = syncPos + 4;

  if (hasAdaptation) {
    const adaptationLength = readU8(data, payloadOffset);
    const adaptationStart = payloadOffset + 1;
    if (adaptationStart + adaptationLength > tsEnd) return null;

    const flags = adaptationLength > 0 ? readU8(data, adaptationStart) : 0;
    adaptation = {
      length: adaptationLength,
      discontinuity: (flags & 0x80) !== 0,
      randomAccess: (flags & 0x40) !== 0,
      esPriority: (flags & 0x20) !== 0,
      hasPrivateData: (flags & 0x02) !== 0,
      hasExtension: (flags & 0x01) !== 0,
    };

    let cursor = adaptationStart + 1;

    if ((flags & 0x10) !== 0 && adaptationLength >= 7) {
      const b0 = readU8(data, cursor);
      const b1v = readU8(data, cursor + 1);
      const b2v = readU8(data, cursor + 2);
      const b3v = readU8(data, cursor + 3);
      const b4v = readU8(data, cursor + 4);
      const b5v = readU8(data, cursor + 5);
      const base = b0 * 0x2000000 + (b1v << 17) + (b2v << 9) + (b3v << 1) + (b4v >> 7);
      const extension = ((b4v & 0x01) << 8) | b5v;
      const ticks = readPcrTicks(data, cursor);
      adaptation.pcr = {
        base,
        extension,
        ticks,
        seconds: ticks / 27_000_000,
      };
      cursor += 6;
    }

    if ((flags & 0x08) !== 0 && adaptationLength >= 13) {
      adaptation.opcr = { ticks: readPcrTicks(data, cursor) };
      cursor += 6;
    }

    if ((flags & 0x04) !== 0) {
      adaptation.spliceCountdown = readU8(data, cursor);
    }

    payloadOffset = adaptationStart + adaptationLength;
  }

  let payload: Uint8Array | undefined;
  if (hasPayload) {
    if (payloadOffset > tsEnd) return null;
    payload = payloadOffset < tsEnd ? data.subarray(payloadOffset, tsEnd) : new Uint8Array(0);
  }

  const trailerLength = layout.packetSize - layout.syncOffset - 188;
  const trailer =
    trailerLength > 0 ? data.subarray(tsEnd, Math.min(tsEnd + trailerLength, data.length)) : undefined;

  return {
    offset: packetStart,
    index,
    raw: data.subarray(packetStart, packetStart + layout.packetSize),
    pid,
    pusi: (b1 & 0x40) !== 0,
    transportError: (b1 & 0x80) !== 0,
    priority: (b1 & 0x20) !== 0,
    scrambling: b3 >> 6,
    adaptationFieldControl,
    continuityCounter: b3 & 0x0f,
    hasAdaptation,
    hasPayload,
    ...(adaptation ? { adaptation } : {}),
    ...(payload ? { payload } : {}),
    ...(trailer ? { trailer } : {}),
  };
}

export function streamTypeName(streamType: number): string {
  switch (streamType) {
    case 0x01:
      return 'MPEG-1 Video';
    case 0x02:
      return 'MPEG-2 Video';
    case 0x03:
      return 'MPEG-1 Audio';
    case 0x04:
      return 'MPEG-2 Audio';
    case 0x05:
      return 'Private sections';
    case 0x06:
      return 'PES private data';
    case 0x07:
      return 'MHEG';
    case 0x08:
      return 'DSM-CC';
    case 0x09:
      return 'ISO/IEC 13818-6';
    case 0x0a:
      return 'DSM-CC sections';
    case 0x0b:
      return 'DSM-CC sections (UN)';
    case 0x0c:
      return 'DSM-CC data';
    case 0x0d:
      return 'DSM-CC sections (ISO)';
    case 0x0e:
      return 'DSM-CC sections (aux)';
    case 0x0f:
      return 'AAC (ADTS)';
    case 0x10:
      return 'MPEG-4 Video';
    case 0x11:
      return 'MPEG-4 Audio (LATM)';
    case 0x12:
      return 'MPEG-4 SL/FlexMux';
    case 0x13:
      return 'MPEG-4 SL/FlexMux (sync)';
    case 0x14:
      return 'MPEG-4 SL/FlexMux (sync, AU)';
    case 0x15:
      return 'Metadata (PES)';
    case 0x16:
      return 'Metadata (sections)';
    case 0x17:
      return 'Metadata (ISO)';
    case 0x18:
      return 'MPEG-2 video (aux)';
    case 0x19:
      return 'MPEG-4 video (aux)';
    case 0x1a:
      return 'AVC / H.264 video';
    case 0x1b:
      return 'AVC / H.264 video';
    case 0x1c:
      return 'MPEG-4 audio';
    case 0x1d:
      return 'MPEG-4 audio (aux)';
    case 0x1e:
      return 'MPEG-4 video (aux)';
    case 0x1f:
      return 'AVC / H.264 video (SVC)';
    case 0x20:
      return 'AVC / H.264 video (MVC)';
    case 0x21:
      return 'JPEG 2000 video';
    case 0x22:
      return 'MPEG-2 video (aux)';
    case 0x23:
      return 'MPEG-4 video (aux)';
    case 0x24:
      return 'HEVC / H.265 video';
    case 0x25:
      return 'HEVC / H.265 video (temporal)';
    case 0x26:
      return 'HEVC / H.265 video (sub-bitstream)';
    case 0x27:
      return 'HEVC / H.265 video (MVC)';
    case 0x28:
      return 'VVC / H.266 video';
    case 0x29:
      return 'VVC / H.266 video (sub-bitstream)';
    case 0x2a:
      return 'AVS3 video';
    case 0x2b:
      return 'AVS3 video (sub-bitstream)';
    case 0x42:
      return 'AVS video';
    case 0x80:
      return 'User private';
    case 0x81:
      return 'AC-3 audio';
    case 0x82:
      return 'Reserved (0x82)';
    case 0x83:
      return 'ATSC AC-3 True HD audio';
    case 0x84:
      return 'ATSC AC-3+ audio';
    case 0x85:
      return 'Reserved (0x85)';
    case 0x86:
      return 'SCTE-35 splice';
    case 0x87:
      return 'E-AC-3 audio';
    case 0x88:
      return 'ATSC AC-3 audio';
    case 0x8a:
      return 'DTS audio (HDMV)';
    case 0x91:
      return 'AC-3 audio (Blu-ray)';
    case 0x92:
      return 'PGS subtitles';
    case 0xea:
      return 'VC-1 video';
    default:
      return `Unknown (0x${streamType.toString(16).padStart(2, '0')})`;
  }
}

export function pidKind(pid: number): string {
  switch (pid) {
    case 0x0000:
      return 'PAT';
    case 0x0001:
      return 'CAT';
    case 0x0002:
      return 'TSDT';
    case 0x0010:
      return 'NIT/ST';
    case 0x0011:
      return 'SDT/BAT';
    case 0x0012:
      return 'EIT';
    case 0x0013:
      return 'RST';
    case 0x0014:
      return 'EIT';
    case 0x1ffb:
      return 'ATSC PSIP';
    case 0x1ff0:
      return 'ISDB IIP';
    case 0x1fff:
      return 'Null';
    default:
      return '';
  }
}

export function pidLabel(pid: number): string {
  const kind = pidKind(pid);
  return kind ? `${kind} (0x${pid.toString(16).padStart(4, '0').toUpperCase()})` : '';
}

export function readContinuity(expected: number, actual: number): boolean {
  return ((expected + 1) & 0x0f) === actual;
}

export function packetHeaderText(packet: TsPacket): string {
  return `PID 0x${packet.pid.toString(16).padStart(4, '0').toUpperCase()}${packet.pusi ? ' PUSI' : ''}${
    packet.hasAdaptation ? ' AF' : ''
  } CC=${packet.continuityCounter}`;
}

export function payloadStart(packet: TsPacket): number {
  return packet.payload ? readU16(packet.payload, 0) : 0;
}
