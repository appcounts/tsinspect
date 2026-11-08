import { describe, expect, it } from 'vitest';
import {
  parseAc3,
  parseAc4,
  parseAdts,
  parseDts,
  parseH264,
  parseH265,
  parseLatm,
  parseMpeg2Video,
  probeBuffer,
} from '@tsinspect/core';
import {
  buildPacket,
  buildSection,
  concat,
  packetizeSection,
  patBody,
  pmtBody,
} from './helpers.js';

const PACKET_SIZES = new Set([0, 188, 192, 204, 208]);

/** Small deterministic PRNG so fuzz failures are reproducible. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function validStream(): Uint8Array {
  const pat = buildSection(
    0x00,
    patBody([
      { programNumber: 0, pid: 0x0010 },
      { programNumber: 1, pid: 0x1000 },
    ]),
    { tableIdExtension: 0x1234 },
  );
  const pmt = buildSection(
    0x02,
    pmtBody(0x0100, [
      { streamType: 0x1b, pid: 0x0100 },
      { streamType: 0x0f, pid: 0x0101 },
    ]),
    { tableIdExtension: 1 },
  );
  const packets = [
    ...packetizeSection(0x0000, pat),
    ...packetizeSection(0x1000, pmt),
    buildPacket(0x0100, new Uint8Array(0), { pcrTicks: 0, cc: 0 }),
    buildPacket(0x0100, new Uint8Array(0), { pcrTicks: 27_000_000, cc: 1 }),
  ];
  for (let i = 0; i < 16; i += 1) {
    packets.push(
      buildPacket(0x0100, new Uint8Array(184).fill(i & 0xff), { cc: (i + 2) & 0x0f }),
    );
  }
  return concat(packets);
}

function expectSane(data: Uint8Array): void {
  const result = probeBuffer(data, { name: 'fuzz.bin', kind: 'buffer' });
  expect(result.schemaVersion).toBe('1.0');
  expect(PACKET_SIZES.has(result.packet.size)).toBe(true);
  expect(result.source.sampledBytes).toBe(data.length);
}

describe('probeBuffer fuzz hardening', () => {
  it(
    'handles arbitrary buffers without throwing or hanging',
    () => {
      const next = random(0xc0ffee);
      const sizes = [0, 1, 2, 3, 4, 5, 187, 188, 189, 191, 192, 203, 204, 207, 208, 376, 4096];
      for (let i = 0; i < 60; i += 1) sizes.push(Math.floor(next() * 8192));
      for (const size of sizes) {
        const data = new Uint8Array(size);
        for (let i = 0; i < size; i += 1) data[i] = Math.floor(next() * 256);
        expectSane(data);
      }
    },
    20_000,
  );

  it(
    'handles every truncation point of a valid stream',
    () => {
      const data = validStream();
      for (let length = 0; length <= data.length; length += 7) {
        expectSane(data.subarray(0, length));
      }
      expectSane(data);
    },
    20_000,
  );

  it(
    'handles random byte mutations of a valid stream',
    () => {
      const source = validStream();
      const next = random(0x5eed);
      for (let round = 0; round < 240; round += 1) {
        const data = source.slice();
        const changes = 1 + Math.floor(next() * 8);
        for (let i = 0; i < changes; i += 1) {
          const at = Math.floor(next() * data.length);
          data[at] = Math.floor(next() * 256);
        }
        expectSane(data);
      }
    },
    20_000,
  );

  it(
    'handles malformed section lengths at every packet boundary',
    () => {
      const source = validStream();
      for (let offset = 0; offset < source.length; offset += 188) {
        const data = source.slice();
        // Corrupt the section length and pointer fields of the first payload
        // bytes while keeping the sync byte and PID intact.
        for (let i = offset + 4; i < Math.min(offset + 12, data.length); i += 1) {
          data[i] = 0xff;
        }
        expectSane(data);
      }
    },
    20_000,
  );

  it(
    'elementary stream parsers reject arbitrary bytes without throwing',
    () => {
      const parsers = [
        parseMpeg2Video,
        parseH264,
        parseH265,
        parseAdts,
        parseLatm,
        parseAc3,
        parseDts,
        parseAc4,
      ];
      const next = random(0xdead_beef);
      for (let round = 0; round < 200; round += 1) {
        const data = new Uint8Array(Math.floor(next() * 4096));
        for (let i = 0; i < data.length; i += 1) data[i] = Math.floor(next() * 256);
        for (const parser of parsers) {
          expect(() => parser(data)).not.toThrow();
        }
      }
    },
    20_000,
  );
});
