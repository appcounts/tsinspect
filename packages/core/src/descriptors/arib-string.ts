/**
 * ARIB STD-B24 8-bit character-code decoder (ISDB-T/ISDB-Tb text).
 *
 * ISDB uses the ISO-2022-style code extension of ARIB STD-B24 rather than a
 * single byte encoding. The initial state is:
 *
 *   G0 = Kanji (2-byte), G1 = Alphanumeric,
 *   G2 = Hiragana,       G3 = Katakana,
 *   GL = G0,             GR = G2.
 *
 * EUC-JP-compatible graphics (Kanji, Hiragana, Katakana, JIS X 0201 Katakana)
 * are accumulated as EUC-JP bytes and decoded in runs. ARIB additional
 * symbols (Table 7-10) are mapped to Unicode directly. DRCS, mosaic and macro
 * sets are reported as replacement characters.
 */

import { decodeAribSymbol } from './arib-symbols.js';

const ESC = 0x1b;
const LS0 = 0x0f;
const LS1 = 0x0e;
const SS2 = 0x19;
const SS3 = 0x1d;

const KANJI = 0x42;
const ALNUM = 0x4a;
const ALNUM_JIS = 0x40;
const HIRAGANA = 0x30;
const KATAKANA = 0x31;
const PROP_ALNUM = 0x36;
const PROP_HIRAGANA = 0x37;
const PROP_KATAKANA = 0x38;
const JIS0201_KATAKANA = 0x49;
const JIS0213_PLANE1 = 0x39;
const JIS0213_PLANE2 = 0x3a;
const EXTRA_SYMBOLS = 0x3b;
const LATIN_EXTENSION = 0x4b;
const SPECIAL_CHARS = 0x4c;
const DRCS0 = 0xc0;

const TWO_BYTE_SETS = new Set<number>([
  KANJI,
  JIS0213_PLANE1,
  JIS0213_PLANE2,
  EXTRA_SYMBOLS,
  DRCS0,
]);

/**
 * ARIB STD-B24 Hiragana/Katakana positions 0x77-0x7E. These characters live
 * in JIS X 0208 row 1 (punctuation), so only the second EUC-JP byte differs
 * from the row 4/5 kana above.
 */
const KANA_PUNCTUATION = [0xb5, 0xb6, 0xbc, 0xa3, 0xd6, 0xd7, 0xa2, 0xa6]; // ゝ ゞ ー 。 「 」 、 ・
const KATAKANA_PUNCTUATION = [0xb3, 0xb4, 0xbc, 0xa3, 0xd6, 0xd7, 0xa2, 0xa6]; // ヽ ヾ ー 。 「 」 、 ・

let eucJpDecoder: TextDecoder | null | undefined;

function decodeEucJp(bytes: number[]): string {
  if (eucJpDecoder === undefined) {
    try {
      eucJpDecoder = new TextDecoder('euc-jp');
    } catch {
      eucJpDecoder = null;
    }
  }
  if (eucJpDecoder) return eucJpDecoder.decode(Uint8Array.from(bytes));
  return bytes
    .map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.'))
    .join('');
}

/** Accumulates EUC-JP bytes and literal Unicode symbols into one string. */
class TextBuilder {
  private pending: number[] = [];
  private text = '';

  byte(...values: number[]): void {
    for (const value of values) this.pending.push(value);
  }

  raw(value: string): void {
    this.flush();
    this.text += value;
  }

  newline(): void {
    this.flush();
    if (!this.text.endsWith('\n')) this.text += '\n';
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    this.text += decodeEucJp(this.pending);
    this.pending = [];
  }

  finish(): string {
    this.flush();
    return this.text.replace(/\0+$/g, '').replace(/\s+$/g, '');
  }
}

export type AribProfile = 'japan' | 'brazil';

