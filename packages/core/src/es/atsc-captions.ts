/**
 * ATSC CEA-608/708 captions in video user data (ATSC A/53 Part 4).
 *
 * MPEG-2 user_data and H.264/H.265 SEI both carry a `GA94` registered user
 * data block with user_data_type_code 0x03. This module finds those blocks in
 * an elementary-stream payload, parses the cc_data triplets, decodes basic
 * CEA-608 text and indexes CEA-708 bytes.
 */

export interface AtscCaptionUnit {
  valid: boolean;
  ccType: number;
  data1: number;
  data2: number;
}

export interface AtscCaptionPayload {
  units: AtscCaptionUnit[];
  lines: string[];
  text: string;
  /** Printable 608 characters seen in this payload, before line flushing. */
  characters: string;
  /** True when a CR/EDM/ENM control ended a caption line in this payload. */
  flushed: boolean;
  /** Decoded CEA-708 service text from cc_type 2/3 packets. */
  dtvccText: string;
  /** True when a 708 carriage return or ETX ended a caption line. */
  dtvccFlushed: boolean;
  /** Number of CEA-708 byte pairs (cc_type 2/3). */
  dtvccBytes: number;
}

const C1_PARAMETER_BYTES: Record<number, number> = {
  0x88: 1,
  0x89: 1,
  0x8a: 1,
  0x8b: 1,
  0x8c: 1,
  0x8d: 1,
  0x8e: 0,
  0x8f: 0,
  0x90: 2,
  0x91: 3,
  0x92: 2,
  0x97: 4,
  0x98: 6,
  0x99: 6,
  0x9a: 6,
  0x9b: 6,
  0x9c: 6,
  0x9d: 6,
  0x9e: 6,
  0x9f: 6,
};

function decode708Text(block: Uint8Array): { text: string; flushed: boolean } {
  let text = '';
  let flushed = false;
  let cursor = 0;
  while (cursor < block.length) {
    const value = block[cursor] as number;
    cursor += 1;
    if (value === 0x03 || value === 0x0d) {
      text += '\n';
      flushed = true;
    } else if (value === 0x08) {
      text = text.slice(0, -1);
    } else if (value >= 0x20 && value <= 0x7e) {
      text += String.fromCharCode(value);
    } else if (value === 0x7f) {
      text += '♪';
    } else if (value >= 0x80 && value <= 0x9f) {
      cursor += C1_PARAMETER_BYTES[value] ?? 0;
    } else if (value >= 0xa0) {
      text += String.fromCharCode(value);
    }
  }
  return { text, flushed };
}

function decodeDtvcc(bytes: number[]): { text: string; flushed: boolean } {
  let text = '';
  let flushed = false;
  let cursor = 0;
  while (cursor < bytes.length) {
    const header = bytes[cursor] as number;
    // The low six bits are the packet size in 16-bit words.
    const size = (header & 0x3f) * 2;
    cursor += 1;
    if (size === 0) break;
    const end = Math.min(bytes.length, cursor + size);
    let position = cursor;
    while (position < end) {
      let service = (bytes[position] as number) >> 5;
      let blockSize = (bytes[position] as number) & 0x1f;
      position += 1;
      if (service === 7) {
        if (position >= end) break;
        service = bytes[position] as number;
        position += 1;
        if (position >= end) break;
        blockSize = bytes[position] as number;
        position += 1;
      }
      if (blockSize === 0) break;
      const blockEnd = Math.min(end, position + blockSize);
      if (service === 1) {
        const decoded = decode708Text(Uint8Array.from(bytes.slice(position, blockEnd)));
        text += decoded.text;
        flushed ||= decoded.flushed;
      }
      position = blockEnd;
    }
    cursor = end;
  }
  return { text, flushed };
}

function parseCcData(data: Uint8Array, start: number): AtscCaptionUnit[] {
  const units: AtscCaptionUnit[] = [];
  if (start + 2 > data.length) return units;

  const header = data[start] as number;
  const ccCount = (header >> 1) & 0x1f;
  let cursor = start + 2;
  for (let i = 0; i < ccCount && cursor + 3 <= data.length; i += 1) {
    const first = data[cursor] as number;
    units.push({
      valid: ((first >> 2) & 0x01) !== 0,
      ccType: first & 0x03,
      data1: data[cursor + 1] as number,
      data2: data[cursor + 2] as number,
    });
    cursor += 3;
  }
  return units;
}

export function parseAtscCaptionPayload(payload: Uint8Array): AtscCaptionPayload | null {
  const units: AtscCaptionUnit[] = [];
  for (let i = 0; i + 5 <= payload.length; i += 1) {
    if (
      payload[i] === 0x47 &&
      payload[i + 1] === 0x41 &&
      payload[i + 2] === 0x39 &&
      payload[i + 3] === 0x34 &&
      payload[i + 4] === 0x03
    ) {
      units.push(...parseCcData(payload, i + 5));
    }
  }
  if (units.length === 0) return null;

  const fields = [
    { buffer: '', characters: '', lines: [] as string[], flushed: false },
    { buffer: '', characters: '', lines: [] as string[], flushed: false },
  ];
  let dtvccBytes = 0;
  const dtvcc: number[] = [];

  for (const unit of units) {
    if (!unit.valid) continue;
    if (unit.ccType === 2 || unit.ccType === 3) {
      dtvccBytes += 1;
      dtvcc.push(unit.data1, unit.data2);
      continue;
    }

    const field = fields[unit.ccType === 1 ? 1 : 0] as (typeof fields)[number];
    const first = unit.data1 & 0x7f;
    const second = unit.data2 & 0x7f;
    if (first === 0x14 || first === 0x1c || first === 0x15 || first === 0x1d) {
      if (second === 0x2c || second === 0x2d || second === 0x2e || second === 0x2f) {
        if (field.buffer.trim().length > 0) field.lines.push(field.buffer.trim());
        field.buffer = '';
        field.flushed = true;
      }
      continue;
    }
    if (first === 0x17 || first === 0x1f) continue; // tab offsets

    for (const character of [first, second]) {
      if (character >= 0x20 && character <= 0x7e) {
        field.buffer += String.fromCharCode(character);
        field.characters += String.fromCharCode(character);
      } else if (character === 0x7f) {
        field.buffer += '♪';
        field.characters += '♪';
      }
    }
  }

  for (const field of fields) {
    if (field.buffer.trim().length > 0) field.lines.push(field.buffer.trim());
  }
  const chosen = fields[0]!.characters.length >= fields[1]!.characters.length ? fields[0]! : fields[1]!;
  const dtvccDecoded = decodeDtvcc(dtvcc);

  const cleaned = chosen.lines
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);

  return {
    units,
    lines: cleaned,
    text: cleaned.join('\n'),
    characters: chosen.characters,
    flushed: chosen.flushed,
    dtvccText: dtvccDecoded.text,
    dtvccFlushed: dtvccDecoded.flushed,
    dtvccBytes,
  };
}
