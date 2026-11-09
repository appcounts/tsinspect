import type { EsMetadata } from '../model/types.js';

class BitReader {
  private bit = 0;
  constructor(private readonly data: Uint8Array) {}

  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = this.data[this.bit >> 3] ?? 0;
      value = (value << 1) | ((byte >> (7 - (this.bit & 7))) & 1);
      this.bit += 1;
    }
    return value >>> 0;
  }

  readUe(): number {
    let zeros = 0;
    while (this.read(1) === 0) {
      zeros += 1;
      if (zeros > 31) return 0;
    }
    return ((1 << zeros) >>> 0) - 1 + (zeros > 0 ? this.read(zeros) : 0);
  }

  readSe(): number {
    const value = this.readUe();
    return value & 1 ? Math.ceil(value / 2) : -Math.floor(value / 2);
  }

  skip(count: number): void {
    this.bit += count;
  }
}

const MPEG2_FRAME_RATES = [0, 23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
const MPEG2_ASPECT_RATIOS = ['', '1:1', '4:3', '16:9', '2.21:1'];
const MPEG2_PROFILES: Record<number, string> = {
  1: 'High',
  2: 'Spatial',
  3: 'SNR',
  4: 'Main',
  5: 'Simple',
};
const MPEG2_LEVELS: Record<number, string> = {
  4: 'High',
  6: 'High-1440',
  8: 'Main',
  10: 'Low',
};

function findStartCode(data: Uint8Array, code: number | undefined, from = 0): number {
  for (let i = from; i + 2 < data.length; i += 1) {
    if (
      data[i] === 0x00 &&
      data[i + 1] === 0x00 &&
      data[i + 2] === 0x01 &&
      (code === undefined || data[i + 3] === code)
    ) {
      return i;
    }
  }
  return -1;
}

export function parseMpeg2Video(payload: Uint8Array): EsMetadata | undefined {
  const start = findStartCode(payload, 0xb3);
  if (start < 0 || start + 8 > payload.length) return undefined;
  const reader = new BitReader(payload.subarray(start + 4));
  const width = reader.read(12);
  const height = reader.read(12);
  const aspect = reader.read(4);
  const frameRateCode = reader.read(4);
  reader.read(18); // bit_rate
  reader.read(1); // marker
  reader.read(10); // vbv_buffer_size
  const constrained = reader.read(1) !== 0;
  reader.skip(1); // load_intra_quantiser_matrix
  reader.skip(1); // load_non_intra_quantiser_matrix

  let profile: string | undefined;
  let level: string | undefined;
  let progressive: boolean | undefined;
  const extension = findStartCode(payload, 0xb5, start + 4);
  if (extension >= 0 && extension + 5 < payload.length) {
    const ext = new BitReader(payload.subarray(extension + 4));
    if (ext.read(4) === 1) {
      const profileLevel = ext.read(8);
      profile = MPEG2_PROFILES[profileLevel >> 4];
      level = MPEG2_LEVELS[profileLevel & 0x0f];
      progressive = ext.read(1) !== 0;
    }
  }

  const frameRate = MPEG2_FRAME_RATES[frameRateCode];
  if (
    width < 16 ||
    width > 8192 ||
    height < 16 ||
    height > 4320 ||
    frameRateCode < 1 ||
    frameRateCode > 8
  ) {
    return undefined;
  }
  return {
    kind: 'video',
    codec: 'MPEG-2 Video',
    ...(profile !== undefined ? { profile } : {}),
    ...(level !== undefined ? { level } : {}),
    ...(width > 0 ? { width } : {}),
    ...(height > 0 ? { height } : {}),
    ...(frameRate !== undefined ? { frameRate } : {}),
    ...(MPEG2_ASPECT_RATIOS[aspect] ? { aspectRatio: MPEG2_ASPECT_RATIOS[aspect] } : {}),
    ...(progressive !== undefined ? { interlaced: !progressive } : {}),
    ...(constrained ? { constrained: true } : {}),
  };
}

function unescapeRbsp(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 1) {
    if (i + 2 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 3) {
      out.push(0, 0);
      i += 2;
    } else {
      out.push(data[i] as number);
    }
  }
  return Uint8Array.from(out);
}

interface NalUnit {
  type: number;
  data: Uint8Array;
}

function collectNalUnits(payload: Uint8Array): NalUnit[] {
  const units: NalUnit[] = [];
  let cursor = 0;
  while (cursor < payload.length) {
    const start = findStartCode(payload, undefined, cursor);
    if (start < 0) break;
    // `findStartCode` returns the position of the `00 00 01` part; the NAL
    // header always starts three bytes later, including 00 00 00 01 prefixes.
    const nalStart = start + 3;
    const next = findStartCode(payload, undefined, nalStart);
    const nalEnd = next < 0 ? payload.length : next;
    if (nalStart < nalEnd && nalEnd <= payload.length) {
      units.push({ type: payload[nalStart] as number, data: payload.subarray(nalStart, nalEnd) });
    }
    cursor = nalEnd;
  }
  return units;
}

