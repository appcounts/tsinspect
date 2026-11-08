import type { EsMetadata } from '../model/types.js';

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];
const AAC_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8];

const MPEG_SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};
const MPEG_BITRATES: Record<string, number[]> = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const AC3_SAMPLE_RATES = [48000, 44100, 32000];
const AC3_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5];
const AC3_BITRATES = [
  32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640,
];

/** DTS core sfreq codes (ETSI TS 102 114 / FFmpeg dca_sample_rates). */
const DTS_SAMPLE_RATES = [
  0, 8000, 16000, 32000, 0, 0, 11025, 22050, 44100, 0, 0, 12000, 24000, 48000, 96000, 192000,
];
/** DTS core rate codes in bits per second. */
const DTS_BITRATES = [
  32000, 56000, 64000, 96000, 112000, 128000, 192000, 224000, 256000, 320000, 384000, 448000,
  512000, 576000, 640000, 768000, 960000, 1024000, 1152000, 1280000, 1344000, 1408000, 1411200,
  1472000, 1536000, 1920000, 2048000, 3072000, 3840000,
];
/** DTS AMODE 0..15 channel counts; 0x10..0x3F are user defined. */
const DTS_CHANNELS = [1, 2, 2, 2, 2, 3, 3, 4, 4, 5, 6, 6, 6, 7, 8, 8];

/** AC-4 frame_rate_index -> frames per second (48 kHz base table). */
const AC4_FRAME_RATES = [
  23.976, 24, 25, 29.97, 30, 47.95, 48, 50, 59.94, 60, 100, 119.88, 120, 23.44,
];

class BitReader {
  private position = 0;
  constructor(private readonly data: Uint8Array) {}

  read(count: number): number {
    if (count === 0) return 0;
    if (this.position + count > this.data.length * 8) {
      throw new RangeError('bitstream underflow');
    }
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = this.data[this.position >> 3] as number;
      value = value * 2 + ((byte >> (7 - (this.position & 7))) & 1);
      this.position += 1;
    }
    return value;
  }

  bit(): boolean {
    return this.read(1) !== 0;
  }

  skip(count: number): void {
    if (this.position + count > this.data.length * 8) {
      throw new RangeError('bitstream underflow');
    }
    this.position += count;
  }

  byteAlign(): void {
    this.skip((8 - (this.position & 7)) & 7);
  }

  get bitPosition(): number {
    return this.position;
  }
}

/**
 * Read the DTS core frame header at `payload[at]` (sync 0x7FFE8001).
 * Only the fixed header fields needed for codec display are decoded.
 */
export function parseDts(payload: Uint8Array): EsMetadata | undefined {
  for (let at = 0; at + 12 <= payload.length; at += 1) {
    if (
      payload[at] !== 0x7f ||
      payload[at + 1] !== 0xfe ||
      payload[at + 2] !== 0x80 ||
      payload[at + 3] !== 0x01
    ) {
      continue;
    }
    try {
      const reader = new BitReader(payload.subarray(at, Math.min(payload.length, at + 16)));
      reader.read(32); // sync
      const normalFrame = reader.bit();
      const short = reader.read(5) + 1;
      const crcPresent = reader.bit();
      const nblks = reader.read(7) + 1;
      const fsize = reader.read(14) + 1;
      const amode = reader.read(6);
      const sfreq = reader.read(4);
      const rate = reader.read(5);
      const reserved = reader.bit();
      reader.read(1); // dynf
      reader.read(1); // timef
      reader.read(1); // auxf
      reader.read(1); // hdcd
      reader.read(3); // ext_audio_id
      reader.read(1); // ext_audio
      reader.read(1); // aspf
      const lfe = reader.read(2);

      const sampleRate = DTS_SAMPLE_RATES[sfreq];
      if (
        !normalFrame ||
        short !== 32 ||
        reserved ||
        sampleRate === 0 ||
        sampleRate === undefined ||
        fsize < 96 ||
        nblks % 8 !== 0
      ) {
        continue;
      }

      const baseChannels = DTS_CHANNELS[amode];
      const channels =
        baseChannels !== undefined && lfe !== 3 ? baseChannels + (lfe > 0 ? 1 : 0) : undefined;
      const computed = Math.round((fsize * 8 * sampleRate) / (nblks * 32));
      const bitrateBps = computed > 0 ? computed : DTS_BITRATES[rate];

      return {
        kind: 'audio',
        codec: 'DTS',
        profile: crcPresent ? 'Core (CRC)' : 'Core',
        sampleRate,
        ...(channels !== undefined ? { channels } : {}),
        ...(bitrateBps !== undefined ? { bitrateBps } : {}),
        format: 'DTS',
      };
    } catch {
      // Truncated header: keep scanning for the next core sync word.
    }
  }
  return undefined;
}

