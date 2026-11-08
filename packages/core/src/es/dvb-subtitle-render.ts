/**
 * DVB bitmap subtitle renderer (ETSI EN 300 743).
 *
 * This module turns PES payloads into subtitle-layer regions: indexed pixel
 * arrays plus a per-region RGBA palette. The frame itself is composed in the
 * WebUI canvas, so the preview keeps the original display geometry without
 * sending a full-resolution RGBA frame for every cue.
 */

import type { PesPacket } from '../pes/assembler.js';
import { indexDvbSubtitlePes, type DvbSubtitleSegment } from './dvb-subtitle.js';

export interface DvbBitmapRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** RGBA entries, 4 bytes per palette entry. */
  palette: Uint8Array;
  /** One palette index per pixel, row-major. */
  pixels: Uint8Array;
}

export interface DvbDisplayWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DvbBitmapFrame {
  width: number;
  height: number;
  /** Display window inside the full display (DDS display_window_flag). */
  window: DvbDisplayWindow;
  regions: DvbBitmapRegion[];
}

export interface DvbSubtitleTimelineEntry {
  start: number;
  end: number;
}

export interface DvbSubtitleTimeline {
  width: number;
  height: number;
  frames: DvbSubtitleTimelineEntry[];
  truncated: boolean;
}

type Rgba = [number, number, number, number];
type ClutFamily = Rgba[];

interface ClutSet {
  entries2: ClutFamily;
  entries4: ClutFamily;
  entries8: ClutFamily;
}

interface ObjectPlacement {
  objectId: number;
  x: number;
  y: number;
}

interface RegionDefinition {
  width: number;
  height: number;
  depth: number;
  clutId: number;
  fill: boolean;
  fillCode: number;
  objects: ObjectPlacement[];
}

interface ObjectPixels {
  width: number;
  height: number;
  depth: number;
  lines: number[][];
}

interface PageRegion {
  regionId: number;
  x: number;
  y: number;
}

const MAX_TIMELINE_FRAMES = 500;
const MAX_LINE_PIXELS = 8192;

function readU16(data: Uint8Array, offset: number): number {
  return ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0);
}

function readU32(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] ?? 0) * 0x1000000) +
    ((data[offset + 1] ?? 0) << 16) +
    ((data[offset + 2] ?? 0) << 8) +
    (data[offset + 3] ?? 0)
  );
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function ycbcrToRgba(y: number, cr: number, cb: number, alpha: number): Rgba {
  const rr = y + 1.402 * (cr - 128);
  const gg = y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128);
  const bb = y + 1.772 * (cb - 128);
  return [clampByte(rr), clampByte(gg), clampByte(bb), clampByte(alpha)];
}

function emptyClut(): ClutFamily {
  return Array.from({ length: 256 }, () => [0, 0, 0, 0] as Rgba);
}

function parseClut(body: Uint8Array): ClutSet {
  const set: ClutSet = {
    entries2: emptyClut(),
    entries4: emptyClut(),
    entries8: emptyClut(),
  };
  let cursor = 2;
  while (cursor + 2 <= body.length) {
    const entryId = body[cursor] as number;
    const flags = body[cursor + 1] as number;
    const fullRange = (flags & 0x01) !== 0;
    cursor += 2;
    let rgba: Rgba;
    if (fullRange) {
      if (cursor + 4 > body.length) break;
      const y = body[cursor] as number;
      const cr = body[cursor + 1] as number;
      const cb = body[cursor + 2] as number;
      const t = body[cursor + 3] as number;
      cursor += 4;
      rgba = y === 0 ? [0, 0, 0, 0] : ycbcrToRgba(y, cr, cb, 255 - t);
    } else {
      if (cursor + 2 > body.length) break;
      const word = readU16(body, cursor);
      cursor += 2;
      const y6 = (word >> 10) & 0x3f;
      const cr4 = (word >> 6) & 0x0f;
      const cb4 = (word >> 2) & 0x0f;
      const t2 = word & 0x03;
      const y = Math.round((y6 * 255) / 63);
      const cr = Math.round((cr4 * 255) / 15);
      const cb = Math.round((cb4 * 255) / 15);
      rgba = y === 0 ? [0, 0, 0, 0] : ycbcrToRgba(y, cr, cb, 255 - Math.round((t2 * 255) / 3));
    }
    if (flags & 0x80) set.entries2[entryId] = rgba;
    if (flags & 0x40) set.entries4[entryId] = rgba;
    if (flags & 0x20) set.entries8[entryId] = rgba;
  }
  return set;
}

