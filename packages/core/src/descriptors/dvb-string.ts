import { parseAtscMultipleString } from './atsc-string.js';

export function ascii(data: Uint8Array): string {
  let out = '';
  for (const value of data) {
    out += value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : '.';
  }
  return out;
}

/** Decode an ATSC Multiple String Structure into descriptor fields. */
export function applyAtscStrings(
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