function ac4VariableBits(reader: BitReader, width: number): number {
  let value = 0;
  for (let i = 0; i < 8; i += 1) {
    value += reader.read(width);
    if (!reader.bit()) return value;
    value = value * 2 ** width + 2 ** width;
  }
  throw new RangeError('AC-4 variable_bits runaway');
}

interface Ac4ChannelMode {
  chMode: number;
  channels?: number;
}

function ac4ChannelMode(reader: BitReader): Ac4ChannelMode {
  if (!reader.bit()) return { chMode: 0, channels: 1 };
  if (!reader.bit()) return { chMode: 1, channels: 2 };
  const head = reader.read(2);
  if (head === 0) return { chMode: 2, channels: 3 };
  if (head === 1) return { chMode: 3, channels: 5 };
  if (head === 2) return { chMode: 4, channels: 6 };
  const tail = reader.read(3);
  switch (tail) {
    case 0:
      return { chMode: 5, channels: 7 };
    case 1:
      return { chMode: 6, channels: 8 };
    case 2:
      return { chMode: 7, channels: 7 };
    case 3:
      return { chMode: 8, channels: 8 };
    case 4:
      return { chMode: 9, channels: 7 };
    case 5:
      return { chMode: 10, channels: 8 };
    case 6:
      return { chMode: 11 };
    default:
      return { chMode: 12 + ac4VariableBits(reader, 2) };
  }
}

function ac4ContentType(reader: BitReader): void {
  reader.read(3); // content_classifier
  if (!reader.bit()) return; // b_language_indicator
  if (reader.bit()) {
    reader.read(1); // b_start_tag
    reader.read(16); // language_tag_chunk
  } else {
    const count = reader.read(6);
    reader.skip(count * 8);
  }
}

interface Ac4SubstreamInfo {
  channels?: number;
  sfMultiplier: number;
}

function ac4SubstreamInfo(reader: BitReader, fsIndex: number): Ac4SubstreamInfo {
  const mode = ac4ChannelMode(reader);
  let sfMultiplier = 0;
  if (fsIndex === 1 && reader.bit()) sfMultiplier = reader.read(1) + 1;
  if (reader.bit()) {
    const short = reader.read(3);
    if (short === 0b111) reader.read(2);
  }
  if (mode.chMode >= 7 && mode.chMode <= 10) reader.read(1); // add_ch_base
  if (reader.bit()) ac4ContentType(reader);
  reader.read(1); // b_iframe
  if (reader.read(2) === 3) ac4VariableBits(reader, 2); // substream_index escape
  return { ...(mode.channels !== undefined ? { channels: mode.channels } : {}), sfMultiplier };
}

function ac4FrameRateMultiplyInfo(reader: BitReader, frameRateIndex: number): void {
  if (frameRateIndex >= 2 && frameRateIndex <= 4) {
    if (reader.bit()) reader.read(1);
  } else if ([0, 1, 7, 8, 9].includes(frameRateIndex)) {
    reader.bit();
  }
}

