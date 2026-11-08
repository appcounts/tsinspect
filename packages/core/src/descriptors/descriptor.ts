import type { DescriptorInfo } from '../model/types.js';
import { hex, readU16, readU8 } from '../util/bytes.js';
import { parseDvbDateTime } from '../util/time.js';
import { decodeAribString } from './arib-string.js';
import { parseAtscMultipleString } from './atsc-string.js';

/** Text decoding rules used by the service/EPG descriptors of a standard. */
export type TextEncoding = 'dvb' | 'arib' | 'sbtvd';

function decodeBcdByte(value: number): number | undefined {
  const high = (value >> 4) & 0x0f;
  const low = value & 0x0f;
  if (high > 9 || low > 9) return undefined;
  return high * 10 + low;
}

function bcdTimeOffset(value: number, polarity: number): string | undefined {
  const hours = decodeBcdByte((value >> 8) & 0xff);
  const minutes = decodeBcdByte(value & 0xff);
  if (hours === undefined || minutes === undefined) return undefined;
  const sign = polarity === 1 ? '-' : '+';
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export interface RawDescriptor {
  tag: number;
  length: number;
  data: Uint8Array;
}

const NAMES: Record<number, string> = {
  0x02: 'Video stream',
  0x03: 'Audio stream',
  0x05: 'Registration',
  0x09: 'CA',
  0x0a: 'ISO 639 language',
  0x0b: 'System clock',
  0x0c: 'Multiplex buffer utilization',
  0x0d: 'Copyright',
  0x0e: 'Maximum bitrate',
  0x0f: 'Private data specifier',
  0x10: 'Smoothing buffer',
  0x11: 'STD',
  0x12: 'IBP',
  0x13: 'Carousel identifier',
  0x14: 'Association tag',
  0x1b: 'MPEG-4 video',
  0x1c: 'MPEG-4 audio',
  0x1d: 'IOD',
  0x1e: 'SL',
  0x1f: 'FMC',
  0x20: 'MHD',
  0x28: 'AVC video',
  0x29: 'AVC video (SVC)',
  0x2a: 'AVC video (MVC)',
  0x2b: 'HEVC video',
  0x2c: 'VVC video',
  0x2d: 'AVS3 video',
  0x38: 'HEVC timing and HRD',
  0x40: 'Network name',
  0x41: 'Service list',
  0x42: 'Stuffing',
  0x43: 'Satellite delivery',
  0x44: 'Cable delivery',
  0x45: 'VBI data',
  0x46: 'VBI teletext',
  0x47: 'Bouquet name',
  0x48: 'Service',
  0x49: 'Country availability',
  0x4a: 'Linkage',
  0x4b: 'NVOD reference',
  0x4c: 'Time shifted service',
  0x4d: 'Short event',
  0x4e: 'Extended event',
  0x4f: 'Time shifted event',
  0x50: 'Component',
  0x51: 'Mosaic',
  0x52: 'Stream identifier',
  0x53: 'CA identifier',
  0x54: 'Content',
  0x55: 'Parental rating',
  0x56: 'Teletext',
  0x57: 'Telephone',
  0x58: 'Local time offset',
  0x59: 'Subtitling',
  0x5a: 'Terrestrial delivery',
  0x5b: 'Multilingual network name',
  0x5c: 'Multilingual bouquet name',
  0x5d: 'Multilingual service name',
  0x5e: 'Multilingual component',
  0x5f: 'Private data specifier',
  0x60: 'Service move',
  0x61: 'Short smoothing buffer',
  0x62: 'Frequency list',
  0x63: 'Partial transport stream',
  0x64: 'Data broadcast',
  0x65: 'CA system',
  0x66: 'Data broadcast id',
  0x67: 'Transport stream',
  0x68: 'DSNG',
  0x69: 'PDC',
  0x6a: 'AC-3',
  0x6b: 'Ancillary data',
  0x6c: 'Cell list',
  0x6d: 'Cell frequency link',
  0x6e: 'Announcer',
  0x6f: 'Application signalling',
  0x70: 'Adaptation',
  0x71: 'Service identifier',
  0x72: 'Service availability',
  0x73: 'Default authority',
  0x74: 'Related content',
  0x75: 'TVA id',
  0x76: 'Content identifier',
  0x77: 'Time slice FEC identifier',
  0x78: 'ECM repetition rate',
  0x79: 'S2',
  0x7a: 'Enhanced AC-3',
  0x7b: 'DTS',
  0x7c: 'AAC',
  0x7d: 'Extension',
  0x7e: 'Extension (reserved)',
  0x7f: 'Extension',
  0x80: 'Stuffing',
  0x81: 'ATSC AC-3',
  0x82: 'ATSC program identifier',
  0x83: 'ATSC service location',
  0x84: 'ATSC time shifted service',
  0x85: 'ATSC component name',
  0x86: 'ATSC caption service',
  0x87: 'ATSC content advisory',
  0x88: 'ATSC private',
  0xa0: 'ATSC extended channel name',
  0xa1: 'ATSC service location',
  0xa2: 'ATSC time shifted service',
  0xa3: 'ATSC component name',
  0xa4: 'ATSC private',
  0xa5: 'ATSC private',
  0xc1: 'ISDB digital copy control',
  0xc2: 'ISDB maximum bitrate',
  0xc3: 'ISDB TS information',
  0xc4: 'ISDB extended event',
  0xc5: 'ISDB local time offset',
  0xc6: 'ISDB partial reception',
  0xc7: 'ISDB hierarchy',
  0xc8: 'ISDB video decode control',
  0xc9: 'ISDB data content',
  0xca: 'ISDB video encode control',
  0xcb: 'ISDB still picture',
  0xcc: 'ISDB external application',
  0xd0: 'ISDB private',
  0xf6: 'ISDB access control',
  0xfc: 'ISDB emergency information',
  0xfd: 'ISDB data component',
};

export function descriptorName(tag: number): string {
  return NAMES[tag] ?? `Private (0x${tag.toString(16).padStart(2, '0').toUpperCase()})`;
}

const CONTENT_LEVEL1_NAMES = [
  'undefined',
  'movie/drama',
  'news/current affairs',
  'show/game show',
  'sports',
  "children's/youth programmes",
  'music/ballet/dance',
  'arts/culture',
  'social/political issues/economics',
  'education/science/factual topics',
  'leisure/hobbies',
  'reserved',
  'reserved',
  'reserved',
  'reserved',
  'user defined',
];

const CONTENT_LEVEL2_NAMES: Record<number, string[]> = {
  0x1: [
    'movie/drama (general)',
    'detective/thriller',
    'adventure/western',
    'science fiction/fantasy/horror',
    'comedy',
    'soap/melodrama/folklore',
    'romance',
    'historical/period',
    'biography',
    'musical/opera',
    'adult',
  ],
  0x2: [
    'news/current affairs (general)',
    'news/weather report',
    'news magazine',
    'documentary',
    'discussion/interview/debate',
  ],
  0x3: ['show/game show (general)', 'game show/quiz/contest', 'variety show', 'talk show'],
  0x4: [
    'sports (general)',
    'special events',
    'sports magazines',
    'football/soccer',
    'tennis/squash',
    'team sports',
    'motor sport',
    'water sport',
    'winter sports',
    'equestrian',
    'martial arts',
    'cycling',
  ],
  0x5: ["children's/youth (general)", 'pre-school', 'entertainment', 'cartoon'],
  0x6: [
    'music/ballet/dance (general)',
    'rock/pop',
    'classical music',
    'folk/traditional music',
    'jazz',
    'musical/opera',
    'ballet',
  ],
  0x7: [
    'arts/culture (general)',
    'performing arts',
    'fine arts',
    'religion',
    'popular culture/traditional arts',
    'literature',
    'film/cinema',
  ],
  0x8: [
    'social/political issues/economics (general)',
    'magazines/reports',
    'economics/social advisory',
    'remarkable people',
  ],
  0x9: [
    'education/science/factual topics (general)',
    'nature/animals/environment',
    'technology/natural sciences',
    'medicine/physiology/psychology',
    'foreign countries/expeditions',
    'social/spiritual sciences',
    'further education',
    'languages',
  ],
  0xa: [
    'leisure/hobbies (general)',
    'gardening',
    'travel',
    'handicraft',
    'motoring',
    'fitness/health',
    'cooking',
    'shopping',
  ],
};

function contentGenreName(level1: number, level2: number): string {
  if (level1 === 0) return 'unclassified';
  const first = CONTENT_LEVEL1_NAMES[level1] ?? `content 0x${level1.toString(16)}`;
  const second = CONTENT_LEVEL2_NAMES[level1]?.[level2];
  return second ?? first;
}

const ISO639_AUDIO_TYPES: Record<number, string> = {
  0x00: 'undefined',
  0x01: 'clean effects',
  0x02: 'hearing impaired',
  0x03: 'visual impaired commentary',
  0x80: 'primary',
  0x81: 'native',
  0x82: 'emergency',
  0x83: 'primary commentary',
  0x84: 'alternate commentary',
};

function iso639AudioTypeName(value: number): string {
  const known = ISO639_AUDIO_TYPES[value];
  if (known) return known;
  if (value >= 0x04 && value <= 0x7f) return `user private (0x${value.toString(16).padStart(2, '0')})`;
  return `reserved (0x${value.toString(16).padStart(2, '0')})`;
}

const ATSC_BSMOD_NAMES = [
  'complete main',
  'music and effects',
  'visually impaired',
  'hearing impaired',
  'dialogue',
  'commentary',
  'emergency',
  'voice over',
];

const SUPPLEMENTARY_AUDIO_NAMES: Record<number, string> = {
  0x00: 'main audio',
  0x01: 'audio description',
  0x02: 'clean audio for the hearing impaired',
  0x03: 'spoken subtitles',
  0x04: 'dependent parametric data',
  0x17: 'general audience supplementary audio',
};

function supplementaryAudioName(value: number): string {
  const known = SUPPLEMENTARY_AUDIO_NAMES[value];
  if (known) return known;
  if (value >= 0x18 && value <= 0x1f) return 'user defined';
  return 'reserved';
}

const SUBTITLE_TYPE_NAMES: Record<number, string> = {
  0x10: 'DVB subtitles (normal)',
  0x11: 'DVB subtitles (hearing impaired)',
  0x12: 'DVB subtitles (normal, 4:3)',
  0x13: 'DVB subtitles (hearing impaired, 4:3)',
  0x14: 'DVB subtitles (normal, 16:9)',
  0x15: 'DVB subtitles (hearing impaired, 16:9)',
  0x20: 'Teletext subtitles (normal)',
  0x21: 'Teletext subtitles (hearing impaired)',
  0x22: 'Teletext subtitles (normal, 4:3)',
  0x23: 'Teletext subtitles (hearing impaired, 4:3)',
  0x24: 'Teletext subtitles (normal, 16:9)',
  0x25: 'Teletext subtitles (hearing impaired, 16:9)',
  0x30: 'Open subtitles',
};

function subtitleTypeName(value: number): string {
  return SUBTITLE_TYPE_NAMES[value] ?? `reserved (0x${value.toString(16).padStart(2, '0')})`;
}

const TELETEXT_TYPE_NAMES: Record<number, string> = {
  0x01: 'initial page',
  0x02: 'subtitle page',
  0x03: 'additional information',
  0x04: 'programme schedule',
  0x05: 'hearing impaired subtitle page',
};

function teletextTypeName(value: number): string {
  return TELETEXT_TYPE_NAMES[value] ?? `reserved (${value})`;
}

function dataComponentName(value: number): string {
  switch (value) {
    case 0x0008:
      return 'ARIB caption';
    case 0x0012:
      return 'ARIB superimpose';
    case 0x0009:
    case 0x000c:
    case 0x000d:
      return 'ARIB data';
    default:
      return `data component (0x${value.toString(16).padStart(4, '0').toUpperCase()})`;
  }
}

/** Trailing 3-byte ISO 639 language codes in an AC-3 descriptor. */
function trailingLanguageCodes(data: Uint8Array): string[] {
  const codes: string[] = [];
  let end = data.length;
  while (codes.length < 2 && end >= 3) {
    const code = ascii(data.subarray(end - 3, end));
    if (!/^[a-z]{3}$/.test(code)) break;
    codes.unshift(code);
    end -= 3;
  }
  return codes;
}

export function parseRawDescriptors(data: Uint8Array, start: number, length: number): RawDescriptor[] {
  const descriptors: RawDescriptor[] = [];
  const end = Math.min(data.length, start + length);
  let cursor = start;

  while (cursor + 2 <= end) {
    const tag = readU8(data, cursor);
    const descLength = readU8(data, cursor + 1);
    if (cursor + 2 + descLength > end) break;
    descriptors.push({
      tag,
      length: descLength,
      data: data.subarray(cursor + 2, cursor + 2 + descLength),
    });
    cursor += 2 + descLength;
  }

  return descriptors;
}

/** One event entry of an ISDB emergency_information_descriptor (tag 0xFC). */
export interface EmergencyInformationEvent {
  serviceId: number;
  started: boolean;
  /** 0 = first-level (EWBS) signal, 1 = second-level signal. */
  signalLevel: number;
  areaCodes: number[];
}

/**
 * Parse the ISDB emergency_information_descriptor used by EWBS
 * (ARIB STD-B10, 6.2.24).
 */
export function parseEmergencyInformationDescriptor(
  data: Uint8Array,
): EmergencyInformationEvent[] {
  const events: EmergencyInformationEvent[] = [];
  let cursor = 0;
  while (cursor + 4 <= data.length) {
    const serviceId = readU16(data, cursor);
    const flags = readU8(data, cursor + 2);
    cursor += 3;
    const areaLength = readU8(data, cursor);
    cursor += 1;
    const end = Math.min(data.length, cursor + areaLength);
    const areaCodes: number[] = [];
    while (cursor + 2 <= end) {
      areaCodes.push(readU16(data, cursor) >> 4);
      cursor += 2;
    }
    cursor = end;
    events.push({
      serviceId,
      started: (flags & 0x80) !== 0,
      signalLevel: (flags & 0x40) >> 6,
      areaCodes,
    });
  }
  return events;
}

function ascii(data: Uint8Array): string {
  let out = '';
  for (const value of data) {
    out += value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : '.';
  }
  return out;
}

/** Decode an ATSC Multiple String Structure into descriptor fields. */
function applyAtscStrings(
  fields: Record<string, string | number | boolean>,
  data: Uint8Array,
): void {
  const strings = parseAtscMultipleString(data);
  const decoded = strings.find((entry) => entry.text.length > 0);
  if (decoded) {
    fields.language = decoded.language;
    fields.name = decoded.text;
  }
  if (strings.length > 1) {
    fields.strings = strings
      .map((entry) => `${entry.language}:${entry.text || '(undecoded)'}`)
      .join('; ');
  }
  const hasUndecoded = strings.some((entry) =>
    entry.segments.some((segment) => segment.text === null),
  );
  if (hasUndecoded) fields.encoding = 'unsupported Huffman/SCSU segment';
}

/** Encoding byte (first character of a DVB string) to a TextDecoder label. */
const DVB_ENCODINGS: Record<number, string> = {
  0x01: 'iso-8859-5',
  0x02: 'iso-8859-6',
  0x03: 'iso-8859-7',
  0x04: 'iso-8859-8',
  0x05: 'iso-8859-9',
  0x06: 'iso-8859-10',
  0x07: 'iso-8859-11',
  0x09: 'iso-8859-13',
  0x0a: 'iso-8859-14',
  0x0b: 'iso-8859-15',
  0x11: 'utf-16be',
  0x12: 'euc-kr',
  0x13: 'gbk',
  0x14: 'big5',
  0x15: 'utf-8',
};

/**
 * ISO 6937 non-spacing diacritics (0xC1-0xCF). They combine with the following
 * character, or stand alone when followed by a space.
 */
const ISO6937_COMBINING: Record<number, string> = {
  0xc1: '\u0300',
  0xc2: '\u0301',
  0xc3: '\u0302',
  0xc4: '\u0303',
  0xc5: '\u0304',
  0xc6: '\u0306',
  0xc7: '\u0307',
  0xc8: '\u0308',
  0xca: '\u030a',
  0xcb: '\u0327',
  0xcd: '\u030b',
  0xce: '\u0328',
  0xcf: '\u030c',
};

const ISO6937_SPACING: Record<number, string> = {
  0xc1: '\u0060',
  0xc2: '\u00b4',
  0xc3: '\u005e',
  0xc4: '\u007e',
  0xc5: '\u00af',
  0xc6: '\u02d8',
  0xc7: '\u02d9',
  0xc8: '\u00a8',
  0xca: '\u02da',
  0xcb: '\u00b8',
  0xcd: '\u02dd',
  0xce: '\u02db',
  0xcf: '\u02c7',
};

/**
 * ISO 6937 upper half. Positions not listed here match ISO-8859-1; the listed
 * ones differ (punctuation, fractions, ligatures and Greek/Scandinavian
 * letters). Teletext G2 uses the same table shifted by 0x80.
 */
const ISO6937_HIGH: Record<number, string> = {
  0xa0: '\u00a0',
  0xa4: '$',
  0xa6: '#',
  0xa8: '\u00a4',
  0xa9: '\u2018',
  0xaa: '\u201c',
  0xab: '\u00ab',
  0xac: '\u2190',
  0xad: '\u2191',
  0xae: '\u2192',
  0xaf: '\u2193',
  0xb4: '\u00d7',
  0xb8: '\u00f7',
  0xb9: '\u2019',
  0xba: '\u201d',
  0xbb: '\u00bb',
  0xbc: '\u00bc',
  0xbd: '\u00bd',
  0xbe: '\u00be',
  0xbf: '\u00bf',
  0xd0: '\u2014',
  0xd1: '\u00b9',
  0xd2: '\u00ae',
  0xd3: '\u00a9',
  0xd4: '\u2122',
  0xd5: '\u266a',
  0xd6: '\u00ac',
  0xd7: '\u00a6',
  0xdc: '\u215b',
  0xdd: '\u215c',
  0xde: '\u215d',
  0xdf: '\u215e',
  0xe0: '\u03a9',
  0xe1: '\u00c6',
  0xe2: '\u0110',
  0xe3: '\u00aa',
  0xe4: '\u0126',
  0xe6: '\u0132',
  0xe7: '\u013f',
  0xe8: '\u0141',
  0xe9: '\u00d8',
  0xea: '\u0152',
  0xeb: '\u00ba',
  0xec: '\u00de',
  0xed: '\u0166',
  0xee: '\u014a',
  0xef: '\u0149',
  0xf0: '\u0138',
  0xf1: '\u00e6',
  0xf2: '\u0111',
  0xf3: '\u00f0',
  0xf4: '\u0127',
  0xf5: '\u0131',
  0xf6: '\u0133',
  0xf7: '\u0140',
  0xf8: '\u0142',
  0xf9: '\u00f8',
  0xfa: '\u0153',
  0xfb: '\u00df',
  0xfc: '\u00fe',
  0xfd: '\u0167',
  0xfe: '\u014b',
};

/** ISO 6937 character for the teletext G2 supplementary set (0x20-0x7F). */
export function iso6937G2(code: number): string | undefined {
  if (code < 0x20 || code > 0x7f) return undefined;
  if (code === 0x20) return ' ';
  const high = ISO6937_HIGH[code + 0x80];
  if (high !== undefined) return high;
  if (code >= 0x21 && code <= 0x3f) return String.fromCharCode(code);
  return undefined;
}

function decodeIso6937(data: Uint8Array): string {
  let out = '';
  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index] as number;
    if (byte === 0x00) continue;
    if (byte < 0x20 || (byte >= 0x80 && byte < 0xa0)) {
      // 0x8A is the DVB line break, other C0/C1 codes are control codes.
      if (byte === 0x8a || byte === 0x0a) out += '\n';
      continue;
    }
    if (byte === 0x7f) {
      out += ' ';
      continue;
    }
    const combining = ISO6937_COMBINING[byte];
    if (combining !== undefined) {
      const next = data[index + 1];
      if (next !== undefined && next !== 0x20 && next >= 0x20) {
        out += (ISO6937_HIGH[next] ?? String.fromCharCode(next)) + combining;
        index += 1;
      } else {
        if (next === 0x20) index += 1;
        out += ISO6937_SPACING[byte] ?? '';
      }
      continue;
    }
    out += ISO6937_HIGH[byte] ?? String.fromCharCode(byte);
  }
  return out.normalize('NFC');
}

