import { describe, expect, it } from 'vitest';
import {
  parseAtscEit,
  parseAtscEtt,
  parseAtscMgt,
  parseAtscStt,
} from '@tsinspect/core';
import { buildSection, concat } from './helpers.js';

function u16(value: number): Uint8Array {
  return Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

/** One ATSC multiple-string structure with a single uncompressed string. */
function mss(text: string, language = 'eng'): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  return concat([
    Uint8Array.from([0x01]),
    new TextEncoder().encode(language),
    Uint8Array.from([0x01, 0x00, 0x00, bytes.length]),
    bytes,
  ]);
}

describe('ATSC PSIP', () => {
  it('parses STT time with the GPS-UTC offset', () => {
    const body = concat([
      Uint8Array.from([0x00]),
      u32(0),
      Uint8Array.from([18]),
      u16(0),
    ]);
    const stt = parseAtscStt(buildSection(0xcd, body));
    expect(stt).not.toBeNull();
    expect(stt?.gpsSeconds).toBe(0);
    expect(stt?.gpsUtcOffset).toBe(18);
    expect(stt?.utcIso).toBe('1980-01-05T23:59:42.000Z');
    expect(stt?.crcValid).toBe(true);
  });

  it('parses MGT table types', () => {
    const body = concat([
      Uint8Array.from([0x00]),
      u16(1),
      u16(0x0000), // TVCT-current
      u16(0x1ffb),
      Uint8Array.from([0x08]), // version 1
      u32(218),
      u16(0),
    ]);
    const mgt = parseAtscMgt(buildSection(0xc7, body));
    expect(mgt?.tables).toHaveLength(1);
    expect(mgt?.tables[0]).toMatchObject({
      tableType: 0,
      pid: 0x1ffb,
      version: 1,
      numberOfBytes: 218,
      name: 'TVCT-current',
    });
  });

  it('parses EIT events and ETT event text', () => {
    const title = mss('News');
    const event = concat([
      u16(1),
      u32(0),
      Uint8Array.from([0x00, 0x00, 0x00]),
      Uint8Array.from([title.length]),
      title,
      u16(0),
    ]);
    const eit = parseAtscEit(
      buildSection(0xcb, concat([Uint8Array.from([0x00, 0x01]), event]), {
        tableIdExtension: 1,
      }),
    );
    expect(eit?.sourceId).toBe(1);
    expect(eit?.events).toHaveLength(1);
    expect(eit?.events[0]?.eventId).toBe(1);
    expect(eit?.events[0]?.title).toBe('News');
    expect(eit?.events[0]?.startTimeIso).toBe('1980-01-06T00:00:00.000Z');

    const etmId = (1 << 16) | (2 << 2) | 0x02;
    const ett = parseAtscEtt(
      buildSection(0xcc, concat([Uint8Array.from([0x00]), u32(etmId), mss('Long text')]), {
        tableIdExtension: 0,
      }),
    );
    expect(ett?.kind).toBe('event');
    expect(ett?.sourceId).toBe(1);
    expect(ett?.eventId).toBe(2);
    expect(ett?.text).toBe('Long text');
  });
});