function ac4EmdfInfo(reader: BitReader): void {
  if (reader.read(2) === 3) ac4VariableBits(reader, 2); // emdf_version
  if (reader.read(3) === 7) ac4VariableBits(reader, 3); // key_id
  if (reader.bit() && reader.read(2) === 3) ac4VariableBits(reader, 2); // payloads substream index
  if (reader.bit()) reader.skip(ac4VariableBits(reader, 5)); // emdf_reserved
}

function ac4HsfExtSubstreamInfo(reader: BitReader): void {
  if (reader.read(2) === 3) ac4VariableBits(reader, 2);
}

function ac4PresentationConfigExtInfo(reader: BitReader): void {
  let skipBytes = reader.read(5);
  if (reader.bit()) skipBytes += ac4VariableBits(reader, 2) * 32;
  reader.skip(skipBytes * 8);
}

interface Ac4PresentationInfo {
  channels?: number;
  sfMultiplier: number;
}

/** ac4_presentation_info() for bitstream version 0 and 1 (TS 103 190-1). */
function ac4PresentationInfo(
  reader: BitReader,
  fsIndex: number,
  frameRateIndex: number,
): Ac4PresentationInfo {
  const single = reader.bit();
  let config = 0;
  if (!single) {
    config = reader.read(3);
    if (config === 7) config += ac4VariableBits(reader, 2);
  }
  let versionBits = 0;
  while (reader.bit()) {
    versionBits += 1;
    if (versionBits > 32) throw new RangeError('AC-4 presentation_version runaway');
  }

  let channels: number | undefined;
  let sfMultiplier = 0;
  let addEmdf = false;
  if (!single && config === 6) {
    addEmdf = true;
  } else {
    reader.read(3); // md_compat
    if (reader.bit()) ac4VariableBits(reader, 2); // belongs_to_presentation_id
    ac4FrameRateMultiplyInfo(reader, frameRateIndex);
    ac4EmdfInfo(reader);
    if (single) {
      const info = ac4SubstreamInfo(reader, fsIndex);
      channels = info.channels;
      sfMultiplier = info.sfMultiplier;
    } else {
      const hsf = reader.bit();
      if (config <= 2) {
        const first = ac4SubstreamInfo(reader, fsIndex);
        channels = first.channels;
        sfMultiplier = first.sfMultiplier;
        if (hsf) ac4HsfExtSubstreamInfo(reader);
        ac4SubstreamInfo(reader, fsIndex);
      } else if (config === 3 || config === 4) {
        const first = ac4SubstreamInfo(reader, fsIndex);
        channels = first.channels;
        sfMultiplier = first.sfMultiplier;
        if (hsf) ac4HsfExtSubstreamInfo(reader);
        ac4SubstreamInfo(reader, fsIndex);
        ac4SubstreamInfo(reader, fsIndex);
      } else if (config === 5) {
        const first = ac4SubstreamInfo(reader, fsIndex);
        channels = first.channels;
        sfMultiplier = first.sfMultiplier;
        if (hsf) ac4HsfExtSubstreamInfo(reader);
      } else {
        ac4PresentationConfigExtInfo(reader);
      }
    }
    reader.read(2); // b_pre_virtualized + reserved
  }
  if (addEmdf) {
    let count = reader.read(2);
    if (count === 0) count = ac4VariableBits(reader, 2) + 4;
    for (let i = 0; i < count; i += 1) ac4EmdfInfo(reader);
  }
  return { ...(channels !== undefined ? { channels } : {}), sfMultiplier };
}

interface Ac4TocInfo {
  bitstreamVersion: number;
  sequenceCounter: number;
  fsIndex: number;
  frameRateIndex: number;
  iframeGlobal: boolean;
  sampleRate: number;
  frameRate?: number;
  channels?: number;
}

