import { describe, expect, it } from 'vitest';
import {
  TeletextCollector,
  buildTeletextLayer,
  parseTeletextPes,
  reverse8,
  unham84,
} from '@tsinspect/core';

function hamming(nibble: number): number {
  for (let value = 0; value < 256; value += 1) {
    if (unham84(reverse8(value)) === nibble) return value;
  }
  throw new Error('no Hamming code');
}

function oddParity(character: number): number {
  let value = character & 0x7f;
  let ones = 0;
  for (let i = 0; i < 7; i += 1) ones += (value >> i) & 1;
  if (ones % 2 === 0) value |= 0x80;
  return reverse8(value);
}

/** Build a Teletext data unit with packet-order bytes for the 40-byte body. */
function unit(row: number, magazine: number, body: number[], text?: string): number[] {
  const packet = new Array<number>(44).fill(0);
  const address = (row << 3) | (magazine & 0x07);
  packet[1] = reverse8(0xe4);
  packet[2] = hamming(address & 0x0f);
  packet[3] = hamming((address >> 4) & 0x0f);
  for (let index = 0; index < 40; index += 1) {
    if (text !== undefined) {
      packet[4 + index] = oddParity(text.charCodeAt(index) || 0x20);
    } else {
      packet[4 + index] = reverse8(body[index] ?? 0x20);
    }
  }
  return [0x03, 44, ...packet];
}

function triplet(address: number, mode: number, data: number): number[] {
  const value = address | (mode << 6) | (data << 11);
  // Hamming 24/18: byte 0 carries D1-D4 in its top bits, byte 1 D5-D11 and
  // byte 2 D12-D18. Protection bits are ignored by the decoder.
  return [
    ((value & 0x0f) << 3) & 0xff,
    (value >> 4) & 0x7f,
    (value >> 11) & 0x7f,
  ];
}

/** Hamming 8/4 encode one nibble into a Teletext packet byte. */
function hamByte(nibble: number): number {
  return reverse8(hamming(nibble));
}

/** Build the packet-order body of an X/27/0 link packet for page 0x80. */
function linkBody(): number[] {
  const body = new Array<number>(40).fill(0);
  body[0] = hamByte(0); // designation 0
  const page = 0x80;
  const bytes = [page & 0x0f, (page >> 4) & 0x0f, 0, 0, 0, 0];
  for (let link = 0; link < 6; link += 1) {
    for (let index = 0; index < 6; index += 1) {
      body[1 + link * 6 + index] = hamByte(bytes[index] as number);
    }
  }
  body[37] = hamByte(0x8);
  return body;
}

/** Build the packet-order body of an X/28/0 packet with function 1 (TOP). */
function navigationBody(): number[] {
  const body = new Array<number>(40).fill(0);
  body[0] = hamByte(0);
  body[1] = 1 << 3; // triplet D1-D4 = 1, function nibble = 1 (TOP)
  return body;
}

function enhancementBody(): number[] {
  const body = new Array<number>(40).fill(0);
  body[0] = hamByte(0); // designation 0 -> row 1
  const code = triplet(0, 0x00, 1); // column 0, foreground red
  for (let index = 0; index < code.length; index += 1) body[1 + index] = code[index] as number;
  return body;
}

describe('Teletext navigation and enhancements', () => {
  it('parses X/27 links, X/28 TOP signalling and X/26 triplets', () => {
    const payload = Uint8Array.from([
      0x10,
      ...unit(0, 1, [], ''),
      ...unit(1, 1, [], 'TEXT'),
      ...unit(26, 1, enhancementBody()),
      ...unit(27, 1, linkBody()),
      ...unit(28, 1, navigationBody()),
    ]);
    const pes = parseTeletextPes(payload);
    expect(pes).not.toBeNull();
    const collector = new TeletextCollector();
    collector.push(pes!, 1);
    const pages = collector.flush();
    const page = pages.find((entry) => entry.label === '1:00');
    expect(page).toBeDefined();
    expect(page?.links?.[0]?.label).toBe('1:80');
    expect(page?.links?.[0]?.kind).toBe('top');
    expect(page?.links?.[0]?.color).toBe('red');
    expect(page?.navigation?.top).toBe(true);
    expect(page?.navigation?.level).toBe(2.5);
    expect(page?.enhancements?.[0]?.triplets[0]?.mode).toBe(0);
    const layer = buildTeletextLayer(page!);
    const row = layer.lines.find((line) => line.row === 1);
    expect(row?.cells[0]?.char).toBe('T');
    expect(row?.cells[0]?.fg).toBe(1);
  });
});