/**
 * Resolve a DRCS character to a Unicode string. The set is 0 for DRCS-0
 * (two-byte) and 1..15 for DRCS-1..DRCS-15 (one-byte). `second` is present
 * only for DRCS-0. Return undefined when the glyph is not defined.
 */
export type AribDrcsResolver = (
  set: number,
  first: number,
  second?: number,
) => string | undefined;

export interface AribDecodeOptions {
  /** Character used for undecodable graphic sets (default `?`). */
  replacement?: string;
  /** Character-set profile: Japanese ARIB (default) or Brazilian SBTVD. */
  profile?: AribProfile;
  /** Optional DRCS glyph resolver used by caption decoding. */
  drcs?: AribDrcsResolver;
}

/** ISO-8859-15 additions over Latin-1 (ABNT NBR 15606-1 Latin extension). */
const ISO_8859_15: Record<number, string> = {
  0xa4: '€',
  0xa6: 'Š',
  0xa8: 'š',
  0xb4: 'Ž',
  0xb8: 'ž',
  0xbc: 'Œ',
  0xbd: 'œ',
  0xbe: 'Ÿ',
};

/** ABNT NBR 15606-1 Table 9 special characters (G3), positions 0x21-0x35. */
const SBTVD_SPECIAL = [
  '♪', '¤', '¦', '…', '█', '¨', '‘', '´', '’', '¸',
  '“', '¼', '”', '½', '•', '¾', '™', '⅛', '⅜', '⅝', '⅞',
];

function latinExtension(byte: number): string {
  const mapped = ISO_8859_15[byte];
  if (mapped !== undefined) return mapped;
  if (byte >= 0xa0 && byte <= 0xff) return String.fromCharCode(byte);
  return String.fromCharCode(byte);
}

function specialCharacter(c1: number): string | undefined {
  return SBTVD_SPECIAL[c1 - 0x21];
}

interface DecoderState {
  g: [number, number, number, number];
  gl: number;
  gr: number;
}

function defaultState(profile: AribProfile): DecoderState {
  if (profile === 'brazil') {
    // ABNT NBR 15606-1: G0/G1 Alphanumeric, G2 Latin extension, G3 Special.
    return {
      g: [ALNUM, ALNUM, LATIN_EXTENSION, SPECIAL_CHARS],
      gl: 0,
      gr: 2,
    };
  }
  return {
    g: [KANJI, ALNUM, HIRAGANA, KATAKANA],
    gl: 0,
    gr: 2,
  };
}

function isTwoByteSet(set: number, profile: AribProfile): boolean {
  if (profile === 'brazil') return false;
  return TWO_BYTE_SETS.has(set);
}