/** Parse the ac4_toc() element of a raw AC-4 frame. */
function parseAc4Toc(raw: Uint8Array): Ac4TocInfo {
  const reader = new BitReader(raw);
  let bitstreamVersion = reader.read(2);
  if (bitstreamVersion === 3) bitstreamVersion += ac4VariableBits(reader, 2);
  const sequenceCounter = reader.read(10);
  if (reader.bit() && reader.read(3) > 0) reader.read(2); // wait_frames
  const fsIndex = reader.read(1);
  const frameRateIndex = reader.read(4);
  const iframeGlobal = reader.bit();
  const singlePresentation = reader.bit();
  const presentationCount = singlePresentation
    ? 1
    : reader.bit()
      ? ac4VariableBits(reader, 2) + 2
      : 0;
  if (reader.bit()) {
    const base = reader.read(5) + 1; // payload_base
    if (base === 0x20) ac4VariableBits(reader, 3);
  }

  let channels: number | undefined;
  let sfMultiplier = 0;
  if (bitstreamVersion <= 1) {
    try {
      for (let i = 0; i < presentationCount; i += 1) {
        const presentation = ac4PresentationInfo(reader, fsIndex, frameRateIndex);
        if (i === 0) {
          channels = presentation.channels;
          sfMultiplier = presentation.sfMultiplier;
        }
      }
    } catch {
      // Keep the header fields that were already parsed; the presentation
      // walk is only needed for channels and the 96/192 kHz multiplier.
    }
  }

  const sampleRate =
    fsIndex === 0 ? 44100 : [48000, 96000, 192000][sfMultiplier] ?? 48000;
  const frameRate =
    fsIndex === 0 ? (frameRateIndex === 13 ? AC4_FRAME_RATES[13] : undefined) : AC4_FRAME_RATES[frameRateIndex];

  return {
    bitstreamVersion,
    sequenceCounter,
    fsIndex,
    frameRateIndex,
    iframeGlobal,
    sampleRate,
    ...(frameRate !== undefined ? { frameRate } : {}),
    ...(channels !== undefined ? { channels } : {}),
  };
}

/**
 * Parse an AC-4 sync frame (0xAC40 plain / 0xAC41 CRC protected) and its
 * table of contents. Version 2 TOCs are only described at header level.
 */
export function parseAc4(payload: Uint8Array): EsMetadata | undefined {
  for (let at = 0; at + 4 <= payload.length; at += 1) {
    if (payload[at] !== 0xac || (payload[at + 1] !== 0x40 && payload[at + 1] !== 0x41)) {
      continue;
    }
    const shortSize = ((payload[at + 2] as number) << 8) | (payload[at + 3] as number);
    let frameSize: number;
    let headerLength: number;
    if (shortSize === 0xffff) {
      if (at + 7 > payload.length) continue;
      frameSize =
        ((payload[at + 4] as number) << 16) |
        ((payload[at + 5] as number) << 8) |
        (payload[at + 6] as number);
      headerLength = 7;
    } else {
      frameSize = shortSize;
      headerLength = 4;
    }
    if (frameSize < 2) continue;
    const start = at + headerLength;
    const end = start + frameSize;
    if (end > payload.length) continue;
    const raw = payload.subarray(start, end);
    try {
      const info = parseAc4Toc(raw);
      const bitrateBps =
        info.frameRate !== undefined
          ? Math.round(frameSize * 8 * info.frameRate)
          : undefined;
      return {
        kind: 'audio',
        codec: 'AC-4',
        profile: `bitstream v${info.bitstreamVersion}`,
        sampleRate: info.sampleRate,
        ...(info.channels !== undefined ? { channels: info.channels } : {}),
        ...(info.frameRate !== undefined ? { frameRate: info.frameRate } : {}),
        ...(bitrateBps !== undefined ? { bitrateBps } : {}),
        format: 'AC-4',
      };
    } catch {
      // Sync word inside payload data or a truncated TOC.
    }
  }
  return undefined;
}

function findSync(data: Uint8Array, first: number, second: number): number {
  for (let i = 0; i + 1 < data.length; i += 1) {
    if (data[i] === first && data[i + 1] === second) return i;
  }
  return -1;
}