function parsePageComposition(body: Uint8Array): {
  state: number;
  regions: PageRegion[];
} {
  if (body.length < 2) return { state: 0, regions: [] };
  const state = ((body[1] as number) >> 2) & 0x03;
  const regions: PageRegion[] = [];
  for (let cursor = 2; cursor + 6 <= body.length; cursor += 6) {
    regions.push({
      regionId: body[cursor] as number,
      x: readU16(body, cursor + 2),
      y: readU16(body, cursor + 4),
    });
  }
  return { state, regions };
}

function parseRegionComposition(body: Uint8Array): RegionDefinition | null {
  if (body.length < 10) return null;
  const regionId = body[0] as number;
  const versionFill = body[1] as number;
  const width = readU16(body, 2);
  const height = readU16(body, 4);
  const depth = ((body[6] as number) >> 2) & 0x07;
  const clutId = body[7] as number;
  const fillCode =
    depth === 8
      ? (body[8] as number)
      : depth === 4
        ? ((body[9] as number) >> 4) & 0x0f
        : ((body[9] as number) >> 2) & 0x03;
  const objects: ObjectPlacement[] = [];
  let cursor = 10;
  while (cursor + 6 <= body.length) {
    const objectId = readU16(body, cursor);
    const geometry = readU32(body, cursor + 2);
    const objectType = (geometry >>> 30) & 0x03;
    const x = (geometry >>> 16) & 0x0fff;
    const y = geometry & 0x0fff;
    objects.push({ objectId, x, y });
    cursor += objectType === 1 || objectType === 2 ? 8 : 6;
  }
  return {
    width,
    height,
    depth,
    clutId,
    fill: (versionFill & 0x08) !== 0,
    fillCode,
    objects,
  };
}

class BitReader {
  private bit = 0;
  constructor(
    private readonly data: Uint8Array,
    private readonly start = 0,
    private readonly end = data.length,
  ) {}

  get remaining(): number {
    return (this.end - this.start) * 8 - this.bit;
  }

  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const absolute = this.start * 8 + this.bit;
      const byte = this.data[absolute >> 3] ?? 0;
      value = (value << 1) | ((byte >> (7 - (absolute & 7))) & 1);
      this.bit += 1;
    }
    return value;
  }

  peek(count: number): number {
    const saved = this.bit;
    const value = this.read(count);
    this.bit = saved;
    return value;
  }

  align(): void {
    this.bit = Math.ceil(this.bit / 8) * 8;
  }
}

function mapCode(code: number, map: number[] | undefined): number {
  return map?.[code] ?? code;
}

function decode2(reader: BitReader, out: number[], map2to4?: number[], map2to8?: number[]): void {
  while (reader.remaining >= 2 && out.length < MAX_LINE_PIXELS) {
    if (reader.peek(2) !== 0) {
      const code = reader.read(2);
      out.push(mapCode(code, map2to8 ?? map2to4));
      continue;
    }
    reader.read(2);
    const switch1 = reader.read(1);
    if (switch1 === 1) {
      const run = reader.read(3) + 3;
      const code = mapCode(reader.read(2), map2to8 ?? map2to4);
      for (let i = 0; i < run; i += 1) out.push(code);
      continue;
    }
    const switch2 = reader.read(1);
    if (switch2 === 1) {
      out.push(0);
      continue;
    }
    const switch3 = reader.read(2);
    if (switch3 === 0b10) {
      const run = reader.read(4) + 12;
      const code = mapCode(reader.read(2), map2to8 ?? map2to4);
      for (let i = 0; i < run; i += 1) out.push(code);
    } else if (switch3 === 0b11) {
      const run = reader.read(8) + 29;
      const code = mapCode(reader.read(2), map2to8 ?? map2to4);
      for (let i = 0; i < run; i += 1) out.push(code);
    } else if (switch3 === 0b01) {
      out.push(0, 0);
    } else {
      return;
    }
  }
}