const H264_PROFILES: Record<number, string> = {
  44: 'CAVLC 4:4:4',
  66: 'Baseline',
  77: 'Main',
  88: 'Extended',
  100: 'High',
  110: 'High 10',
  122: 'High 4:2:2',
  244: 'High 4:4:4',
};
const SAR_TABLE: Record<number, string> = {
  1: '1:1',
  2: '12:11',
  3: '10:11',
  4: '16:11',
  5: '40:33',
  6: '24:11',
  7: '20:11',
  8: '32:11',
  9: '80:33',
  10: '18:11',
  11: '15:11',
  12: '64:33',
  13: '160:99',
  14: '4:3',
  15: '3:2',
  16: '2:1',
};

function skipScalingList(reader: BitReader, size: number): void {
  let lastScale = 8;
  let nextScale = 8;
  for (let j = 0; j < size; j += 1) {
    if (nextScale !== 0) {
      const delta = reader.readSe();
      nextScale = (lastScale + delta + 256) % 256;
    }
    if (nextScale !== 0) lastScale = nextScale;
  }
}

function parseH264Sps(data: Uint8Array): EsMetadata | undefined {
  const reader = new BitReader(unescapeRbsp(data.subarray(1)));
  const profileIdc = reader.read(8);
  reader.read(8); // constraint flags
  const levelIdc = reader.read(8);
  reader.readUe(); // sps id

  let chromaFormat = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
    chromaFormat = reader.readUe();
    if (chromaFormat === 3) reader.read(1);
    reader.readUe(); // bit_depth_luma_minus8
    reader.readUe(); // bit_depth_chroma_minus8
    reader.read(1);
    if (reader.read(1) !== 0) {
      const count = chromaFormat === 3 ? 12 : 8;
      for (let i = 0; i < count; i += 1) {
        if (reader.read(1) !== 0) skipScalingList(reader, i < 6 ? 16 : 64);
      }
    }
  }

  reader.readUe(); // log2_max_frame_num_minus4
  const picOrderCntType = reader.readUe();
  if (picOrderCntType === 0) {
    reader.readUe();
  } else if (picOrderCntType === 1) {
    reader.read(1);
    reader.readSe();
    reader.readSe();
    const count = reader.readUe();
    for (let i = 0; i < count; i += 1) reader.readSe();
  }
  reader.readUe(); // max_num_ref_frames
  reader.read(1); // gaps_in_frame_num
  const widthMbs = reader.readUe() + 1;
  const heightUnits = reader.readUe() + 1;
  const frameMbsOnly = reader.read(1) !== 0;
  if (!frameMbsOnly) reader.read(1);
  reader.read(1); // direct_8x8

  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (reader.read(1) !== 0) {
    cropLeft = reader.readUe();
    cropRight = reader.readUe();
    cropTop = reader.readUe();
    cropBottom = reader.readUe();
  }

  let frameRate: number | undefined;
  let aspectRatio: string | undefined;
  if (reader.read(1) !== 0) {
    // VUI
    if (reader.read(1) !== 0) {
      const idc = reader.read(8);
      if (idc === 255) {
        const sarWidth = reader.read(16);
        const sarHeight = reader.read(16);
        if (sarWidth > 0 && sarHeight > 0) aspectRatio = `${sarWidth}:${sarHeight}`;
      } else {
        aspectRatio = SAR_TABLE[idc];
      }
    }
    if (reader.read(1) !== 0) reader.skip(1); // overscan
    if (reader.read(1) !== 0) {
      reader.read(3);
      reader.read(1); // full range
      if (reader.read(1) !== 0) {
        reader.skip(24);
      }
    }
    if (reader.read(1) !== 0) {
      reader.readUe();
      reader.readUe();
    }
    if (reader.read(1) !== 0) {
      const numUnitsInTick = reader.read(32);
      const timeScale = reader.read(32);
      reader.read(1); // fixed_frame_rate
      if (numUnitsInTick > 0) frameRate = timeScale / (2 * numUnitsInTick);
    }
  }

  const cropUnitX = chromaFormat === 1 ? 2 : 1;
  const cropUnitY = (chromaFormat === 1 ? 2 : 1) * (2 - (frameMbsOnly ? 1 : 0));
  const width = widthMbs * 16 - cropLeft * cropUnitX - cropRight * cropUnitX;
  const height =
    (2 - (frameMbsOnly ? 1 : 0)) * heightUnits * 16 -
    cropTop * cropUnitY -
    cropBottom * cropUnitY;
  if (
    width < 16 ||
    width > 8192 ||
    height < 16 ||
    height > 4320 ||
    levelIdc < 10 ||
    levelIdc > 62 ||
    (H264_PROFILES[profileIdc] === undefined && (profileIdc < 44 || profileIdc > 244))
  ) {
    return undefined;
  }

  return {
    kind: 'video',
    codec: 'AVC / H.264',
    profile: H264_PROFILES[profileIdc] ?? `Profile ${profileIdc}`,
    level: (levelIdc / 10).toFixed(1),
    ...(width > 0 ? { width } : {}),
    ...(height > 0 ? { height } : {}),
    ...(frameRate !== undefined && Number.isFinite(frameRate) ? { frameRate } : {}),
    ...(aspectRatio !== undefined ? { aspectRatio } : {}),
    ...(frameMbsOnly ? {} : { interlaced: true }),
  };
}