function appendGraphic(
  set: number,
  first: number,
  second: number | undefined,
  out: TextBuilder,
  replacement: string,
  profile: AribProfile,
  drcs?: AribDrcsResolver,
): boolean {
  const c1 = first & 0x7f;

  // DRCS-0 is encoded as 0xC0 (two-byte); DRCS-1..15 as 0xC1..0xCF
  // (one-byte). The high bit marks the DRCS set number.
  if (set === DRCS0 || (set >= 0xc1 && set <= 0xcf)) {
    const setNumber = set - 0x80;
    const resolved = drcs?.(setNumber, c1, second === undefined ? undefined : second & 0x7f);
    out.raw(resolved ?? replacement);
    return true;
  }

  if (profile === 'brazil') {
    switch (set) {
      case ALNUM:
      case ALNUM_JIS:
      case PROP_ALNUM:
        out.byte(c1 === 0x7e ? 0x7e : c1);
        return true;
      case LATIN_EXTENSION:
        out.raw(latinExtension(c1 + 0x80));
        return true;
      case SPECIAL_CHARS: {
        out.raw(specialCharacter(c1) ?? replacement);
        return true;
      }
      default:
        out.raw(replacement);
        return true;
    }
  }

  if (isTwoByteSet(set, profile)) {
    if (second === undefined) return false;
    const c2 = second & 0x7f;
    if (c1 < 0x21 || c1 > 0x7e || c2 < 0x21 || c2 > 0x7e) {
      out.raw(replacement);
      return true;
    }
    if (set === EXTRA_SYMBOLS) {
      out.raw(decodeAribSymbol(c1, c2) ?? replacement);
    } else if (set === KANJI || set === JIS0213_PLANE1) {
      out.byte(c1 + 0x80, c2 + 0x80);
    } else {
      out.raw(replacement);
    }
    return true;
  }

  switch (set) {
    case ALNUM:
    case ALNUM_JIS:
    case PROP_ALNUM:
      // JIS X 0201 Roman is ASCII-compatible for the characters that matter
      // in service and event names. OVER LINE is kept as a tilde.
      out.byte(c1 === 0x7e ? 0x7e : c1);
      return true;
    case HIRAGANA:
    case PROP_HIRAGANA:
      if (c1 >= 0x21 && c1 <= 0x76) {
        // EUC-JP row 4 (Hiragana): A4 A1 .. A4 F6 (ぁ .. ゖ).
        out.byte(0xa4, c1 + 0x80);
      } else if (c1 >= 0x77 && c1 <= 0x7e) {
        // ゝ ゞ ー 。 「 」 、 ・ share JIS X 0208 row 1 positions.
        out.byte(0xa1, KANA_PUNCTUATION[c1 - 0x77] as number);
      } else {
        out.raw(replacement);
      }
      return true;
    case KATAKANA:
    case PROP_KATAKANA:
      if (c1 >= 0x21 && c1 <= 0x76) {
        // EUC-JP row 5 (Katakana): A5 A1 .. A5 F6 (ァ .. ヶ).
        out.byte(0xa5, c1 + 0x80);
      } else if (c1 >= 0x77 && c1 <= 0x7e) {
        // ヽ ヾ ー 。 「 」 、 ・.
        out.byte(0xa1, KATAKANA_PUNCTUATION[c1 - 0x77] as number);
      } else {
        out.raw(replacement);
      }
      return true;
    case JIS0201_KATAKANA:
      if (c1 < 0x21 || c1 > 0x5f) {
        out.raw(replacement);
      } else {
        // EUC-JP half-width Katakana: 8E A1 .. 8E DF.
        out.byte(0x8e, c1 + 0x80);
      }
      return true;
    default:
      out.raw(replacement);
      return true;
  }
}

/** Consume one graphic character starting at `cursor`, returning the next index. */
function consumeGraphic(
  data: Uint8Array,
  cursor: number,
  set: number,
  out: TextBuilder,
  replacement: string,
  profile: AribProfile,
  drcs?: AribDrcsResolver,
): number {
  const first = data[cursor];
  if (first === undefined) return cursor;
  const second = isTwoByteSet(set, profile) ? data[cursor + 1] : undefined;
  appendGraphic(set, first, second, out, replacement, profile, drcs);
  return cursor + (isTwoByteSet(set, profile) ? 2 : 1);
}