function decode4(reader: BitReader, out: number[], map4to8?: number[]): void {
  while (reader.remaining >= 4 && out.length < MAX_LINE_PIXELS) {
    if (reader.peek(4) !== 0) {
      out.push(mapCode(reader.read(4), map4to8));
      continue;
    }
    reader.read(4);
    const switch1 = reader.read(1);
    if (switch1 === 0) {
      const run = reader.peek(3);
      if (run === 0) {
        reader.read(3);
        return;
      }
      const length = reader.read(3) + 2;
      for (let i = 0; i < length; i += 1) out.push(0);
      continue;
    }
    const switch2 = reader.read(1);
    if (switch2 === 0) {
      const length = reader.read(2) + 4;
      const code = mapCode(reader.read(4), map4to8);
      for (let i = 0; i < length; i += 1) out.push(code);
      continue;
    }
    const switch3 = reader.read(2);
    if (switch3 === 0b10) {
      const length = reader.read(4) + 9;
      const code = mapCode(reader.read(4), map4to8);
      for (let i = 0; i < length; i += 1) out.push(code);
    } else if (switch3 === 0b11) {
      const length = reader.read(8) + 25;
      const code = mapCode(reader.read(4), map4to8);
      for (let i = 0; i < length; i += 1) out.push(code);
    } else {
      return;
    }
  }
}

function decode8(reader: BitReader, out: number[]): void {
  while (reader.remaining >= 8 && out.length < MAX_LINE_PIXELS) {
    if (reader.peek(8) !== 0) {
      out.push(reader.read(8));
      continue;
    }
    reader.read(8);
    const switch1 = reader.read(1);
    if (switch1 === 0) {
      const run = reader.read(7);
      if (run === 0) return;
      for (let i = 0; i < run; i += 1) out.push(0);
    } else {
      const run = reader.read(7);
      const code = reader.read(8);
      for (let i = 0; i < run; i += 1) out.push(code);
    }
  }
}

function decodeField(data: Uint8Array): { lines: number[][]; depth: number } {
  const reader = new BitReader(data);
  const lines: number[][] = [];
  let pixels: number[] = [];
  let depth = 0;
  let map2to4: number[] | undefined;
  let map2to8: number[] | undefined;
  let map4to8: number[] | undefined;

  while (reader.remaining >= 8) {
    const type = reader.read(8);
    if (type === 0xf0) {
      if (pixels.length > 0) lines.push(pixels);
      pixels = [];
      reader.align();
      continue;
    }
    if (type === 0x10) {
      depth = Math.max(depth, 2);
      decode2(reader, pixels, map2to4, map2to8);
      reader.align();
      continue;
    }
    if (type === 0x11) {
      depth = Math.max(depth, 4);
      decode4(reader, pixels, map4to8);
      reader.align();
      continue;
    }
    if (type === 0x12) {
      depth = Math.max(depth, 8);
      decode8(reader, pixels);
      reader.align();
      continue;
    }
    if (type === 0x20 && reader.remaining >= 16) {
      const first = reader.read(8);
      const second = reader.read(8);
      map2to4 = [
        (first >> 4) & 0x0f,
        first & 0x0f,
        (second >> 4) & 0x0f,
        second & 0x0f,
      ];
      continue;
    }
    if (type === 0x21 && reader.remaining >= 32) {
      map2to8 = [reader.read(8), reader.read(8), reader.read(8), reader.read(8)];
      continue;
    }
    if (type === 0x22 && reader.remaining >= 128) {
      map4to8 = Array.from({ length: 16 }, () => reader.read(8));
      continue;
    }
    // Unknown/reserved sub-block; stop decoding this field.
    break;
  }
  if (pixels.length > 0) lines.push(pixels);
  return { lines, depth: depth || 2 };
}

function parseObject(body: Uint8Array): { objectId: number; pixels: ObjectPixels } | null {
  if (body.length < 7) return null;
  const objectId = readU16(body, 0);
  const coding = body[2] as number;
  if (((coding >> 6) & 0x03) !== 0) return null;
  const topLength = readU16(body, 3);
  const bottomLength = readU16(body, 5);
  const topStart = 7;
  const topEnd = Math.min(body.length, topStart + topLength);
  const bottomStart = topEnd;
  const bottomEnd = Math.min(body.length, bottomStart + bottomLength);
  if (topEnd <= topStart) return null;
  const top = decodeField(body.subarray(topStart, topEnd));
  const bottom = bottomLength > 0 ? decodeField(body.subarray(bottomStart, bottomEnd)) : top;
  const width = Math.max(
    ...top.lines.map((line) => line.length),
    ...bottom.lines.map((line) => line.length),
    0,
  );
  const height = Math.max(top.lines.length, bottom.lines.length) * 2;
  const lines: number[][] = [];
  for (let row = 0; row < height; row += 1) {
    const field = row % 2 === 0 ? top : bottom;
    const source = field.lines[Math.floor(row / 2)] ?? [];
    const line = new Array<number>(width).fill(0);
    for (let i = 0; i < source.length && i < width; i += 1) line[i] = source[i] as number;
    lines.push(line);
  }
  return {
    objectId,
    pixels: { width, height, depth: Math.max(top.depth, bottom.depth), lines },
  };
}