export function parseAdts(payload: Uint8Array): EsMetadata | undefined {
  let at = findSync(payload, 0xff, 0xf1);
  if (at < 0) at = findSync(payload, 0xff, 0xf9);
  if (at < 0 || at + 6 > payload.length) return undefined;
  const b1 = payload[at + 1] as number;
  const b2 = payload[at + 2] as number;
  const b3 = payload[at + 3] as number;
  if (((b1 >> 1) & 0x03) !== 0) return undefined;
  const profile = ((b2 >> 6) & 0x03) + 1;
  const sampleRateIndex = (b2 >> 2) & 0x0f;
  const channelConfig = ((b2 & 0x01) << 2) | ((b3 >> 6) & 0x03);
  const frameLength =
    ((b3 & 0x03) << 11) |
    ((payload[at + 4] as number) << 3) |
    ((payload[at + 5] as number) >> 5);
  if (sampleRateIndex > 12 || channelConfig < 1 || channelConfig > 7 || frameLength < 7) {
    return undefined;
  }
  const sampleRate = AAC_SAMPLE_RATES[sampleRateIndex];
  const channels = AAC_CHANNELS[channelConfig];
  const bitrateBps =
    sampleRate !== undefined && frameLength > 0 ? Math.round((frameLength * 8 * sampleRate) / 1024) : undefined;

  return {
    kind: 'audio',
    codec: 'AAC (ADTS)',
    profile: profile === 1 ? 'Main' : profile === 2 ? 'LC' : profile === 3 ? 'SSR' : 'LTP',
    ...(sampleRate !== undefined ? { sampleRate } : {}),
    ...(channels !== undefined ? { channels } : {}),
    ...(bitrateBps !== undefined ? { bitrateBps } : {}),
    format: 'ADTS',
  };
}

class LatmBitReader {
  private position = 0;
  constructor(private readonly data: Uint8Array) {}

  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = this.data[this.position >> 3] ?? 0;
      value = (value << 1) | ((byte >> (7 - (this.position & 7))) & 1);
      this.position += 1;
    }
    return value >>> 0;
  }

  skip(count: number): void {
    this.position += count;
  }

  get bitPosition(): number {
    return this.position;
  }

  get byteLength(): number {
    return this.data.length;
  }

  /** latmGetValue(): byte count followed by that many bytes. */
  latmGetValue(): number {
    const bytes = this.read(2);
    let value = 0;
    for (let i = 0; i < bytes; i += 1) value = value * 256 + this.read(8);
    return value;
  }
}

const AAC_OBJECT_TYPES: Record<number, string> = {
  1: 'Main',
  2: 'LC',
  3: 'SSR',
  4: 'LTP',
  5: 'HE-AAC',
  23: 'LD',
  29: 'HE-AAC v2',
  39: 'xHE-AAC',
};

function readAudioObjectType(reader: LatmBitReader): number {
  const value = reader.read(5);
  return value === 31 ? 32 + reader.read(6) : value;
}

function readSampleRateIndex(reader: LatmBitReader): number {
  const index = reader.read(4);
  if (index === 0x0f) {
    const explicit = reader.read(24);
    return AAC_SAMPLE_RATES.indexOf(explicit);
  }
  return index;
}

interface AudioSpecificConfig {
  objectType: number;
  coreSampleRate?: number;
  outputSampleRate?: number;
  channels?: number;
  profile: string;
}