function finishDvbString(text: string): string {
  return text.replace(/\0/g, '').replace(/\s+$/g, '');
}

/**
 * Decode a DVB/ATSC text string. DVB's default charset is ISO 6937; explicit
 * encodings (UTF-8, UTF-16BE, ISO-8859-x) are handled by TextDecoder.
 */
export function decodeDvbString(data: Uint8Array): string {
  if (data.length === 0) return '';
  const first = data[0] as number;

  if (first === 0x1f) {
    // 0x1F: encoding_type_id (8 bits), length (8 bits), then the payload.
    const encodingTypeId = data[1] ?? 0;
    const length = data[2] ?? 0;
    const payload = data.subarray(3, Math.min(data.length, 3 + length));
    try {
      const label = encodingTypeId === 0x01 ? 'utf-16be' : 'utf-8';
      return finishDvbString(new TextDecoder(label).decode(payload));
    } catch {
      return finishDvbString(ascii(payload));
    }
  }

  const encoding = first < 0x20 ? DVB_ENCODINGS[first] : undefined;
  if (encoding === undefined) return finishDvbString(decodeIso6937(data));

  try {
    return finishDvbString(new TextDecoder(encoding).decode(data.subarray(1)));
  } catch {
    return finishDvbString(ascii(data.subarray(1)));
  }
}

