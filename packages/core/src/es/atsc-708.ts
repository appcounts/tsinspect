/**
 * CEA-708 (DTVCC) decoder for ATSC closed captions.
 *
 * The decoder assembles DTVCC packets from cc_data type 2/3 byte pairs, walks
 * the service blocks and interprets the C0/C1 caption commands. It keeps up to
 * six services, each with eight windows, and returns visible windows with their
 * text grid, colours and pen attributes for the subtitle report and WebUI.
 */

import type { AtscCaptionUnit } from './atsc-captions.js';

export interface Atsc708Cell {
  char: string;
  fg: string;
  bg: string;
  italics: boolean;
  underline: boolean;
}

export interface Atsc708WindowSnapshot {
  id: number;
  priority: number;
  visible: boolean;
  anchorPoint: number;
  relative: boolean;
  anchorVertical: number;
  anchorHorizontal: number;
  rowCount: number;
  columnCount: number;
  justify: number;
  fillColor: string;
  fillOpacity: number;
  borderColor: string;
  borderType: number;
  penSize: number;
  fontStyle: number;
  italics: boolean;
  underline: boolean;
  edgeType: number;
  edgeColor: string;
  fgColor: string;
  fgOpacity: number;
  bgColor: string;
  bgOpacity: number;
  rows: Array<Array<Atsc708Cell | null>>;
}

export interface Atsc708Snapshot {
  service: number;
  windows: Atsc708WindowSnapshot[];
  text: string;
}

interface WindowState {
  visible: boolean;
  priority: number;
  anchorPoint: number;
  relative: boolean;
  anchorVertical: number;
  anchorHorizontal: number;
  rowCount: number;
  columnCount: number;
  rowLock: boolean;
  columnLock: boolean;
  windowStyle: number;
  penStyle: number;
  justify: number;
  fillColor: string;
  fillOpacity: number;
  borderColor: string;
  borderType: number;
  penSize: number;
  fontStyle: number;
  italics: boolean;
  underline: boolean;
  edgeType: number;
  edgeColor: string;
  fgColor: string;
  fgOpacity: number;
  bgColor: string;
  bgOpacity: number;
  rows: Array<Array<Atsc708Cell | null>>;
  penRow: number;
  penCol: number;
}

interface ServiceState {
  windows: Array<WindowState | null>;
  current: number | null;
}

const SERVICES = 6;
const WINDOWS = 8;
const MAX_ROWS = 15;
const MAX_COLS = 42;

const RGB_LEVELS = [0, 85, 170, 255];