function parseAudioSpecificConfig(reader: LatmBitReader): AudioSpecificConfig | undefined {
  let objectType = readAudioObjectType(reader);
  const sampleRateIndex = readSampleRateIndex(reader);
  const channelConfig = reader.read(4);
  if (objectType < 1 || objectType > 39 || sampleRateIndex < 0 || sampleRateIndex > 12) {
    return undefined;
  }

  const coreSampleRate = AAC_SAMPLE_RATES[sampleRateIndex];
  let outputSampleRate = coreSampleRate;
  let sbr = false;
  let ps = false;
  if (objectType === 5 || objectType === 29) {
    // Explicit hierarchical SBR: extension rate, then the core object type.
    sbr = true;
    ps = objectType === 29;
    const extensionIndex = readSampleRateIndex(reader);
    const extensionRate = AAC_SAMPLE_RATES[extensionIndex];
    if (extensionRate !== undefined) outputSampleRate = extensionRate;
    objectType = readAudioObjectType(reader);
    if (objectType < 1 || objectType > 39) return undefined;
  }

  const channels = AAC_CHANNELS[channelConfig];
  if (coreSampleRate === undefined || channels === undefined || channels === 0) return undefined;

  const profile = ps
    ? 'HE-AAC v2'
    : sbr
      ? 'HE-AAC'
      : (AAC_OBJECT_TYPES[objectType] ?? `AOT ${objectType}`);

  return {
    objectType,
    coreSampleRate,
    ...(outputSampleRate !== undefined ? { outputSampleRate } : {}),
    channels,
    profile,
  };
}

interface LatmConfig {
  config: AudioSpecificConfig;
}

function parseStreamMuxConfig(reader: LatmBitReader): LatmConfig | undefined {
  const audioMuxVersion = reader.read(1);
  if (audioMuxVersion) {
    const audioMuxVersionA = reader.read(1);
    // audioMuxVersionA == 1 is reserved for future use.
    if (audioMuxVersionA) return undefined;
    reader.latmGetValue(); // taraFullness
  }

  reader.read(1); // allStreamsSameTimeFraming
  reader.read(6); // numSubFrames
  const numProgram = reader.read(4);
  if (numProgram !== 0) return undefined;
  const numLayer = reader.read(3);
  if (numLayer !== 0) return undefined;

  let config: AudioSpecificConfig | undefined;
  if (audioMuxVersion) {
    const ascLength = reader.latmGetValue();
    const start = reader.bitPosition;
    config = parseAudioSpecificConfig(reader);
    const used = reader.bitPosition - start;
    if (used < ascLength) reader.skip(ascLength - used);
  } else {
    config = parseAudioSpecificConfig(reader);
  }
  if (!config) return undefined;

  return { config };
}

export function parseLatm(payload: Uint8Array): EsMetadata | undefined {
  for (let i = 0; i + 4 < payload.length; i += 1) {
    // AudioSyncStream(): syncword 0x2B7 (11 bits) + audioMuxLengthBytes (13).
    if (payload[i] !== 0x56 || ((payload[i + 1] as number) & 0xe0) !== 0xe0) continue;
    const length = (((payload[i + 1] as number) & 0x1f) << 8) | (payload[i + 2] as number);
    if (i + 3 + length > payload.length) continue;

    const reader = new LatmBitReader(payload.subarray(i + 3, i + 3 + length));
    if (reader.read(1) !== 0) {
      // useSameStreamMux: reuse a config carried in an earlier frame.
      i += 2 + length;
      continue;
    }
    const parsed = parseStreamMuxConfig(reader);
    if (!parsed) {
      i += 2 + length;
      continue;
    }

    const frameRate = parsed.config.outputSampleRate ?? parsed.config.coreSampleRate;
    const bitrateBps =
      parsed.config.coreSampleRate !== undefined
        ? Math.round((length * 8 * parsed.config.coreSampleRate) / 1024)
        : undefined;
    return {
      kind: 'audio',
      codec: 'AAC (LATM)',
      profile: parsed.config.profile,
      ...(frameRate !== undefined ? { sampleRate: frameRate } : {}),
      ...(parsed.config.channels !== undefined ? { channels: parsed.config.channels } : {}),
      ...(bitrateBps !== undefined ? { bitrateBps } : {}),
      format: 'LATM',
    };
  }
  return undefined;
}