const POLARIZATION_NAMES = [
  'linear horizontal',
  'linear vertical',
  'circular left',
  'circular right',
];
const SATELLITE_MODULATION_NAMES = [
  'auto',
  'QPSK',
  '8PSK',
  '16APSK',
  '32APSK',
  'reserved',
  'reserved',
  'reserved',
];
const CABLE_MODULATION_NAMES = [
  'auto',
  '16QAM',
  '32QAM',
  '64QAM',
  '128QAM',
  '256QAM',
  'reserved',
  'reserved',
];
const TERRESTRIAL_CONSTELLATION_NAMES = ['QPSK', '16QAM', '64QAM', 'reserved'];
const CODE_RATE_NAMES = ['1/2', '2/3', '3/4', '5/6', '7/8', 'reserved', 'reserved', 'reserved'];
const GUARD_INTERVAL_NAMES = ['1/32', '1/16', '1/8', '1/4'];
const TRANSMISSION_MODE_NAMES = ['2K', '8K', '4K', 'reserved'];
const BANDWIDTH_NAMES = [
  '8 MHz',
  '7 MHz',
  '6 MHz',
  '5 MHz',
  '1.712 MHz',
  'reserved',
  'reserved',
  'reserved',
];
const FEC_OUTER_NAMES = [
  'not defined',
  'none',
  'RS(204,188)',
  'reserved',
  'reserved',
  'reserved',
  'reserved',
  'reserved',
];
const ROLL_OFF_NAMES = ['0.35', '0.25', '0.20', 'reserved'];
const LINKAGE_TYPE_NAMES: Record<number, string> = {
  0x01: 'information service',
  0x02: 'EPG service',
  0x03: 'CA replacement service',
  0x04: 'TS containing complete network/bouquet SI',
  0x05: 'service replacement service',
  0x06: 'data broadcast service',
  0x07: 'RCS map',
  0x08: 'mobile hand-over',
  0x09: 'system software update service',
  0x0a: 'TS containing SSU BAT or NIT',
  0x0b: 'IP/MAC notification service',
  0x0c: 'event linkage',
  0x0d: 'extended event linkage',
};

const EXTENSION_NAMES: Record<number, string> = {
  0x06: 'Supplementary audio',
  0x15: 'AC-4',
  0x19: 'Audio preselection',
};

function nameOr(value: number, names: string[]): string {
  return names[value] ?? `reserved (${value})`;
}

