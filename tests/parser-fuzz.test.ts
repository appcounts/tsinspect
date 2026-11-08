import { describe, expect, it } from 'vitest';
import {
  PesAssembler,
  TeletextCollector,
  collectPesPackets,
  detectPacketLayout,
  extractAribCaptionText,
  indexDvbSubtitlePes,
  indexPesStreams,
  parseAtscCaptionPayload,
  parsePesHeader,
  parseTeletextPes,
  parseVbiPes,
} from '@tsinspect/core';
import { buildPacket, concat } from './helpers.js';

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomBytes(next: () => number, min: number, max: number): Uint8Array {
  const data = new Uint8Array(min + Math.floor(next() * (max - min + 1)));
  for (let i = 0; i < data.length; i += 1) data[i] = Math.floor(next() * 256);
  return data;
}

/** Build a plausible data_unit stream with random unit ids and lengths. */
function dataUnits(next: () => number, count: number): Uint8Array {
  const chunks: number[] = [0x10 + Math.floor(next() * 16)];
  for (let i = 0; i < count; i += 1) {
    const id = [0x02, 0x03, 0x04, 0x05, 0x06, 0xff][Math.floor(next() * 6)] as number;
    const length = Math.floor(next() * 60);
    chunks.push(id, length);
    for (let j = 0; j < length; j += 1) chunks.push(Math.floor(next() * 256));
  }
  return Uint8Array.from(chunks);
}

describe('PES and caption parser fuzz hardening', () => {
  it(
    'parses arbitrary PES headers and assembler pushes',
    () => {
      const next = random(0x1234_5678);
      for (let round = 0; round < 300; round += 1) {
        const headerData = randomBytes(next, 0, 512);
        expect(() => parsePesHeader(headerData)).not.toThrow();

        const assembler = new PesAssembler(0x0100);
        for (let push = 0; push < 16; push += 1) {
          const payload = randomBytes(next, 0, 300);
          expect(() =>
            assembler.push(payload, next() < 0.2, push, push * 188),
          ).not.toThrow();
        }
        expect(() => assembler.flush()).not.toThrow();
      }
    },
    20_000,
  );

  it(
    'parses random Teletext and VBI data units',
    () => {
      const next = random(0x2222_3333);
      for (let round = 0; round < 400; round += 1) {
        const payload = dataUnits(next, 1 + Math.floor(next() * 8));
        expect(() => parseTeletextPes(payload)).not.toThrow();
        expect(() => parseVbiPes(payload)).not.toThrow();

        const teletext = parseTeletextPes(payload);
        if (teletext) {
          const collector = new TeletextCollector();
          for (let i = 0; i < 4; i += 1) {
            expect(() => collector.push(teletext, i)).not.toThrow();
          }
          expect(() => collector.flush()).not.toThrow();
        }
      }
    },
    20_000,
  );

  it(
    'parses random DVB subtitle and ATSC caption payloads',
    () => {
      const next = random(0x4444_5555);
      for (let round = 0; round < 400; round += 1) {
        const subtitle = new Uint8Array(2 + Math.floor(next() * 600));
        subtitle[0] = 0x20;
        subtitle[1] = Math.floor(next() * 256);
        for (let i = 2; i < subtitle.length; i += 1) {
          subtitle[i] = Math.floor(next() * 256);
        }
        expect(() => indexDvbSubtitlePes(subtitle)).not.toThrow();

        const caption = randomBytes(next, 0, 1024);
        if (caption.length > 10 && next() < 0.7) {
          const at = Math.floor(next() * (caption.length - 5));
          caption[at] = 0x47;
          caption[at + 1] = 0x41;
          caption[at + 2] = 0x39;
          caption[at + 3] = 0x34;
          caption[at + 4] = 0x03;
        }
        expect(() => parseAtscCaptionPayload(caption)).not.toThrow();
      }
    },
    20_000,
  );

  it(
    'parses random ARIB caption payloads in both profiles',
    () => {
      const next = random(0x6666_7777);
      for (let round = 0; round < 300; round += 1) {
        const payload = randomBytes(next, 8, 1024);
        if (next() < 0.8) payload[0] = next() < 0.5 ? 0x80 : 0x81;
        expect(() => extractAribCaptionText(payload, 'japan')).not.toThrow();
        expect(() => extractAribCaptionText(payload, 'brazil')).not.toThrow();
      }
    },
    20_000,
  );

  it(
    'scans and reassembles PES packets from a random transport stream',
    () => {
      const next = random(0x8888_9999);
      for (let round = 0; round < 40; round += 1) {
        const packets: Uint8Array[] = [];
        for (let i = 0; i < 32; i += 1) {
          packets.push(
            buildPacket(0x0100, randomBytes(next, 0, 184), {
              pusi: i % 8 === 0,
              cc: i & 0x0f,
            }),
          );
        }
        const data = concat(packets);
        const layout = detectPacketLayout(data);
        if (!layout) continue;
        expect(() => indexPesStreams(data, layout)).not.toThrow();
        expect(() => collectPesPackets(data, layout, new Set([0x0100]))).not.toThrow();
      }
    },
    20_000,
  );
});