function chooseClut(clut: ClutSet, depth: number): ClutFamily {
  if (depth >= 8 && clut.entries8.some((entry) => entry[3] > 0)) return clut.entries8;
  if (depth >= 4 && clut.entries4.some((entry) => entry[3] > 0)) return clut.entries4;
  if (clut.entries2.some((entry) => entry[3] > 0)) return clut.entries2;
  if (clut.entries4.some((entry) => entry[3] > 0)) return clut.entries4;
  return clut.entries8;
}

function buildRegion(
  definition: RegionDefinition,
  page: PageRegion,
  objects: Map<number, ObjectPixels>,
  cluts: Map<number, ClutSet>,
): DvbBitmapRegion | null {
  let depth = definition.depth;
  for (const placement of definition.objects) {
    const object = objects.get(placement.objectId);
    if (object) depth = Math.max(depth, object.depth);
  }
  const clut = cluts.get(definition.clutId);
  const family = clut ? chooseClut(clut, depth) : emptyClut();
  const palette = new Uint8Array(1024);
  for (let i = 0; i < 256; i += 1) {
    const entry = family[i] as Rgba;
    palette[i * 4] = entry[0];
    palette[i * 4 + 1] = entry[1];
    palette[i * 4 + 2] = entry[2];
    palette[i * 4 + 3] = entry[3];
  }
  const pixels = new Uint8Array(definition.width * definition.height);
  if (definition.fill && definition.fillCode !== 0) {
    pixels.fill(definition.fillCode);
  }
  for (const placement of definition.objects) {
    const object = objects.get(placement.objectId);
    if (!object) continue;
    for (let row = 0; row < object.height; row += 1) {
      const targetY = placement.y + row;
      if (targetY < 0 || targetY >= definition.height) continue;
      const source = object.lines[row] as number[];
      for (let column = 0; column < object.width; column += 1) {
        const code = source[column] ?? 0;
        if (code === 0) continue;
        const targetX = placement.x + column;
        if (targetX < 0 || targetX >= definition.width) continue;
        pixels[targetY * definition.width + targetX] = code;
      }
    }
  }
  return {
    x: page.x,
    y: page.y,
    width: definition.width,
    height: definition.height,
    palette,
    pixels,
  };
}

interface DisplaySetState {
  width?: number;
  height?: number;
  window?: DvbDisplayWindow;
  pageState?: number;
  pageRegions?: PageRegion[];
}

function processSegments(
  segments: DvbSubtitleSegment[],
  display: DisplaySetState,
  cluts: Map<number, ClutSet>,
  regions: Map<number, RegionDefinition>,
  objects: Map<number, ObjectPixels>,
): void {
  for (const segment of segments) {
    const body = segment.body;
    if (!body) continue;
    if (segment.type === 0x14) {
      const width = readU16(body, 1) + 1;
      const height = readU16(body, 3) + 1;
      if (width > 0 && height > 0) {
        display.width = width;
        display.height = height;
        const windowFlag = ((body[0] as number) & 0x08) !== 0;
        if (windowFlag && body.length >= 13) {
          const minX = readU16(body, 5);
          const minY = readU16(body, 7);
          const maxX = readU16(body, 9);
          const maxY = readU16(body, 11);
          const windowWidth = Math.max(0, maxX - minX + 1);
          const windowHeight = Math.max(0, maxY - minY + 1);
          if (windowWidth > 0 && windowHeight > 0) {
            display.window = {
              x: Math.max(0, Math.min(width - 1, minX)),
              y: Math.max(0, Math.min(height - 1, minY)),
              width: Math.min(width - minX, windowWidth),
              height: Math.min(height - minY, windowHeight),
            };
          }
        } else {
          display.window = { x: 0, y: 0, width, height };
        }
      }
    } else if (segment.type === 0x12) {
      cluts.set(body[0] as number, parseClut(body));
    } else if (segment.type === 0x11) {
      const definition = parseRegionComposition(body);
      if (definition) regions.set(body[0] as number, definition);
    } else if (segment.type === 0x13) {
      const object = parseObject(body);
      if (object) objects.set(object.objectId, object.pixels);
    } else if (segment.type === 0x10) {
      const page = parsePageComposition(body);
      display.pageState = page.state;
      display.pageRegions = page.regions;
    }
  }
}