function rgb(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((value) => (RGB_LEVELS[value & 3] ?? 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

function blankRow(columns: number): Array<Atsc708Cell | null> {
  return Array.from({ length: columns }, () => null);
}

function newWindow(): WindowState {
  return {
    visible: false,
    priority: 0,
    anchorPoint: 0,
    relative: false,
    anchorVertical: 0,
    anchorHorizontal: 0,
    rowCount: 1,
    columnCount: 1,
    rowLock: false,
    columnLock: false,
    windowStyle: 1,
    penStyle: 1,
    justify: 0,
    fillColor: '#000000',
    fillOpacity: 0,
    borderColor: '#000000',
    borderType: 0,
    penSize: 1,
    fontStyle: 0,
    italics: false,
    underline: false,
    edgeType: 0,
    edgeColor: '#000000',
    fgColor: '#ffffff',
    fgOpacity: 0,
    bgColor: '#000000',
    bgOpacity: 0,
    rows: [blankRow(1)],
    penRow: 0,
    penCol: 0,
  };
}

function ensureGrid(window: WindowState): void {
  const rows = Math.max(1, Math.min(MAX_ROWS, window.rowCount));
  const columns = Math.max(1, Math.min(MAX_COLS, window.columnCount));
  while (window.rows.length < rows) window.rows.push(blankRow(columns));
  if (window.rows.length > rows) window.rows.length = rows;
  for (const row of window.rows) {
    while (row.length < columns) row.push(null);
    if (row.length > columns) row.length = columns;
  }
  window.penRow = Math.max(0, Math.min(rows - 1, window.penRow));
  window.penCol = Math.max(0, Math.min(columns, window.penCol));
}

function clearWindow(window: WindowState): void {
  const columns = Math.max(1, Math.min(MAX_COLS, window.columnCount));
  window.rows = Array.from({ length: Math.max(1, Math.min(MAX_ROWS, window.rowCount)) }, () =>
    blankRow(columns),
  );
  window.penRow = 0;
  window.penCol = 0;
}

function applyWindowStyle(window: WindowState, style: number): void {
  window.justify = 0;
  window.fillColor = '#000000';
  window.fillOpacity = 0;
  switch (style) {
    case 2:
      window.fillOpacity = 3;
      break;
    case 3:
      window.justify = 2;
      break;
    case 4:
    case 5:
      break;
    case 6:
      window.justify = 2;
      break;
    case 7:
      break;
    default:
      break;
  }
}

function applyPenStyle(window: WindowState, style: number): void {
  window.penSize = 1;
  window.fontStyle = 0;
  window.italics = false;
  window.underline = false;
  window.edgeType = 0;
  window.fgColor = '#ffffff';
  window.fgOpacity = 0;
  if (style >= 2) window.fontStyle = 4;
}

function windowText(window: WindowState): string {
  return window.rows
    .map((row) =>
      row
        .map((cell) => cell?.char ?? ' ')
        .join('')
        .replace(/\s+$/g, ''),
    )
    .filter((line) => line.length > 0)
    .join('\n');
}

function snapshotWindow(id: number, window: WindowState): Atsc708WindowSnapshot {
  return {
    id,
    priority: window.priority,
    visible: window.visible,
    anchorPoint: window.anchorPoint,
    relative: window.relative,
    anchorVertical: window.anchorVertical,
    anchorHorizontal: window.anchorHorizontal,
    rowCount: window.rowCount,
    columnCount: window.columnCount,
    justify: window.justify,
    fillColor: window.fillColor,
    fillOpacity: window.fillOpacity,
    borderColor: window.borderColor,
    borderType: window.borderType,
    penSize: window.penSize,
    fontStyle: window.fontStyle,
    italics: window.italics,
    underline: window.underline,
    edgeType: window.edgeType,
    edgeColor: window.edgeColor,
    fgColor: window.fgColor,
    fgOpacity: window.fgOpacity,
    bgColor: window.bgColor,
    bgOpacity: window.bgOpacity,
    rows: window.rows.map((row) => row.slice()),
  };
}

export class Atsc708Decoder {
  private readonly services: ServiceState[] = Array.from({ length: SERVICES }, () => ({
    windows: Array.from({ length: WINDOWS }, () => null),
    current: null,
  }));

  private packet: number[] = [];
  private expected = 0;

  pushUnits(units: AtscCaptionUnit[]): void {
    for (const unit of units) {
      if (!unit.valid || unit.ccType < 2) continue;
      if (unit.ccType === 3) {
        this.flushPacket();
        this.packet = [unit.data1, unit.data2];
        const sizeCode = unit.data1 & 0x3f;
        this.expected = sizeCode === 0 ? 128 : sizeCode * 2;
        if (this.packet.length >= this.expected) this.flushPacket();
        continue;
      }
      if (this.packet.length === 0) {
        this.packet = [unit.data1, unit.data2];
        this.expected = 0;
      } else {
        this.packet.push(unit.data1, unit.data2);
      }
      if (this.expected > 0 && this.packet.length >= this.expected) {
        this.flushPacket();
      }
    }
  }

  private flushPacket(): void {
    if (this.packet.length < 2) {
      this.packet = [];
      this.expected = 0;
      return;
    }
    const header = this.packet[0] as number;
    const sizeCode = header & 0x3f;
    const dataSize = sizeCode === 0 ? 127 : sizeCode * 2 - 1;
    const end = Math.min(this.packet.length, 1 + dataSize);
    this.decodeServiceBlocks(this.packet.slice(1, end));
    this.packet = [];
    this.expected = 0;
  }

  private decodeServiceBlocks(body: number[]): void {
    let cursor = 0;
    while (cursor < body.length) {
      const header = body[cursor] as number;
      cursor += 1;
      if (header === 0) break;
      let service = (header >> 5) & 0x07;
      const blockSize = header & 0x1f;
      if (service === 7 && blockSize > 0 && cursor < body.length) {
        service = (body[cursor] as number) & 0x3f;
        cursor += 1;
      }
      if (blockSize === 0) break;
      const block = body.slice(cursor, Math.min(body.length, cursor + blockSize));
      cursor += blockSize;
      if (service >= 1 && service <= SERVICES) {
        this.interpret(this.services[service - 1] as ServiceState, block);
      }
      if (block.length < blockSize) break;
    }
  }

  private interpret(service: ServiceState, block: number[]): void {
    let cursor = 0;
    while (cursor < block.length) {
      const value = block[cursor] as number;
      let consumed = 1;
      if (value <= 0x1f) {
        consumed = this.handleC0(service, block.slice(cursor));
      } else if (value <= 0x7f) {
        this.putChar(service, value === 0x7f ? '\u266a' : String.fromCharCode(value));
      } else if (value <= 0x9f) {
        consumed = this.handleC1(service, block.slice(cursor));
      } else {
        this.putChar(service, String.fromCharCode(value));
      }
      cursor += Math.max(1, consumed);
    }
  }

  private current(service: ServiceState): WindowState | undefined {
    if (service.current === null) return undefined;
    return service.windows[service.current] ?? undefined;
  }

  private putChar(service: ServiceState, char: string): void {
    const window = this.current(service);
    if (!window) return;
    ensureGrid(window);
    if (window.penRow >= window.rows.length) return;
    if (window.penCol >= window.columnCount) {
      window.penCol = 0;
      window.penRow += 1;
      if (window.penRow >= window.rows.length) {
        window.rows.shift();
        window.rows.push(blankRow(window.columnCount));
        window.penRow = window.rows.length - 1;
      }
    }
    const row = window.rows[window.penRow];
    if (!row) return;
    row[window.penCol] = {
      char,
      fg: window.fgColor,
      bg: window.bgColor,
      italics: window.italics,
      underline: window.underline,
    };
    window.penCol += 1;
  }

  private handleC0(service: ServiceState, data: number[]): number {
    const value = data[0] as number;
    const window = this.current(service);
    switch (value) {
      case 0x00:
      case 0x03:
        return 1;
      case 0x08:
        if (window && window.penCol > 0) {
          window.penCol -= 1;
          const row = window.rows[window.penRow];
          if (row) row[window.penCol] = null;
        }
        return 1;
      case 0x0c:
        if (window) clearWindow(window);
        return 1;
      case 0x0d:
        if (window) this.carriageReturn(window);
        return 1;
      case 0x0e:
        if (window) {
          const row = window.rows[window.penRow];
          if (row) row.fill(null);
          window.penCol = 0;
        }
        return 1;
      case 0x10:
        return this.handleExt1(service, data);
      case 0x18:
        return 3;
      case 0x11:
      case 0x12:
      case 0x13:
      case 0x14:
      case 0x15:
      case 0x16:
      case 0x17:
        return 2;
      case 0x19:
      case 0x1a:
      case 0x1b:
      case 0x1c:
      case 0x1d:
      case 0x1e:
      case 0x1f:
        return 3;
      default:
        return 1;
    }
  }

  private carriageReturn(window: WindowState): void {
    window.penCol = 0;
    if (window.penRow + 1 < window.rows.length) {
      window.penRow += 1;
    } else {
      window.rows.shift();
      window.rows.push(blankRow(window.columnCount));
      window.penRow = window.rows.length - 1;
    }
  }

  private handleExt1(service: ServiceState, data: number[]): number {
    const base = data[1];
    if (base === undefined) return 1;
    if (base >= 0x20 && base <= 0x7f) {
      const map: Record<number, string> = {
        0x20: ' ',
        0x21: ' ',
        0x25: '…',
        0x2a: 'Š',
        0x2c: 'Œ',
        0x30: '■',
        0x31: '‘',
        0x32: '’',
        0x33: '“',
        0x34: '”',
        0x35: '•',
        0x39: '™',
        0x3a: 'š',
        0x3c: 'œ',
        0x3f: 'Ÿ',
      };
      this.putChar(service, map[base] ?? '_');
      return 2;
    }
    if (base >= 0x80 && base <= 0x87) return 6;
    if (base >= 0x88 && base <= 0x8f) return 7;
    if (base >= 0x90 && base <= 0x9f) {
      const n = data[2] === undefined ? 0 : (data[2] & 0x3f) + 1;
      return 3 + n;
    }
    return 2;
  }

  private handleC1(service: ServiceState, data: number[]): number {
    const op = data[0] as number;
    if (op >= 0x80 && op <= 0x87) {
      const id = op - 0x80;
      if (service.windows[id]) service.current = id;
      return 1;
    }
    switch (op) {
      case 0x88:
        return this.windowMap(service, data, 'clear');
      case 0x89:
        return this.windowMap(service, data, 'display');
      case 0x8a:
        return this.windowMap(service, data, 'hide');
      case 0x8b:
        return this.windowMap(service, data, 'toggle');
      case 0x8c:
        return this.windowMap(service, data, 'delete');
      case 0x8d:
        return 2;
      case 0x8e:
        return 1;
      case 0x8f:
        this.resetService(service);
        return 1;
      case 0x90:
        return this.setPenAttributes(service, data);
      case 0x91:
        return this.setPenColor(service, data);
      case 0x92:
        return this.setPenLocation(service, data);
      case 0x97:
        return this.setWindowAttributes(service, data);
      default:
        if (op >= 0x98 && op <= 0x9f) return this.defineWindow(service, data);
        return 1;
    }
  }

  private resetService(service: ServiceState): void {
    service.windows = Array.from({ length: WINDOWS }, () => null);
    service.current = null;
  }

  private windowMap(
    service: ServiceState,
    data: number[],
    action: 'clear' | 'display' | 'hide' | 'toggle' | 'delete',
  ): number {
    const map = data[1];
    if (map === undefined) return 1;
    for (let id = 0; id < WINDOWS; id += 1) {
      if ((map & (1 << id)) === 0) continue;
      const window = service.windows[id];
      if (action === 'delete') {
        service.windows[id] = null;
        if (service.current === id) service.current = null;
        continue;
      }
      if (!window) continue;
      if (action === 'clear') clearWindow(window);
      else if (action === 'display') window.visible = true;
      else if (action === 'hide') window.visible = false;
      else window.visible = !window.visible;
    }
    return 2;
  }

  private defineWindow(service: ServiceState, data: number[]): number {
    if (data.length < 7) return Math.max(1, data.length);
    const id = (data[0] as number) - 0x98;
    const p1 = data[1] as number;
    const p2 = data[2] as number;
    const p3 = data[3] as number;
    const p4 = data[4] as number;
    const p5 = data[5] as number;
    const p6 = data[6] as number;
    const creating = service.windows[id] === null;
    const window = service.windows[id] ?? newWindow();
    service.windows[id] = window;

    window.priority = p1 & 0x07;
    window.columnLock = ((p1 >> 3) & 0x01) !== 0;
    window.rowLock = ((p1 >> 4) & 0x01) !== 0;
    window.visible = ((p1 >> 5) & 0x01) !== 0;
    window.relative = ((p2 >> 7) & 0x01) !== 0;
    window.anchorVertical = p2 & 0x7f;
    window.anchorHorizontal = p3;
    window.anchorPoint = (p4 >> 4) & 0x0f;
    window.rowCount = (p4 & 0x0f) + 1;
    window.columnCount = (p5 & 0x3f) + 1;
    window.windowStyle = (p6 >> 3) & 0x07;
    window.penStyle = p6 & 0x07;

    if (creating) {
      applyWindowStyle(window, window.windowStyle === 0 ? 1 : window.windowStyle);
      applyPenStyle(window, window.penStyle === 0 ? 1 : window.penStyle);
      ensureGrid(window);
      clearWindow(window);
    } else {
      if (window.windowStyle !== 0) applyWindowStyle(window, window.windowStyle);
      if (window.penStyle !== 0) applyPenStyle(window, window.penStyle);
      ensureGrid(window);
    }
    service.current = id;
    return 7;
  }

  private setPenAttributes(service: ServiceState, data: number[]): number {
    if (data.length < 3) return Math.max(1, data.length);
    const window = this.current(service);
    if (window) {
      const p1 = data[1] as number;
      const p2 = data[2] as number;
      window.penSize = p1 & 0x03;
      window.italics = ((p2 >> 7) & 0x01) !== 0;
      window.underline = ((p2 >> 6) & 0x01) !== 0;
      window.edgeType = (p2 >> 3) & 0x07;
      window.fontStyle = p2 & 0x07;
    }
    return 3;
  }

  private setPenColor(service: ServiceState, data: number[]): number {
    if (data.length < 4) return Math.max(1, data.length);
    const window = this.current(service);
    if (window) {
      const p1 = data[1] as number;
      const p2 = data[2] as number;
      const p3 = data[3] as number;
      window.fgOpacity = (p1 >> 6) & 0x03;
      window.fgColor = rgb((p1 >> 4) & 3, (p1 >> 2) & 3, p1 & 3);
      window.bgOpacity = (p2 >> 6) & 0x03;
      window.bgColor = rgb((p2 >> 4) & 3, (p2 >> 2) & 3, p2 & 3);
      window.edgeColor = rgb((p3 >> 4) & 3, (p3 >> 2) & 3, p3 & 3);
    }
    return 4;
  }

  private setPenLocation(service: ServiceState, data: number[]): number {
    if (data.length < 3) return Math.max(1, data.length);
    const window = this.current(service);
    if (window) {
      ensureGrid(window);
      window.penRow = Math.max(0, Math.min(window.rows.length - 1, (data[1] as number) & 0x0f));
      window.penCol = Math.max(0, Math.min(window.columnCount, (data[2] as number) & 0x3f));
    }
    return 3;
  }

  private setWindowAttributes(service: ServiceState, data: number[]): number {
    if (data.length < 5) return Math.max(1, data.length);
    const window = this.current(service);
    if (window) {
      const p1 = data[1] as number;
      const p2 = data[2] as number;
      const p3 = data[3] as number;
      window.fillOpacity = (p1 >> 6) & 0x03;
      window.fillColor = rgb((p1 >> 4) & 3, (p1 >> 2) & 3, p1 & 3);
      window.borderColor = rgb((p2 >> 4) & 3, (p2 >> 2) & 3, p2 & 3);
      const btLow = (p2 >> 6) & 0x03;
      const btHigh = (p3 >> 7) & 0x01;
      window.borderType = (btHigh << 2) | btLow;
      window.justify = p3 & 0x03;
    }
    return 5;
  }

  /** One snapshot per service that currently shows text. */
  snapshots(): Atsc708Snapshot[] {
    const list: Atsc708Snapshot[] = [];
    for (let index = 0; index < this.services.length; index += 1) {
      const service = this.services[index] as ServiceState;
      const windows: Atsc708WindowSnapshot[] = [];
      for (let id = 0; id < WINDOWS; id += 1) {
        const window = service.windows[id];
        if (!window || !window.visible) continue;
        const text = windowText(window);
        if (text.length === 0) continue;
        windows.push(snapshotWindow(id, window));
      }
      const text = windows
        .sort((a, b) => a.priority - b.priority || a.id - b.id)
        .map((window) => windowTextFromSnapshot(window))
        .filter((value) => value.length > 0)
        .join('\n');
      if (text.length === 0) continue;
      list.push({ service: index + 1, windows, text });
    }
    return list;
  }

  snapshot(): Atsc708Snapshot | undefined {
    let best: Atsc708Snapshot | undefined;
    for (const snapshot of this.snapshots()) {
      if (!best || snapshot.text.length > best.text.length) best = snapshot;
    }
    return best;
  }
}

function windowTextFromSnapshot(window: Atsc708WindowSnapshot): string {
  return window.rows
    .map((row) =>
      row
        .map((cell) => cell?.char ?? ' ')
        .join('')
        .replace(/\s+$/g, ''),
    )
    .filter((line) => line.length > 0)
    .join('\n');
}