/** Handle an ESC sequence; `cursor` points at the ESC byte. */
function consumeEscape(
  data: Uint8Array,
  cursor: number,
  state: DecoderState,
): number {
  let index = cursor + 1;
  const code = data[index];
  if (code === undefined) return index;
  index += 1;

  switch (code) {
    case 0x6e: // LS2: G2 into GL
      state.gl = 2;
      break;
    case 0x6f: // LS3: G3 into GL
      state.gl = 3;
      break;
    case 0x7e: // LS1R: G1 into GR
      state.gr = 1;
      break;
    case 0x7d: // LS2R: G2 into GR
      state.gr = 2;
      break;
    case 0x7c: // LS3R: G3 into GR
      state.gr = 3;
      break;
    case 0x24: {
      // Two-byte set designation. `ESC $ ( F` targets G0 in ARIB (the
      // parentheses are offset by one compared with ISO-2022).
      let target = 0;
      let final = data[index];
      if (final !== undefined && final >= 0x28 && final <= 0x2b) {
        target = final - 0x28;
        index += 1;
        final = data[index];
      }
      if (final === 0x20) {
        // DRCS: ESC $ SP <set number>; mark the target as unsupported.
        const setNumber = data[index + 1];
        if (setNumber !== undefined) {
          state.g[target] = 0x80 | (setNumber & 0x7f);
          index += 1;
        }
      } else if (final !== undefined) {
        state.g[target] = final === 0x40 ? DRCS0 : final;
        index += 1;
      }
      break;
    }
    case 0x28:
    case 0x29:
    case 0x2a:
    case 0x2b: {
      // One-byte set designation into G0..G3.
      const target = code - 0x28;
      const final = data[index];
      if (final === 0x20) {
        const setNumber = data[index + 1];
        if (setNumber !== undefined) {
          state.g[target] = 0x80 | (setNumber & 0x7f);
          index += 1;
        }
      } else if (final !== undefined) {
        state.g[target] = final;
        index += 1;
      }
      break;
    }
    default:
      // Unknown escape: the final byte has already been consumed.
      break;
  }

  return index;
}

function skipControlString(data: Uint8Array, cursor: number): number {
  let index = cursor;
  while (index < data.length) {
    const value = data[index] as number;
    if (value >= 0x40 && value <= 0x7e) return index + 1;
    index += 1;
  }
  return index;
}

/**
 * Decode an ARIB STD-B24 8-bit text string (ISDB service names, EPG titles,
 * event text and captions).
 */
export function decodeAribString(
  data: Uint8Array,
  options: AribDecodeOptions = {},
): string {
  if (data.length === 0) return '';

  const replacement = options.replacement ?? '?';
  const profile = options.profile ?? 'japan';
  const drcs = options.drcs;
  const out = new TextBuilder();
  let state = defaultState(profile);
  let cursor = 0;

  while (cursor < data.length) {
    const value = data[cursor] as number;

    if (value === ESC) {
      cursor = consumeEscape(data, cursor, state);
      continue;
    }
    if (value === LS1) {
      state.gl = 1;
      cursor += 1;
      continue;
    }
    if (value === LS0) {
      state.gl = 0;
      cursor += 1;
      continue;
    }
    if (value === SS2 || value === SS3) {
      const setIndex = value === SS2 ? 2 : 3;
      cursor += 1;
      cursor = consumeGraphic(data, cursor, state.g[setIndex] as number, out, replacement, profile, drcs);
      continue;
    }
    if (value === 0x0d) {
      if (data[cursor + 1] !== 0x0a) {
        out.newline();
        state = defaultState(profile);
      }
      cursor += 1;
      continue;
    }
    if (value === 0x0a) {
      out.newline();
      state = defaultState(profile);
      cursor += 1;
      continue;
    }
    if (value === 0x09) {
      out.byte(0x20);
      cursor += 1;
      continue;
    }
    if (value === 0x9b) {
      cursor = skipControlString(data, cursor + 1);
      continue;
    }
    if (value < 0x20 || (value >= 0x80 && value <= 0x9f)) {
      // C0/C1 controls (including ARIB positioning and colour controls).
      cursor += 1;
      continue;
    }
    if (value === 0x20 || value === 0x7f || value === 0xa0) {
      out.byte(0x20);
      cursor += 1;
      continue;
    }
    if (value === 0xff) {
      cursor += 1;
      continue;
    }

    const isGr = value >= 0xa1;
    const code = value & 0x7f;
    if (code < 0x21 || code > 0x7e) {
      cursor += 1;
      continue;
    }
    const set = state.g[isGr ? state.gr : state.gl] as number;
    cursor = consumeGraphic(data, cursor, set, out, replacement, profile, drcs);
  }

  return out.finish();
}
