import { hex, readU8 } from '../util/bytes.js';

/**
 * ATSC A/65 Multiple String Structure.
 *
 * `multiple_string_structure()` carries one or more language-tagged strings.
 * Each string is split into segments; every segment selects a Unicode range
 * with a `mode` byte or an explicit encoding (UTF-16 / SCSU), and may be
 * compressed with one of the standard A/65 Huffman tables.
 *
 * This decoder handles uncompressed segments (compression_type 0x00) for the
 * Unicode range modes 0x00-0x33 and for UTF-16 (0x3F). Huffman and SCSU
 * segments keep their raw bytes and decode to null until those tables land.
 */

export interface AtscStringSegment {
  compressionType: number;
  mode: number;
  /** Decoded text, or null when the encoding is not supported yet. */
  text: string | null;
  /** Raw segment payload as uppercase hex. */
  raw: string;
}

export interface AtscString {
  /** ISO 639 language code, for example "eng". */
  language: string;
  segments: AtscStringSegment[];
  /** Concatenation of every decoded segment. */
  text: string;
}

export function parseAtscMultipleString(data: Uint8Array): AtscString[] {
  const strings: AtscString[] = [];
  const numberOfStrings = readU8(data, 0);
  let cursor = 1;

  for (let i = 0; i < numberOfStrings && cursor < data.length; i += 1) {
    if (cursor + 4 > data.length) break;
    const language = ascii(data.subarray(cursor, cursor + 3));
    cursor += 3;
    const numberOfSegments = readU8(data, cursor);
    cursor += 1;

    const segments: AtscStringSegment[] = [];
    for (let j = 0; j < numberOfSegments && cursor + 3 <= data.length; j += 1) {
      const compressionType = readU8(data, cursor);
      const mode = readU8(data, cursor + 1);
      const numberOfBytes = readU8(data, cursor + 2);
      const start = cursor + 3;
      const end = Math.min(data.length, start + numberOfBytes);
      const bytes = data.subarray(start, end);
      segments.push({
        compressionType,
        mode,
        text: decodeSegment(compressionType, mode, bytes),
        raw: hex(bytes),
      });
      cursor = end;
    }

    strings.push({
      language,
      segments,
      text: segments.map((segment) => segment.text ?? '').join(''),
    });
  }

  return strings;
}

/** Convenience: decode the first string, falling back to every string joined. */
export function decodeAtscMultipleString(data: Uint8Array): string {
  const strings = parseAtscMultipleString(data);
  const first = strings.find((entry) => entry.text.length > 0);
  if (first) return first.text;
  return strings.map((entry) => entry.text).join('');
}

function decodeSegment(compressionType: number, mode: number, bytes: Uint8Array): string | null {
  // Only the uncompressed variants are decoded for now.
  if (compressionType !== 0x00) return null;

  if (mode <= 0x33) {
    const base = mode << 8;
    let out = '';
    for (const value of bytes) {
      // Nulls are padding in some streams; keep them out of display text.
      if (value === 0) continue;
      out += String.fromCodePoint(base | value);
    }
    return out;
  }

  if (mode === 0x3f) {
    return decodeUtf16Be(bytes);
  }

  return null;
}

function decodeUtf16Be(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const unit = ((bytes[i] as number) << 8) | (bytes[i + 1] as number);
    if (unit === 0) continue;
    out += String.fromCharCode(unit);
  }
  return out;
}

function ascii(data: Uint8Array): string {
  let out = '';
  for (const value of data) {
    out += value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : '.';
  }
  return out;
}