export function describeDescriptor(
  raw: RawDescriptor,
  textEncoding: TextEncoding = 'dvb',
): DescriptorInfo {
  const d = raw.data;
  const fields: Record<string, string | number | boolean> = {};
  const decodeText =
    textEncoding === 'arib'
      ? (value: Uint8Array): string => decodeAribString(value)
      : textEncoding === 'sbtvd'
        ? (value: Uint8Array): string => decodeAribString(value, { profile: 'brazil' })
        : (value: Uint8Array): string => decodeDvbString(value);

  switch (raw.tag) {
    case 0x05:
      fields.formatIdentifier = ascii(d.subarray(0, 4));
      break;
    case 0x09:
      fields.caSystemId = readU16(d, 0);
      fields.caPid = readU16(d, 2) & 0x1fff;
      break;
    case 0x0a: {
      const count = Math.max(1, Math.floor(d.length / 4));
      const languages: string[] = [];
      const audioTypes: string[] = [];
      let audioDescription = false;
      let hearingImpaired = false;
      for (let i = 0; i < count; i += 1) {
        const base = i * 4;
        if (base + 3 > d.length) break;
        const language = ascii(d.subarray(base, base + 3));
        const type = readU8(d, base + 3);
        languages.push(language);
        audioTypes.push(iso639AudioTypeName(type));
        if (type === 0x03) audioDescription = true;
        if (type === 0x02) hearingImpaired = true;
      }
      if (languages.length > 0) fields.languages = languages.join(', ');
      if (audioTypes.length > 0) fields.audioTypes = audioTypes.join(', ');
      if (audioDescription) fields.audioDescription = true;
      if (hearingImpaired) fields.hearingImpaired = true;
      break;
    }
    case 0x13: {
      // carousel_identifier_descriptor (EN 300 468, 6.2.9).
      if (d.length >= 5) {
        const carouselId = readU32(d, 0);
        fields.carouselId = carouselId;
        fields.carouselIdHex = `0x${carouselId.toString(16).padStart(8, '0').toUpperCase()}`;
        fields.formatId = readU8(d, 4);
        if (d.length > 5) fields.formatSpecifier = hex(d, 5);
      }
      break;
    }
    case 0x14: {
      // association_tag_descriptor (EN 300 468, 6.2.7).
      if (d.length >= 2) {
        fields.associationTag = readU16(d, 0);
        fields.associationTagHex = `0x${readU16(d, 0).toString(16).padStart(4, '0').toUpperCase()}`;
        if (d.length > 2) fields.additionalData = hex(d, 2);
      }
      break;
    }
    case 0x40:
      fields.name = decodeText(d);
      break;
    case 0x47:
      fields.name = decodeText(d);
      break;
    case 0xd8:
      fields.name = decodeText(d);
      break;
    case 0x41: {
      const services: string[] = [];
      for (let i = 0; i + 3 <= d.length; i += 3) {
        services.push(`${readU16(d, i)}:${readU8(d, i + 2)}`);
      }
      fields.services = services.join(', ');
      break;
    }
    case 0x43: {
      // satellite_delivery_system_descriptor (EN 300 468, 6.2.13.1).
      const frequency = readU32(d, 0);
      const orbitalPosition = readU16(d, 5);
      const flags = readU8(d, 6);
      const polarization = (flags >> 5) & 0x03;
      const modulation = flags & 0x1f;
      const symbolRate = readU32(d, 7) >>> 4;
      const fecInner = readU8(d, 10) & 0x0f;
      fields.frequency = frequency * 10;
      fields.orbitalPosition = (orbitalPosition % 3600) / 10;
      fields.westEast = (flags & 0x80) !== 0 ? 'west' : 'east';
      fields.polarization = polarization;
      fields.polarizationName = nameOr(polarization, POLARIZATION_NAMES);
      fields.modulation = modulation;
      fields.modulationName = nameOr(modulation, SATELLITE_MODULATION_NAMES);
      fields.symbolRate = symbolRate * 100;
      fields.fecInner = fecInner;
      fields.fecInnerName = nameOr(fecInner, CODE_RATE_NAMES);
      if (d.length >= 12) {
        const rollOff = (readU8(d, 11) >> 4) & 0x03;
        fields.rollOff = rollOff;
        fields.rollOffName = nameOr(rollOff, ROLL_OFF_NAMES);
      }
      break;
    }
    case 0x44: {
      // cable_delivery_system_descriptor (EN 300 468, 6.2.13.2).
      const frequency = readU32(d, 0);
      const fecOuter = readU8(d, 4) & 0x0f;
      const modulation = readU8(d, 5);
      const symbolRate = readU32(d, 6) >>> 4;
      const fecInner = readU8(d, 9) & 0x0f;
      fields.frequency = frequency * 100;
      fields.fecOuter = fecOuter;
      fields.fecOuterName = nameOr(fecOuter, FEC_OUTER_NAMES);
      fields.modulation = modulation;
      fields.modulationName = nameOr(modulation, CABLE_MODULATION_NAMES);
      fields.symbolRate = symbolRate * 100;
      fields.fecInner = fecInner;
      fields.fecInnerName = nameOr(fecInner, CODE_RATE_NAMES);
      break;
    }
    case 0x48: {
      fields.serviceType = readU8(d, 0);
      const providerLength = readU8(d, 1);
      fields.providerName = decodeText(d.subarray(2, 2 + providerLength));
      const nameLength = readU8(d, 2 + providerLength);
      fields.serviceName = decodeText(
        d.subarray(3 + providerLength, 3 + providerLength + nameLength),
      );
      break;
    }
    case 0x4a: {
      // linkage_descriptor (EN 300 468, 6.2.19).
      if (d.length >= 7) {
        const transportStreamId = readU16(d, 0);
        const originalNetworkId = readU16(d, 2);
        const serviceId = readU16(d, 4);
        const linkageType = readU8(d, 6);
        fields.transportStreamId = transportStreamId;
        fields.originalNetworkId = originalNetworkId;
        fields.serviceId = serviceId;
        fields.linkageType = linkageType;
        fields.linkageTypeName = LINKAGE_TYPE_NAMES[linkageType] ?? `reserved (${linkageType})`;
        if (linkageType === 0x08 && d.length >= 9) {
          const handOver = readU8(d, 7);
          fields.handOverType = handOver >> 4;
          fields.originatorNetworkId = readU16(d, 8);
        } else if (linkageType === 0x0d && d.length >= 8) {
          fields.targetEventId = readU16(d, 7);
        }
      }
      break;
    }
    case 0x4b: {
      // nvod_reference_descriptor (EN 300 468, 6.2.28).
      const references: string[] = [];
      for (let i = 0; i + 12 <= d.length; i += 12) {
        const tsid = readU16(d, i);
        const onid = readU16(d, i + 2);
        const serviceId = readU16(d, i + 4);
        const eventId = readU16(d, i + 10) & 0x0fff;
        references.push(`${tsid}/${onid}/${serviceId}/${eventId}`);
      }
      fields.nvodReferences = references.length;
      if (references.length > 0) fields.references = references.join(', ');
      break;
    }
    case 0x4c:
      fields.referenceServiceId = readU16(d, 0);
      break;
    case 0x4d: {
      fields.language = ascii(d.subarray(0, 3));
      const nameLength = readU8(d, 3);
      fields.eventName = decodeText(d.subarray(4, 4 + nameLength));
      const textLength = readU8(d, 4 + nameLength);
      fields.text = decodeText(d.subarray(5 + nameLength, 5 + nameLength + textLength));
      break;
    }
    case 0x4e: {
      fields.descriptorNumber = readU8(d, 0) >> 4;
      fields.lastDescriptorNumber = readU8(d, 0) & 0x0f;
      fields.language = ascii(d.subarray(1, 4));
      const itemsLength = readU8(d, 4);
      const items: string[] = [];
      let itemCursor = 5;
      const itemsEnd = Math.min(d.length, itemCursor + itemsLength);
      while (itemCursor + 2 <= itemsEnd) {
        const descriptionLength = readU8(d, itemCursor);
        const description = decodeText(
          d.subarray(itemCursor + 1, itemCursor + 1 + descriptionLength),
        );
        itemCursor += 1 + descriptionLength;
        if (itemCursor >= itemsEnd) break;
        const valueLength = readU8(d, itemCursor);
        const value = decodeText(d.subarray(itemCursor + 1, itemCursor + 1 + valueLength));
        itemCursor += 1 + valueLength;
        items.push(`${description}=${value}`);
      }
      if (items.length > 0) fields.items = items.join('; ');
      if (itemCursor < d.length) {
        const textLength = readU8(d, itemCursor);
        fields.text = decodeText(d.subarray(itemCursor + 1, itemCursor + 1 + textLength));
      }
      break;
    }
    case 0x4f:
      fields.referenceServiceId = readU16(d, 0);
      fields.referenceEventId = readU16(d, 2);
      break;
    case 0x50: {
      const first = readU8(d, 0);
      fields.streamContent = first >> 4;
      fields.componentType = first & 0x0f;
      fields.componentTag = readU8(d, 1);
      fields.language = ascii(d.subarray(2, 5));
      fields.text = decodeText(d.subarray(5));
      break;
    }
    case 0x52:
      fields.componentTag = readU8(d, 0);
      break;
    case 0x53: {
      // CA_identifier_descriptor: ca_system_id list.
      const systems: number[] = [];
      for (let i = 0; i + 2 <= d.length; i += 2) systems.push(readU16(d, i));
      if (systems.length > 0) fields.caSystemIds = systems.join(', ');
      break;
    }
    case 0x54: {
      const contents: string[] = [];
      const names: string[] = [];
      for (let i = 0; i + 2 <= d.length; i += 2) {
        const b0 = readU8(d, i);
        const b1 = readU8(d, i + 1);
        const level1 = b0 >> 4;
        const level2 = b0 & 0x0f;
        const user1 = b1 >> 4;
        const user2 = b1 & 0x0f;
        contents.push(`${level1}/${level2}/${user1}/${user2}`);
        const name = contentGenreName(level1, level2);
        names.push(
          user1 !== 0 || user2 !== 0 ? `${name} (user ${user1}/${user2})` : name,
        );
      }
      fields.content = contents.join(', ');
      if (names.length > 0) fields.contentName = names.join('; ');
      break;
    }
    case 0x55: {
      // parental_rating_descriptor: country_code(24) + rating(8), repeated.
      const ratings: string[] = [];
      const summary: string[] = [];
      for (let i = 0; i + 4 <= d.length; i += 4) {
        const country = ascii(d.subarray(i, i + 3));
        const rating = readU8(d, i + 3);
        ratings.push(`${country}: ${rating}`);
        summary.push(`${country}: rating ${rating}`);
      }
      fields.ratings = ratings.join(', ');
      if (summary.length > 0) fields.ratingSummary = summary.join(', ');
      if (d.length >= 4) {
        fields.countryCode = ascii(d.subarray(0, 3));
        fields.rating = readU8(d, 3);
        const rating = readU8(d, 3);
        if (rating >= 0x01 && rating <= 0x0f) fields.minimumAge = rating + 3;
      }
      break;
    }
    case 0x56: {
      const pages: string[] = [];
      const types: string[] = [];
      const languages = new Set<string>();
      for (let i = 0; i + 5 <= d.length; i += 5) {
        const language = ascii(d.subarray(i, i + 3));
        const type = (readU8(d, i + 3) >> 3) & 0x1f;
        const magazine = readU8(d, i + 3) & 0x07;
        const page = readU8(d, i + 4);
        languages.add(language);
        types.push(`${language} ${teletextTypeName(type)}`);
        if (type === 0x05) fields.hearingImpaired = true;
        pages.push(`${language} type=${type} ${magazine}:${page.toString(16).padStart(2, '0')}`);
      }
      fields.pages = pages.join(', ');
      if (types.length > 0) fields.teletextTypes = types.join(', ');
      if (languages.size > 0) fields.languages = [...languages].join(', ');
      break;
    }
    case 0x58: {
      fields.countryCode = ascii(d.subarray(0, 3));
      const flags = readU8(d, 3);
      fields.countryRegionId = (flags >> 2) & 0x3f;
      const polarity = flags & 0x01;
      const offset = bcdTimeOffset(readU16(d, 4), polarity);
      if (offset !== undefined) fields.localTimeOffset = offset;
      const change = parseDvbDateTime(d, 6);
      if (change) fields.timeOfChange = change.iso;
      if (d.length >= 13) {
        const next = bcdTimeOffset(readU16(d, 11), polarity);
        if (next !== undefined) fields.nextTimeOffset = next;
      }
      break;
    }
    case 0x59: {
      const pages: string[] = [];
      const types: string[] = [];
      const languages = new Set<string>();
      for (let i = 0; i + 8 <= d.length; i += 8) {
        const language = ascii(d.subarray(i, i + 3));
        const type = readU8(d, i + 3);
        languages.add(language);
        types.push(`${language} ${subtitleTypeName(type)}`);
        if ([0x11, 0x13, 0x15, 0x21, 0x23, 0x25].includes(type)) {
          fields.hearingImpaired = true;
        }
        const composition = readU16(d, i + 4);
        const ancillary = readU16(d, i + 6);
        pages.push(`${language} type=${type} page=${composition}/${ancillary}`);
      }
      fields.pages = pages.join(', ');
      if (types.length > 0) fields.subtitleTypes = types.join(', ');
      if (languages.size > 0) fields.languages = [...languages].join(', ');
      break;
    }
    case 0x5a: {
      // terrestrial_delivery_system_descriptor (EN 300 468, 6.2.13.3).
      const bandwidth = readU8(d, 4) >> 5;
      const priority = (readU8(d, 4) >> 4) & 0x01;
      const timeSlicing = (readU8(d, 4) >> 3) & 0x01;
      const mpeFec = (readU8(d, 4) >> 2) & 0x01;
      const constellation = (readU8(d, 5) >> 6) & 0x03;
      const hierarchy = (readU8(d, 5) >> 3) & 0x07;
      const codeRateHp = (readU8(d, 6) >> 5) & 0x07;
      const codeRateLp = (readU8(d, 6) >> 2) & 0x07;
      const guardInterval = (readU8(d, 7) >> 6) & 0x03;
      const transmissionMode = (readU8(d, 7) >> 4) & 0x03;
      fields.centreFrequency = readU32(d, 0) * 10;
      fields.bandwidth = bandwidth;
      fields.bandwidthName = nameOr(bandwidth, BANDWIDTH_NAMES);
      fields.priority = priority;
      fields.timeSlicing = timeSlicing !== 0;
      fields.mpeFec = mpeFec !== 0;
      fields.constellation = constellation;
      fields.constellationName = nameOr(constellation, TERRESTRIAL_CONSTELLATION_NAMES);
      fields.hierarchy = hierarchy;
      fields.codeRateHp = codeRateHp;
      fields.codeRateHpName = nameOr(codeRateHp, CODE_RATE_NAMES);
      fields.codeRateLp = codeRateLp;
      fields.codeRateLpName = nameOr(codeRateLp, CODE_RATE_NAMES);
      fields.guardInterval = guardInterval;
      fields.guardIntervalName = nameOr(guardInterval, GUARD_INTERVAL_NAMES);
      fields.transmissionMode = transmissionMode;
      fields.transmissionModeName = nameOr(transmissionMode, TRANSMISSION_MODE_NAMES);
      fields.otherFrequency = (readU8(d, 7) & 0x08) !== 0;
      break;
    }
    case 0x5b:
    case 0x5c:
    case 0x5d:
    case 0x5e: {
      // Multilingual network/bouquet/service/component descriptors.
      const defaultLanguage = ascii(d.subarray(0, 3));
      const languages: string[] = [];
      const names: string[] = [];
      let cursor = 3;
      while (cursor + 1 <= d.length) {
        if (cursor + 3 > d.length) break;
        const language = ascii(d.subarray(cursor, cursor + 3));
        cursor += 3;
        const firstLength = readU8(d, cursor);
        cursor += 1;
        const first = decodeText(d.subarray(cursor, cursor + firstLength));
        cursor += firstLength;
        languages.push(language);
        if (raw.tag === 0x5d) {
          const secondLength = cursor < d.length ? readU8(d, cursor) : 0;
          cursor += 1;
          const second = decodeText(d.subarray(cursor, cursor + secondLength));
          cursor += secondLength;
          names.push(`${language} ${first}/${second}`);
        } else {
          names.push(`${language} ${first}`);
        }
        if (cursor >= d.length) break;
      }
      fields.defaultLanguage = defaultLanguage;
      if (languages.length > 0) fields.languages = languages.join(', ');
      if (names.length > 0) fields.names = names.join('; ');
      break;
    }
    case 0x60:
      fields.referenceServiceId = readU16(d, 0);
      break;
    case 0x62: {
      // frequency_list_descriptor: centre frequencies in 10 Hz units.
      const frequencies: number[] = [];
      for (let i = 0; i + 4 <= d.length; i += 4) frequencies.push(readU32(d, i) * 10);
      fields.frequencies = frequencies.map((value) => String(value)).join(', ');
      fields.frequencyCount = frequencies.length;
      break;
    }
    case 0x64:
      fields.dataBroadcastId = readU16(d, 0);
      fields.componentTag = readU8(d, 2);
      break;
    case 0x65: {
      const systems: number[] = [];
      for (let i = 0; i + 2 <= d.length; i += 2) systems.push(readU16(d, i));
      if (systems.length > 0) fields.caSystemIds = systems.join(', ');
      break;
    }
    case 0x66: {
      const ids: number[] = [];
      for (let i = 0; i + 2 <= d.length; i += 2) ids.push(readU16(d, i));
      if (ids.length > 0) fields.dataBroadcastIds = ids.join(', ');
      break;
    }
    case 0x69:
      if (d.length >= 3) {
        fields.pil = (readU8(d, 0) << 16) + readU16(d, 1);
        fields.pilHex = `0x${fields.pil.toString(16).padStart(6, '0').toUpperCase()}`;
      }
      break;
    case 0x6b:
      fields.ancillaryIdentifier = readU8(d, 0);
      if (d.length > 1) fields.ancillaryData = hex(d, 1);
      break;
    case 0x71: {
      const services: number[] = [];
      for (let i = 0; i + 2 <= d.length; i += 2) services.push(readU16(d, i));
      if (services.length > 0) fields.serviceIds = services.join(', ');
      break;
    }
    case 0x72: {
      const flags = readU8(d, 0);
      fields.availabilityFlag = (flags & 0x80) !== 0;
      const cells: number[] = [];
      for (let i = 1; i + 2 <= d.length; i += 2) cells.push(readU16(d, i));
      if (cells.length > 0) fields.cellIds = cells.join(', ');
      break;
    }
    case 0x73:
      fields.authority = decodeText(d);
      break;
    case 0x74: {
      const entries: string[] = [];
      const count = readU8(d, 0);
      let cursor = 1;
      for (let i = 0; i < count && cursor + 8 <= d.length; i += 1) {
        entries.push(
          `${readU16(d, cursor)}/${readU16(d, cursor + 2)}/${readU16(d, cursor + 4)}/${readU16(d, cursor + 6)}`,
        );
        cursor += 8;
      }
      fields.relatedContent = entries.join(', ');
      break;
    }
    case 0x75: {
      const ids: number[] = [];
      for (let i = 0; i + 2 <= d.length; i += 2) ids.push(readU16(d, i));
      if (ids.length > 0) fields.tvaIds = ids.join(', ');
      break;
    }
    case 0x76: {
      // content_identifier_descriptor: CRID entries.
      const crids: string[] = [];
      let cursor = 0;
      while (cursor + 2 <= d.length) {
        const flags = readU8(d, cursor);
        cursor += 1;
        const location = flags & 0x03;
        if (location === 0) {
          const length = readU8(d, cursor);
          cursor += 1;
          crids.push(ascii(d.subarray(cursor, cursor + length)));
          cursor += length;
        } else if (location === 1) {
          crids.push(`ref:${readU16(d, cursor)}`);
          cursor += 2;
        } else {
          break;
        }
      }
      if (crids.length > 0) fields.crids = crids.join(', ');
      break;
    }
    case 0x6a:
      if (d.length >= 1) fields.componentType = readU8(d, 0);
      if (d.length >= 2) fields.bsid = readU8(d, 1);
      if (d.length >= 3) fields.mainId = readU8(d, 2);
      if (d.length >= 4) fields.asvc = readU8(d, 3);
      break;
    case 0x81: {
      // ATSC A/52 Annex A AC-3 audio stream descriptor.
      if (d.length < 3) {
        fields.flags = readU8(d, 0);
        break;
      }
      const sampleRateCode = readBits(d, 0, 3);
      const bsid = readBits(d, 3, 5);
      const bitRateCode = readBits(d, 8, 6);
      const surroundMode = readBits(d, 14, 2);
      const bsmod = readBits(d, 16, 3);
      const numChannels = readBits(d, 19, 4);
      const fullService = readBits(d, 23, 1) !== 0;
      fields.sampleRateCode = sampleRateCode;
      fields.bsid = bsid;
      fields.bitRateCode = bitRateCode;
      fields.surroundMode = surroundMode;
      fields.audioServiceType = bsmod;
      fields.audioServiceTypeName = ATSC_BSMOD_NAMES[bsmod] ?? `reserved (${bsmod})`;
      fields.numChannels = numChannels;
      fields.fullService = fullService;
      if (bsmod === 2) fields.audioDescription = true;
      if (bsmod === 3) fields.hearingImpaired = true;
      if (d.length >= 4) {
        const langcod = readU8(d, 3);
        if (langcod !== 0xff) fields.langcod = langcod;
      }
      if (d.length >= 5) {
        fields.mainId = readU8(d, 4) >> 5;
        fields.priority = (readU8(d, 4) >> 3) & 0x03;
      }
      if (d.length >= 9) {
        const languages = trailingLanguageCodes(d);
        if (languages[0]) fields.language = languages[0];
        if (languages[1]) fields.language2 = languages[1];
      }
      break;
    }
    case 0x79: {
      // S2_delivery_system_descriptor (EN 300 468, 6.2.13.4).
      const scramblingSelector = readBits(d, 0, 1) !== 0;
      let bit = 1;
      fields.scramblingSequenceSelector = scramblingSelector;
      if (scramblingSelector) {
        bit += 5;
        fields.scramblingSequenceIndex = readBits(d, bit, 18);
        bit += 18;
      }
      bit += 2;
      fields.tsis = readBits(d, bit, 1);
      bit += 1;
      const multipleInputStream = readBits(d, bit, 1) !== 0;
      bit += 1;
      if (multipleInputStream) {
        fields.inputStreamIdentifier = readBits(d, bit, 8);
        bit += 8;
      }
      bit += 2;
      const rollOff = readBits(d, bit, 2);
      bit += 2;
      fields.rollOff = rollOff;
      fields.rollOffName = nameOr(rollOff, ROLL_OFF_NAMES);
      fields.symbolRate = readBits(d, bit, 28) * 100;
      bit += 28;
      bit += 4;
      const modulation = readBits(d, bit, 4);
      fields.modulation = modulation;
      fields.modulationName = nameOr(modulation, SATELLITE_MODULATION_NAMES);
      break;
    }
    case 0x7a:
      fields.flags = readU8(d, 0);
      fields.flags2 = readU8(d, 1);
      break;
    case 0x7b: {
      // DTS descriptor (EN 300 468 Annex G): 40 fixed bits.
      if (d.length >= 5) {
        const sampleRateCode = readBits(d, 0, 4);
        const bitRateCode = readBits(d, 4, 6);
        const nblks = readBits(d, 10, 7);
        const fsize = readBits(d, 17, 14);
        const surroundMode = readBits(d, 31, 6);
        const lfe = readBits(d, 37, 1);
        const extendedSurround = readBits(d, 38, 2);
        fields.sampleRateCode = sampleRateCode;
        const sampleRate = DTS_DESCRIPTOR_SAMPLE_RATES[sampleRateCode];
        if (sampleRate !== undefined && sampleRate > 0) fields.sampleRate = sampleRate;
        fields.bitRateCode = bitRateCode;
        const bitRate = DTS_DESCRIPTOR_BITRATES[bitRateCode & 0x1f];
        if (bitRate !== undefined && bitRate > 0) fields.bitRate = bitRate;
        fields.nblks = nblks;
        fields.frameSize = fsize;
        fields.surroundMode = surroundMode;
        const channels = DTS_DESCRIPTOR_CHANNELS[surroundMode];
        if (channels !== undefined) fields.channels = channels + (lfe ? 1 : 0);
        fields.lfe = lfe !== 0;
        fields.extendedSurround = extendedSurround;
      }
      break;
    }
    case 0x7c:
      fields.profile = readU8(d, 0);
      fields.level = readU8(d, 1);
      break;
    case 0x7f: {
      const extension = readU8(d, 0);
      fields.extensionTag = extension;
      const extensionName = EXTENSION_NAMES[extension];
      if (extensionName) fields.extensionName = extensionName;
      if (extension === 0x06 && d.length >= 2) {
        // ETSI EN 300 468 supplementary_audio_descriptor.
        const flags = readU8(d, 1);
        const mixType = (flags & 0x80) !== 0;
        const editorialClassification = (flags >> 2) & 0x1f;
        const languageCodePresent = (flags & 0x01) !== 0;
        fields.mixType = mixType ? 'independent' : 'dependent';
        fields.editorialClassification = editorialClassification;
        fields.editorialClassificationName =
          supplementaryAudioName(editorialClassification);
        if (editorialClassification === 0x01) fields.audioDescription = true;
        if (editorialClassification === 0x02) fields.hearingImpaired = true;
        if (editorialClassification === 0x03) fields.spokenSubtitles = true;
        let pos = 2;
        if (languageCodePresent && pos + 3 <= d.length) {
          fields.language = ascii(d.subarray(pos, pos + 3));
          pos += 3;
        }
        if (pos < d.length) fields.privateData = hex(d, pos);
      } else if (extension === 0x19 && d.length >= 2) {
        // ETSI EN 300 468 audio_preselection_descriptor.
        let pos = 1;
        const count = readU8(d, pos) >> 3;
        pos += 1;
        let parsed = 0;
        let audioDescription = false;
        let spokenSubtitles = false;
        let dialogueEnhancement = false;
        let interactivityEnabled = false;
        let rendering: number | undefined;
        let language: string | undefined;
        for (let i = 0; i < count && pos + 2 <= d.length; i += 1) {
          const first = readU8(d, pos);
          const flags = readU8(d, pos + 1);
          pos += 2;
          if (rendering === undefined) rendering = first & 0x07;
          if ((flags & 0x80) !== 0) audioDescription = true;
          if ((flags & 0x40) !== 0) spokenSubtitles = true;
          if ((flags & 0x20) !== 0) dialogueEnhancement = true;
          if ((flags & 0x10) !== 0) interactivityEnabled = true;
          const languageCodePresent = (flags & 0x08) !== 0;
          const textLabelPresent = (flags & 0x04) !== 0;
          const multiStreamInfoPresent = (flags & 0x02) !== 0;
          const futureExtension = (flags & 0x01) !== 0;
          if (languageCodePresent && pos + 3 <= d.length) {
            if (language === undefined) language = ascii(d.subarray(pos, pos + 3));
            pos += 3;
          }
          if (textLabelPresent) pos += 1;
          if (multiStreamInfoPresent && pos < d.length) {
            const auxCount = readU8(d, pos) >> 5;
            pos += 1 + auxCount;
          }
          if (futureExtension && pos < d.length) {
            const extensionLength = readU8(d, pos) & 0x1f;
            pos += 1 + extensionLength;
          }
          parsed += 1;
        }
        fields.preselectionCount = parsed;
        if (audioDescription) fields.audioDescription = true;
        if (spokenSubtitles) fields.spokenSubtitles = true;
        if (dialogueEnhancement) fields.dialogueEnhancement = true;
        if (interactivityEnabled) fields.interactivityEnabled = true;
        if (rendering !== undefined) {
          fields.audioRenderingIndication = rendering;
          fields.audioRenderingIndicationName =
            ['no preference', 'stereo', 'two-dimensional', 'three-dimensional', 'headphones'][
              rendering
            ] ?? 'reserved';
        }
        if (language !== undefined) fields.language = language;
      } else if (extension === 0x15 && d.length >= 2) {
        const flags = readU8(d, 1);
        const configFlag = (flags & 0x80) !== 0;
        const tocFlag = (flags & 0x40) !== 0;
        fields.ac4ConfigFlag = configFlag;
        fields.ac4TocFlag = tocFlag;
        let pos = 2;
        if (configFlag && pos < d.length) {
          const config = readU8(d, pos);
          pos += 1;
          fields.dialogEnhancementEnabled = (config & 0x80) !== 0;
          const channelMode = (config >> 5) & 0x03;
          fields.channelMode = channelMode;
          fields.channelModeName =
            ['Mono', 'Stereo', 'Multichannel', 'Reserved'][channelMode] ?? 'Reserved';
        }
        if (tocFlag && pos < d.length) {
          const tocLength = readU8(d, pos);
          pos += 1;
          fields.tocLength = tocLength;
          if (tocLength > 0 && pos + tocLength <= d.length) fields.toc = hex(d, pos, pos + tocLength);
          pos += tocLength;
        }
        if (pos < d.length) fields.additionalInfo = hex(d, pos);
      } else if (d.length > 1) {
        fields.extensionData = hex(d, 1);
      }
      break;
    }
    case 0x86: {
      // ATSC A/65 caption_service_descriptor.
      const count = readU8(d, 0) & 0x1f;
      const services: string[] = [];
      const languages = new Set<string>();
      let easyReader = false;
      let wideAspectRatio = false;
      for (let i = 1; i + 5 < d.length && services.length < count; i += 6) {
        const language = ascii(d.subarray(i, i + 3));
        const flags = readU8(d, i + 3);
        const tail = readU8(d, i + 4);
        const digitalCc = (flags & 0x80) !== 0;
        const easy = (tail & 0x80) !== 0;
        const wide = (tail & 0x40) !== 0;
        if (easy) easyReader = true;
        if (wide) wideAspectRatio = true;
        languages.add(language);
        if (digitalCc) {
          const serviceNumber = flags & 0x3f;
          services.push(
            `${language} 708 service=${serviceNumber}${easy ? ' easy-reader' : ''}${
              wide ? ' 16:9' : ' 4:3'
            }`,
          );
        } else {
          const line21 = (flags & 0x01) !== 0;
          services.push(
            `${language} 608 line21=${line21 ? 1 : 0}${easy ? ' easy-reader' : ''}${
              wide ? ' 16:9' : ' 4:3'
            }`,
          );
        }
      }
      fields.services = services.join(', ');
      if (languages.size > 0) fields.languages = [...languages].join(', ');
      if (easyReader) fields.easyReader = true;
      if (wideAspectRatio) fields.wideAspectRatio = true;
      break;
    }
    case 0x87: {
      const region = readU8(d, 0);
      const dimensions = readU8(d, 1);
      const ratings: string[] = [];
      let cursor = 2;
      for (let i = 0; i < dimensions && cursor + 1 < d.length; i += 1) {
        const dimension = readU8(d, cursor);
        const value = readU8(d, cursor + 1) >> 4;
        ratings.push(`${dimension}/${value}`);
        cursor += 2;
      }
      fields.ratingRegion = region;
      fields.dimensions = dimensions;
      if (ratings.length > 0) fields.ratings = ratings.join(', ');
      break;
    }
    case 0xa0:
      applyAtscStrings(fields, d);
      break;
    case 0xa1: {
      // ATSC service_location_descriptor (A/65): PCR PID and stream loop.
      fields.pcrPid = readU16(d, 0) & 0x1fff;
      const count = readU8(d, 2);
      fields.elementCount = count;
      const elements: string[] = [];
      let cursor = 3;
      for (let i = 0; i < count && cursor + 6 <= d.length; i += 1) {
        const streamType = readU8(d, cursor);
        const pid = readU16(d, cursor + 1) & 0x1fff;
        const language = ascii(d.subarray(cursor + 3, cursor + 6));
        elements.push(`${streamType}:${pid}:${language}`);
        cursor += 6;
      }
      if (elements.length > 0) fields.elements = elements.join(', ');
      break;
    }
    case 0xa2: {
      // ATSC time_shifted_service_descriptor: event id list.
      const count = readU8(d, 0) & 0x03;
      const events: number[] = [];
      for (let i = 1; i < count * 2 + 1 && i + 2 <= d.length; i += 2) {
        events.push(readU16(d, i) & 0x3fff);
      }
      fields.eventCount = count;
      if (events.length > 0) fields.eventIds = events.join(', ');
      break;
    }
    case 0xd5: {
      // series_descriptor (EN 300 468, 6.2.45).
      if (d.length >= 3) {
        fields.seriesId = readU16(d, 0);
        fields.repeatLabel = (readU8(d, 2) >> 4) & 0x0f;
        fields.programmePattern = (readU8(d, 2) >> 1) & 0x07;
        fields.expired = (readU8(d, 2) & 0x01) !== 0;
        if (d.length >= 4) {
          const nameLength = readU8(d, 3);
          fields.seriesName = decodeText(d.subarray(4, 4 + nameLength));
        }
      }
      break;
    }
    case 0xc3: {
      // ISDB TS information descriptor (ARIB STD-B10, 6.2.26).
      if (d.length >= 8) {
        fields.remoteControlKeyId = readU8(d, 0) >> 4;
        fields.transmissionType = readU8(d, 0) & 0x0f;
        fields.originalNetworkId = readU16(d, 1);
        fields.transportStreamId = readU16(d, 3);
        fields.serviceId = readU16(d, 5);
        const nameLength = readU8(d, 7);
        fields.tsName = decodeText(d.subarray(8, 8 + nameLength));
      }
      break;
    }
    case 0xc4: {
      // ISDB extended event descriptor (ARIB STD-B10, 6.2.13). The layout
      // mirrors the DVB extended_event_descriptor but the text is ARIB coded.
      fields.descriptorNumber = readU8(d, 0) >> 4;
      fields.lastDescriptorNumber = readU8(d, 0) & 0x0f;
      fields.language = ascii(d.subarray(1, 4));
      const itemsLength = readU8(d, 4);
      const items: string[] = [];
      let itemCursor = 5;
      const itemsEnd = Math.min(d.length, itemCursor + itemsLength);
      while (itemCursor + 2 <= itemsEnd) {
        const descriptionLength = readU8(d, itemCursor);
        const description = decodeText(
          d.subarray(itemCursor + 1, itemCursor + 1 + descriptionLength),
        );
        itemCursor += 1 + descriptionLength;
        if (itemCursor >= itemsEnd) break;
        const valueLength = readU8(d, itemCursor);
        const value = decodeText(d.subarray(itemCursor + 1, itemCursor + 1 + valueLength));
        itemCursor += 1 + valueLength;
        items.push(`${description}=${value}`);
      }
      if (items.length > 0) fields.items = items.join('; ');
      if (itemCursor < d.length) {
        const textLength = readU8(d, itemCursor);
        fields.text = decodeText(d.subarray(itemCursor + 1, itemCursor + 1 + textLength));
      }
      break;
    }
    case 0xc6:
      // ISDB partial reception descriptor (ARIB STD-B10, 6.2.29).
      if (d.length >= 4) {
        fields.startServiceId = readU16(d, 0);
        fields.endServiceId = readU16(d, 2);
        if (d.length >= 5) fields.label = readU8(d, 4);
      }
      break;
    case 0xc7:
      // ISDB hierarchy descriptor (ARIB STD-B10, 6.2.30).
      if (d.length >= 1) {
        fields.hierarchyType = readU8(d, 0) >> 4;
        if (d.length >= 2) fields.layerIndex = (readU8(d, 1) >> 5) & 0x07;
      }
      break;
    case 0xc9:
      // ISDB data content descriptor (ARIB STD-B10, 6.2.32).
      if (d.length >= 2) {
        fields.dataComponentId = readU16(d, 0);
        if (d.length >= 3) fields.entryComponent = readU8(d, 2);
        if (d.length > 3) fields.additionalInfo = hex(d, 3);
      }
      break;
    case 0xca:
      // ISDB video encode control descriptor (ARIB STD-B10, 6.2.33).
      if (d.length >= 1) fields.profileAndLevel = readU8(d, 0);
      break;
    case 0xcb:
      // ISDB still picture descriptor (ARIB STD-B10, 6.2.34).
      if (d.length >= 1) fields.stillPictureId = readU8(d, 0);
      break;
    case 0xa3:
    case 0x85:
      applyAtscStrings(fields, d);
      break;
    case 0x88:
    case 0xa4:
    case 0xa5:
      // ATSC private information descriptors: expose the payload verbatim.
      fields.privateData = hex(d, 0);
      break;
    case 0xc1:
      fields.recordingControl = readU8(d, 0) >> 6;
      fields.maximumBitrate = d.length >= 2 ? readU8(d, 1) : 0;
      break;
    case 0xc8:
      fields.stillPicture = (readU8(d, 0) & 0x80) !== 0;
      fields.sequenceEnd = (readU8(d, 0) & 0x40) !== 0;
      fields.videoEncodeFormat = (readU8(d, 0) >> 2) & 0x0f;
      break;
    case 0xfc: {
      // ISDB emergency information descriptor (ARIB STD-B10, 6.2.24).
      const events = parseEmergencyInformationDescriptor(d);
      if (events.length > 0) {
        const first = events[0] as EmergencyInformationEvent;
        fields.serviceId = first.serviceId;
        fields.ewbsStarted = events.some((event) => event.started);
        fields.signalLevel = first.signalLevel;
        fields.areaCodes = first.areaCodes
          .map((code) => `0x${code.toString(16).padStart(3, '0').toUpperCase()}`)
          .join(', ');
        fields.events = events.length;
      }
      break;
    }
    case 0xf6:
      fields.caSystemId = readU16(d, 0);
      fields.transmissionType = readU8(d, 2);
      fields.ecmPid = readU16(d, 3) & 0x1fff;
      break;
    case 0xfd:
      fields.dataComponentId = readU16(d, 0);
      fields.dataComponentName = dataComponentName(fields.dataComponentId);
      fields.additionalInfoLength = Math.max(0, d.length - 2);
      if (d.length > 2) fields.additionalInfo = hex(d, 2);
      break;
    default:
      break;
  }

  return {
    tag: raw.tag,
    tagHex: `0x${raw.tag.toString(16).padStart(2, '0').toUpperCase()}`,
    length: raw.length,
    name:
      raw.tag === 0x7f && fields.extensionTag === 0x15
        ? 'AC-4'
        : raw.tag === 0x7f && fields.extensionTag === 0x06
          ? 'Supplementary audio'
          : raw.tag === 0x7f && fields.extensionTag === 0x19
            ? 'Audio preselection'
            : descriptorName(raw.tag),
    raw: hex(d),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };
}