export function parseMpegAudio(payload: Uint8Array): EsMetadata | undefined {
  for (let i = 0; i + 4 <= payload.length; i += 1) {
    if (payload[i] !== 0xff || ((payload[i + 1] as number) & 0xe0) !== 0xe0) continue;
    const b1 = payload[i + 1] as number;
    const b2 = payload[i + 2] as number;
    const b3 = payload[i + 3] as number;
    const version = (b1 >> 3) & 0x03;
    const layerBits = (b1 >> 1) & 0x03;
    const bitrateIndex = (b2 >> 4) & 0x0f;
    const sampleRateIndex = (b2 >> 2) & 0x03;
    const channelMode = (b3 >> 6) & 0x03;
    if (version === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15) continue;
    const layer = 4 - layerBits;
    const sampleRate = MPEG_SAMPLE_RATES[version]?.[sampleRateIndex];
    const bitrateTable = MPEG_BITRATES[`${version === 3 ? 1 : 2}-${layer}`];
    const bitrateKbps = bitrateTable?.[bitrateIndex];
    if (sampleRate === undefined || bitrateKbps === undefined || bitrateKbps <= 0) continue;
    return {
      kind: 'audio',
      codec: `MPEG-${version === 3 ? 1 : 2} Audio Layer ${layer === 1 ? 'I' : layer === 2 ? 'II' : 'III'}`,
      sampleRate,
      bitrateBps: bitrateKbps * 1000,
      channels: channelMode === 3 ? 1 : 2,
    };
  }
  return undefined;
}

export function parseAc3(payload: Uint8Array): EsMetadata | undefined {
  const at = findSync(payload, 0x0b, 0x77);
  if (at < 0 || at + 7 > payload.length) return undefined;
  const b2 = payload[at + 2] as number;
  const b3 = payload[at + 3] as number;
  const b4 = payload[at + 4] as number;
  const b5 = payload[at + 5] as number;
  const b6 = payload[at + 6] as number;
  const fscod = (b4 >> 6) & 0x03;
  const bsid = (b5 >> 3) & 0x1f;
  if (fscod > 2 || bsid > 16) return undefined;

  if (bsid <= 10) {
    const frmsizecod = b4 & 0x3f;
    const acmod = (b6 >> 5) & 0x07;
    let lfePosition = 3;
    if ((acmod & 0x01) !== 0 && acmod !== 1) lfePosition += 2;
    if ((acmod & 0x04) !== 0) lfePosition += 2;
    if (acmod === 2) lfePosition += 2;
    const lfeon = (b6 >> (7 - lfePosition)) & 0x01;
    const sampleRate = AC3_SAMPLE_RATES[fscod];
    const channels = (AC3_CHANNELS[acmod] ?? 2) + (lfeon ? 1 : 0);
    const bitrate = AC3_BITRATES[frmsizecod >> 1];
    if (sampleRate === undefined || bitrate === undefined) return undefined;
    return {
      kind: 'audio',
      codec: 'AC-3',
      sampleRate,
      channels,
      bitrateBps: bitrate * 1000,
    };
  }

  // E-AC-3 header: fscod(2) numblkscod(2) acmod(3) lfeon(1) in byte 4,
  // bsid(5) at the top of byte 5, frmsiz(11) in bytes 2-3.
  const numblkscod = (b4 >> 4) & 0x03;
  const acmod = (b4 >> 1) & 0x07;
  const lfeon = b4 & 0x01;
  const sampleRate =
    fscod === 3
      ? ([24000, 22050, 16000][numblkscod] ?? 0) / 2
      : AC3_SAMPLE_RATES[fscod];
  if (sampleRate === undefined || sampleRate === 0) return undefined;

  const frmsiz = ((b2 & 0x07) << 8) | b3;
  const blockCount = fscod === 3 ? 6 : numblkscod === 0 ? 1 : numblkscod === 1 ? 2 : numblkscod === 2 ? 3 : 6;
  const bitrateBps =
    frmsiz > 0
      ? Math.round((frmsiz * 2 * 8 * sampleRate) / (blockCount * 256))
      : undefined;

  return {
    kind: 'audio',
    codec: 'E-AC-3',
    sampleRate,
    channels: (AC3_CHANNELS[acmod] ?? 2) + (lfeon ? 1 : 0),
    ...(bitrateBps !== undefined ? { bitrateBps } : {}),
  };
}