function splitDisplaySets(segments: DvbSubtitleSegment[]): DvbSubtitleSegment[][] {
  const sets: DvbSubtitleSegment[][] = [];
  let current: DvbSubtitleSegment[] = [];
  for (const segment of segments) {
    current.push(segment);
    if (segment.type === 0x80) {
      sets.push(current);
      current = [];
    }
  }
  if (current.length > 0) sets.push(current);
  return sets;
}

/**
 * Collect visible display-set times without decoding pixel data.
 * State 0 display sets with at least one region are visible; state 2 and empty
 * page compositions end the previous frame.
 */
export function collectDvbSubtitleTimeline(packets: PesPacket[]): DvbSubtitleTimeline {
  const ordered = [...packets].sort(
    (a, b) => (a.ptsSeconds ?? 0) - (b.ptsSeconds ?? 0),
  );
  let width = 0;
  let height = 0;
  const entries: Array<{ start: number; visible: boolean }> = [];
  for (const pes of ordered) {
    const index = indexDvbSubtitlePes(pes.payload);
    if (!index) continue;
    for (const set of splitDisplaySets(index.segments)) {
      let pageState: number | undefined;
      let pageRegions = 0;
      for (const segment of set) {
        if (!segment.body) continue;
        if (segment.type === 0x14) {
          const w = readU16(segment.body, 1) + 1;
          const h = readU16(segment.body, 3) + 1;
          if (w > 0 && h > 0) {
            width = w;
            height = h;
          }
        } else if (segment.type === 0x10) {
          const page = parsePageComposition(segment.body);
          pageState = page.state;
          pageRegions = page.regions.length;
        }
      }
      if (pageState === undefined) continue;
      if (pageState === 0 || pageState === 2) {
        entries.push({
          start: pes.ptsSeconds ?? 0,
          visible: pageRegions > 0,
        });
      }
    }
  }
  entries.sort((a, b) => a.start - b.start);
  const frames: DvbSubtitleTimelineEntry[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] as { start: number; visible: boolean };
    if (!entry.visible) continue;
    const next = entries[i + 1]?.start;
    frames.push({
      start: entry.start,
      end: next !== undefined && next > entry.start ? next : entry.start + 5,
    });
    if (frames.length >= MAX_TIMELINE_FRAMES) break;
  }
  return {
    width: width || 720,
    height: height || 576,
    frames,
    truncated: frames.length >= MAX_TIMELINE_FRAMES,
  };
}

/** Render the subtitle layer visible at `timeSec`. */
export function renderDvbSubtitleFrame(
  packets: PesPacket[],
  timeSec: number,
): DvbBitmapFrame | null {
  const ordered = [...packets].sort(
    (a, b) => (a.ptsSeconds ?? 0) - (b.ptsSeconds ?? 0),
  );
  const cluts = new Map<number, ClutSet>();
  const regions = new Map<number, RegionDefinition>();
  const objects = new Map<number, ObjectPixels>();
  let displayWidth = 0;
  let displayHeight = 0;
  let displayWindow: DvbDisplayWindow | undefined;
  let current: DvbBitmapFrame | null = null;

  for (const pes of ordered) {
    const time = pes.ptsSeconds ?? 0;
    if (time > timeSec) break;
    const index = indexDvbSubtitlePes(pes.payload);
    if (!index) continue;
    for (const set of splitDisplaySets(index.segments)) {
      const display: DisplaySetState = {};
      // Updates in acquisition sets must persist for later display sets.
      processSegments(set, display, cluts, regions, objects);
      if (display.width !== undefined) displayWidth = display.width;
      if (display.height !== undefined) displayHeight = display.height;
      if (display.window !== undefined) displayWindow = display.window;
      if (display.pageState === undefined) continue;
      if (display.pageState === 0 || display.pageState === 2) {
        const pageRegions = display.pageRegions ?? [];
        if (pageRegions.length === 0) {
          current = null;
          continue;
        }
        const width = displayWidth || 720;
        const height = displayHeight || 576;
        const window: DvbDisplayWindow =
          displayWindow ?? { x: 0, y: 0, width, height };
        const composed: DvbBitmapRegion[] = [];
        for (const page of pageRegions) {
          const definition = regions.get(page.regionId);
          if (!definition) continue;
          const region = buildRegion(
            definition,
            {
              regionId: page.regionId,
              x: window.x + page.x,
              y: window.y + page.y,
            },
            objects,
            cluts,
          );
          if (region) composed.push(region);
        }
        current =
          composed.length > 0 ? { width, height, window, regions: composed } : null;
      }
    }
  }
  return current;
}