export function describeDescriptors(
  raw: RawDescriptor[],
  textEncoding: TextEncoding = 'dvb',
): DescriptorInfo[] {
  return raw.map((descriptor) => describeDescriptor(descriptor, textEncoding));
}

function readU32(data: Uint8Array, offset: number): number {
  return (
    readU8(data, offset) * 0x1000000 +
    (readU8(data, offset + 1) << 16) +
    (readU8(data, offset + 2) << 8) +
    readU8(data, offset + 3)
  );
}

function readBits(data: Uint8Array, bitOffset: number, count: number): number {
  let value = 0;
  for (let i = 0; i < count; i += 1) {
    const position = bitOffset + i;
    const byte = readU8(data, position >> 3);
    value = value * 2 + ((byte >> (7 - (position & 7))) & 1);
  }
  return value;
}

/** DVB DTS descriptor sample_rate_code table (EN 300 468 Table G.2). */
const DTS_DESCRIPTOR_SAMPLE_RATES: Array<number | undefined> = [
  undefined, 8000, 16000, 32000, 64000, 128000, 11025, 22050, 44100, 88200, 176400,
  12000, 24000, 48000, 96000, 192000,
];
/** DVB DTS descriptor bit_rate_code table (EN 300 468 Table G.3), in b/s. */
const DTS_DESCRIPTOR_BITRATES: Array<number | undefined> = [
  undefined, undefined, undefined, undefined, undefined,
  128000, 192000, 224000, 256000, 320000, 384000, 448000, 512000, 576000, 640000, 768000,
  960000, 1024000, 1152000, 1280000, 1344000, 1408000, 1411200, 1472000, 1536000, 1920000,
  2048000, 3072000, 3840000,
];
/** DVB DTS descriptor surround_mode table (EN 300 468 Table G.4). */
const DTS_DESCRIPTOR_CHANNELS: Array<number | undefined> = [
  1, undefined, 2, 2, 2, 3, 3, 4, 4, 5,
];
