import { describe, expect, it } from 'vitest';
import {
  renderDvbSubtitleFrame,
  type PesPacket,
} from '@tsinspect/core';

function segment(type: number, pageId: number, body: number[]): number[] {
  return [
    0x0f,
    type,
    (pageId >> 8) & 0xff,
    pageId & 0xff,
    (body.length >> 8) & 0xff,
    body.length & 0xff,
    ...body,
  ];
}

function u16(value: number): [number, number] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function clut(depth: number): number[] {
  const family = depth === 2 ? 0x80 : depth === 4 ? 0x40 : 0x20;
  const entries: number[] = [1, (0 << 4) & 0xf0];
  const colors = [
    [0, 128, 128, 0],
    [81, 240, 90, 0], // red
    [145, 54, 34, 0], // green
    [41, 110, 240, 0], // blue
    [210, 128, 128, 0], // light grey
    [170, 128, 128, 0],
    [120, 128, 128, 0],
    [60, 128, 128, 0],
  ];
  for (let id = 0; id < colors.length; id += 1) {
    const color = colors[id] as number[];
    entries.push(id, family | 0x01, color[0]!, color[1]!, color[2]!, color[3]!);
  }
  return entries;
}

function objectData(depth: number, width: number): number[] {
  let pixels: number[];
  let subBlock: number;
  if (depth === 2) {
    pixels = [];
    for (let index = 0; index < width; index += 4) {
      // 01 10 11 01
      pixels.push(0x6d);
    }
    subBlock = 0x10;
  } else if (depth === 4) {
    pixels = [];
    for (let index = 0; index < width; index += 2) pixels.push(0x12, 0x34);
    subBlock = 0x11;
  } else {
    pixels = [];
    for (let index = 0; index < width; index += 1) pixels.push((index % 4) + 1);
    subBlock = 0x12;
  }
  const topLength = pixels.length + 2;
  return [
    0x00,
    0x01, // object id
    0x00, // coding method 0
    (topLength >> 8) & 0xff,
    topLength & 0xff,
    0x00,
    0x00, // bottom field length 0
    subBlock,
    ...pixels,
    0xf0,
  ];
}

function buildPayload(
  depth: number,
  window: { x: number; y: number; width: number; height: number } | undefined,
): Uint8Array {
  const regionWidth = 4;
  const regionHeight = 2;
  const pageId = 1;
  const segments: number[] = [];

  const dds: number[] = [
    window ? 0x08 : 0x00,
    ...u16(1919),
    ...u16(1079),
  ];
  if (window) {
    dds.push(
      ...u16(window.x),
      ...u16(window.y),
      ...u16(window.x + window.width - 1),
      ...u16(window.y + window.height - 1),
    );
  }
  segments.push(...segment(0x14, pageId, dds));

  const pcs = [
    0,
    0x00,
    0,
    0,
    ...u16(0),
    ...u16(0),
  ];
  segments.push(...segment(0x10, pageId, pcs));

  const rcs = [
    0,
    0x00,
    ...u16(regionWidth),
    ...u16(regionHeight),
    (depth << 2) & 0x1c,
    1,
    0,
    0,
    ...u16(1),
    0,
    0,
    0,
    ...u16(0),
  ];
  segments.push(...segment(0x11, pageId, rcs));

  segments.push(...segment(0x12, pageId, clut(depth)));
  segments.push(...segment(0x13, pageId, objectData(depth, regionWidth)));
  segments.push(...segment(0x80, pageId, []));

  return Uint8Array.from([0x20, 0x00, ...segments]);
}

function pes(payload: Uint8Array): PesPacket {
  return {
    pid: 0x100,
    streamId: 0xbd,
    packetLength: payload.length + 3,
    headerDataLength: 0,
    payloadOffset: 0,
    payload,
    firstPacket: 0,
    firstPacketOffset: 0,
    pts: 90_000,
    ptsSeconds: 1,
    complete: true,
  };
}

describe('DVB bitmap renderer depth and display window', () => {
  it('renders 2-bit pixels inside a display window', () => {
    const window = { x: 100, y: 50, width: 640, height: 480 };
    const frame = renderDvbSubtitleFrame([pes(buildPayload(2, window))], 1);
    expect(frame?.window).toEqual(window);
    expect(frame?.width).toBe(1920);
    expect(frame?.height).toBe(1080);
    expect(frame?.regions[0]).toMatchObject({ x: 100, y: 50, width: 4, height: 2 });
    expect([...(frame?.regions[0]?.pixels ?? [])]).toEqual([1, 2, 3, 1, 1, 2, 3, 1]);
  });

  it('renders 4-bit pixels without a display window', () => {
    const frame = renderDvbSubtitleFrame([pes(buildPayload(4, undefined))], 1);
    expect(frame?.window).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(frame?.regions[0]).toMatchObject({ x: 0, y: 0, width: 4, height: 2 });
    expect([...(frame?.regions[0]?.pixels ?? [])]).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });

  it('renders 8-bit pixels inside a display window', () => {
    const window = { x: 20, y: 30, width: 320, height: 180 };
    const frame = renderDvbSubtitleFrame([pes(buildPayload(8, window))], 1);
    expect(frame?.window).toEqual(window);
    expect(frame?.regions[0]).toMatchObject({ x: 20, y: 30, width: 4, height: 2 });
    expect([...(frame?.regions[0]?.pixels ?? [])]).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });
});
