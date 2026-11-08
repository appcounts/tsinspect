import { describe, expect, it } from 'vitest';
import { collectScte35Timeline, detectPacketLayout } from '@tsinspect/core';
import { buildPacket, concat, packetizeSection } from './helpers.js';

const PID = 0x1f0;
const FILLER_PID = 0x100;

// splice_insert, event 123, out-of-network, break_duration 10 s, auto-return.
const SPLICE_INSERT = bytes(
  'fc 30 25 00 00 00 00 00 00 00 ff f0 14 05 00 00 00 7b 7f ef fe 00 31 58 ' +
    'd0 fe 00 0d bb a0 00 01 00 00 00 00 63 27 90 9a',
);

// time_signal with a Break start segmentation descriptor (20 s).
const TIME_SIGNAL = bytes(
  'fc 30 2c 00 00 00 00 00 00 00 ff f0 05 06 fe 00 06 0a e0 00 16 02 14 ' +
    '43 55 45 49 00 00 05 39 7f ff 00 00 1b 77 40 00 00 22 00 00 7e 3b f0 a1',
);

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((part) => Number.parseInt(part, 16)),
  );
}

function fillers(count: number): Uint8Array[] {
  const payload = new Uint8Array(184);
  payload.fill(0xff);
  return Array.from({ length: count }, (_, index) =>
    buildPacket(FILLER_PID, payload, { cc: index & 0x0f }),
  );
}

function layoutOf(data: Uint8Array) {
  const layout = detectPacketLayout(data);
  if (!layout) throw new Error('no TS layout detected');
  return layout;
}

describe('SCTE-35 timeline collector', () => {
  it('orders events by packet and derives break intervals', () => {
    const data = concat([
      ...fillers(10),
      ...packetizeSection(PID, SPLICE_INSERT),
      ...fillers(20),
      ...packetizeSection(PID, TIME_SIGNAL, 1),
      ...fillers(30),
    ]);

    const timeline = collectScte35Timeline(data, layoutOf(data), {
      pids: new Set([PID]),
      durationSec: 10,
    });

    expect(timeline.count).toBe(2);
    expect(timeline.pids).toEqual([PID]);
    expect(timeline.truncated).toBe(false);
    expect(timeline.events[0]?.commandName).toBe('splice_insert');
    expect(timeline.events[1]?.commandName).toBe('time_signal');
    expect(timeline.events[0]?.source).toBe('section');
    expect(timeline.events[0]?.crcValid).toBe(true);
    expect(timeline.events[0]?.timeSec).toBeLessThan(
      timeline.events[1]?.timeSec ?? Number.POSITIVE_INFINITY,
    );

    expect(timeline.breaks).toHaveLength(2);
    expect(timeline.breaks[0]?.eventId).toBe(123);
    expect(timeline.breaks[0]?.durationSec).toBe(10);
    expect(timeline.breaks[0]?.autoReturn).toBe(true);
    expect(timeline.breaks[0]?.outOfNetwork).toBe(true);
    expect(timeline.breaks[1]?.segmentationTypeName).toBe('Break start');
    expect(timeline.breaks[1]?.durationSec).toBe(20);
  });

  it('collapses identical transmissions inside the dedupe window', () => {
    const data = concat([
      ...fillers(4),
      ...packetizeSection(PID, SPLICE_INSERT),
      ...fillers(4),
      ...packetizeSection(PID, SPLICE_INSERT, 1),
      ...fillers(4),
    ]);

    const deduped = collectScte35Timeline(data, layoutOf(data), {
      pids: new Set([PID]),
      bitrateBps: 1_000_000,
    });
    expect(deduped.count).toBe(1);
    expect(deduped.events[0]?.repeats).toBe(2);

    const kept = collectScte35Timeline(data, layoutOf(data), {
      pids: new Set([PID]),
      bitrateBps: 1_000_000,
      dedupeWindowSec: 0,
    });
    expect(kept.count).toBe(2);
  });
});