function skipProfileTierLevel(reader: BitReader, maxSubLayersMinus1: number): { profile: number; level: number; progressive: boolean; interlaced: boolean } {
  const profileSpace = reader.read(2);
  const tier = reader.read(1);
  const profileIdc = reader.read(5);
  reader.skip(32); // compatibility flags
  const progressive = reader.read(1) !== 0;
  const interlaced = reader.read(1) !== 0;
  reader.read(1); // non-packed
  reader.read(1); // frame-only
  reader.skip(43);
  reader.read(1); // inbld or reserved
  const levelIdc = reader.read(8);
  const profilePresent: boolean[] = [];
  const levelPresent: boolean[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i += 1) {
    profilePresent.push(reader.read(1) !== 0);
    levelPresent.push(reader.read(1) !== 0);
  }
  if (maxSubLayersMinus1 > 0) {
    for (let i = maxSubLayersMinus1; i < 8; i += 1) reader.read(2);
  }
  for (let i = 0; i < maxSubLayersMinus1; i += 1) {
    if (profilePresent[i]) {
      reader.skip(2 + 1 + 5 + 32 + 4 + 43 + 1);
    }
    if (levelPresent[i]) reader.read(8);
  }
  void profileSpace;
  void tier;
  return { profile: profileIdc, level: levelIdc, progressive, interlaced };
}

const HEVC_PROFILES: Record<number, string> = {
  1: 'Main',
  2: 'Main 10',
  3: 'Main Still Picture',
};

function parseH265Sps(data: Uint8Array): EsMetadata | undefined {
  const reader = new BitReader(unescapeRbsp(data.subarray(2)));
  reader.read(4); // vps id
  const maxSubLayersMinus1 = reader.read(3);
  reader.read(1); // temporal nesting
  const ptl = skipProfileTierLevel(reader, maxSubLayersMinus1);
  reader.readUe(); // sps id
  const chromaFormat = reader.readUe();
  if (chromaFormat === 3) reader.read(1);
  const width = reader.readUe();
  const height = reader.readUe();
  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (reader.read(1) !== 0) {
    cropLeft = reader.readUe();
    cropRight = reader.readUe();
    cropTop = reader.readUe();
    cropBottom = reader.readUe();
  }
  const subWidth = chromaFormat === 1 || chromaFormat === 2 ? 2 : 1;
  const subHeight = chromaFormat === 1 ? 2 : 1;
  const finalWidth = width - cropLeft * subWidth - cropRight * subWidth;
  const finalHeight = height - cropTop * subHeight - cropBottom * subHeight;
  if (
    finalWidth < 16 ||
    finalWidth > 8192 ||
    finalHeight < 16 ||
    finalHeight > 4320 ||
    ptl.level < 30 ||
    ptl.level > 186
  ) {
    return undefined;
  }

  return {
    kind: 'video',
    codec: 'HEVC / H.265',
    profile: HEVC_PROFILES[ptl.profile] ?? `Profile ${ptl.profile}`,
    level: (ptl.level / 30).toFixed(1),
    width: finalWidth,
    height: finalHeight,
    ...(ptl.interlaced ? { interlaced: true } : {}),
  };
}

export function parseH264(payload: Uint8Array): EsMetadata | undefined {
  const units = collectNalUnits(payload);
  const sps = units.find((unit) => (unit.type & 0x1f) === 7);
  return sps ? parseH264Sps(sps.data) : undefined;
}

export function parseH265(payload: Uint8Array): EsMetadata | undefined {
  const units = collectNalUnits(payload);
  const sps = units.find((unit) => ((unit.type >> 1) & 0x3f) === 33);
  return sps ? parseH265Sps(sps.data) : undefined;
}
