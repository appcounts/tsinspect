/**
 * CEA-608 closed-caption decoder (ATSC A/53 Part 4, line 21).
 *
 * The decoder keeps the four caption channels (CC1–CC4), a displayed and a
 * non-displayed 15×32 screen, pop-on / roll-up / paint-on modes, PAC row and
 * column placement, colour, italics and underline. It returns styled snapshots
 * for the subtitle report and WebUI preview.
 */

import type { AtscCaptionUnit } from './atsc-captions.js';

export type Atsc608Color =
  | 'white'
  | 'green'
  | 'blue'
  | 'cyan'
  | 'red'
  | 'yellow'
  | 'magenta';

export interface Atsc608Pen {
  color: Atsc608Color;
  italics: boolean;
  underline: boolean;
}

export interface Atsc608Cell {
  char: string;
  pen: Atsc608Pen;
}

export type Atsc608Row = Array<Atsc608Cell | null>;

export interface Atsc608Snapshot {
  channel: 1 | 2 | 3 | 4;
  mode: 'pop-on' | 'roll-up' | 'paint-on' | 'text';
  rows: Atsc608Row[];
  text: string;
}

const ROWS = 15;
const COLS = 32;

const COLORS: Atsc608Color[] = [
  'white',
  'green',
  'blue',
  'cyan',
  'red',
  'yellow',
  'magenta',
];

const DEFAULT_PEN: Atsc608Pen = {
  color: 'white',
  italics: false,
  underline: false,
};

interface ChannelState {
  displayed: Atsc608Row[];
  nonDisplayed: Atsc608Row[];
  cursorRow: number;
  cursorCol: number;
  pen: Atsc608Pen;
  mode: 'pop-on' | 'roll-up' | 'paint-on' | 'text';
  rollUpRows: number;
}

function emptyScreen(): Atsc608Row[] {
  return Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => null));
}

function cloneRows(rows: Atsc608Row[]): Atsc608Row[] {
  return rows.map((row) => row.slice());
}

function newChannel(): ChannelState {
  return {
    displayed: emptyScreen(),
    nonDisplayed: emptyScreen(),
    cursorRow: ROWS - 1,
    cursorCol: 0,
    pen: { ...DEFAULT_PEN },
    mode: 'pop-on',
    rollUpRows: 2,
  };
}

function standardChar(byte: number): string {
  switch (byte) {
    case 0x2a:
      return 'á';
    case 0x5c:
      return 'é';
    case 0x5e:
      return 'í';
    case 0x5f:
      return 'ó';
    case 0x60:
      return 'ú';
    case 0x7b:
      return 'ç';
    case 0x7c:
      return '÷';
    case 0x7d:
      return 'Ñ';
    case 0x7e:
      return 'ñ';
    case 0x7f:
      return '■';
    default:
      return String.fromCharCode(byte);
  }
}

const SPECIAL_CHARS: Record<number, string> = {
  0x30: '®',
  0x31: '°',
  0x32: '½',
  0x33: '¿',
  0x34: '™',
  0x35: '¢',
  0x36: '£',
  0x37: '♪',
  0x38: 'à',
  0x39: ' ',
  0x3a: 'è',
  0x3b: 'â',
  0x3c: 'ê',
  0x3d: 'î',
  0x3e: 'ô',
  0x3f: 'û',
};

const EXTENDED_BLOCK1: Record<number, string> = {
  0x20: 'Á',
  0x21: 'É',
  0x22: 'Ó',
  0x23: 'Ú',
  0x24: 'Ü',
  0x25: 'ü',
  0x26: '‘',
  0x27: '¡',
  0x28: '*',
  0x29: "'",
  0x2a: '—',
  0x2b: '©',
  0x2c: '℠',
  0x2d: '•',
  0x2e: '“',
  0x2f: '”',
  0x30: 'À',
  0x31: 'Â',
  0x32: 'Ç',
  0x33: 'È',
  0x34: 'Ê',
  0x35: 'Ë',
  0x36: 'ë',
  0x37: 'Î',
  0x38: 'Ï',
  0x39: 'ï',
  0x3a: 'Ô',
  0x3b: 'Ù',
  0x3c: 'ù',
  0x3d: 'Û',
  0x3e: '«',
  0x3f: '»',
};

const EXTENDED_BLOCK2: Record<number, string> = {
  0x20: 'Ã',
  0x21: 'ã',
  0x22: 'Í',
  0x23: 'Ì',
  0x24: 'ì',
  0x25: 'Ò',
  0x26: 'ò',
  0x27: 'Õ',
  0x28: 'õ',
  0x29: '{',
  0x2a: '}',
  0x2b: '\\',
  0x2c: '^',
  0x2d: '_',
  0x2e: '|',
  0x2f: '~',
  0x30: 'Ä',
  0x31: 'ä',
  0x32: 'Ö',
  0x33: 'ö',
  0x34: 'ß',
  0x35: '¥',
  0x36: '¤',
  0x37: '│',
  0x38: 'Å',
  0x39: 'å',
  0x3a: 'Ø',
  0x3b: 'ø',
  0x3c: '┌',
  0x3d: '┐',
  0x3e: '└',
  0x3f: '┘',
};

function rowPairFor(first: number): number {
  switch (first) {
    case 0x11:
      return 1;
    case 0x12:
      return 3;
    case 0x15:
      return 5;
    case 0x16:
      return 7;
    case 0x17:
      return 9;
    case 0x10:
      return 11;
    case 0x13:
      return 12;
    case 0x14:
      return 14;
    default:
      return 1;
  }
}

function colorFromIndex(index: number): Atsc608Color {
  return COLORS[index] ?? 'white';
}

export class Atsc608Decoder {
  private readonly channels: ChannelState[] = [
    newChannel(),
    newChannel(),
    newChannel(),
    newChannel(),
  ];

  /** Last data channel selected by a control code for field 1 / field 2. */
  private readonly lastChannel = [0, 2];

  pushUnits(units: AtscCaptionUnit[]): void {
    for (const unit of units) {
      if (!unit.valid || unit.ccType > 1) continue;
      this.pushUnit(unit);
    }
  }

  private pushUnit(unit: AtscCaptionUnit): void {
    const field2 = unit.ccType === 1;
    const first = unit.data1 & 0x7f;
    const second = unit.data2 & 0x7f;
    const channel = this.channelFor(field2, first, second);
    const state = this.channels[channel] ?? (this.channels[0] as ChannelState);
    this.lastChannel[field2 ? 1 : 0] = channel;

    // Miscellaneous control codes.
    if (
      first === 0x14 ||
      first === 0x1c ||
      first === 0x15 ||
      first === 0x1d
    ) {
      if (second >= 0x20 && second <= 0x2f) {
        this.miscControl(state, second);
        return;
      }
    }

    // Preamble address codes (first byte is a control byte, 0x10–0x1F).
    if (first >= 0x10 && first <= 0x1f && second >= 0x40 && second <= 0x7f) {
      this.pac(state, first, second);
      return;
    }

    // Mid-row codes.
    if ((first === 0x11 || first === 0x19) && second >= 0x20 && second <= 0x2f) {
      this.midRow(state, second);
      return;
    }

    // Special characters.
    if ((first === 0x11 || first === 0x19) && second >= 0x30 && second <= 0x3f) {
      this.putChar(state, SPECIAL_CHARS[second] ?? '?');
      return;
    }

    // Extended characters block 1.
    if ((first === 0x12 || first === 0x1a) && second >= 0x20 && second <= 0x3f) {
      this.putExtended(state, EXTENDED_BLOCK1[second] ?? '?');
      return;
    }

    // Extended characters block 2.
    if ((first === 0x13 || first === 0x1b) && second >= 0x20 && second <= 0x3f) {
      this.putExtended(state, EXTENDED_BLOCK2[second] ?? '?');
      return;
    }

    // Tab offsets.
    if ((first === 0x17 || first === 0x1f) && second >= 0x21 && second <= 0x23) {
      state.cursorCol = Math.min(COLS, state.cursorCol + (second - 0x20));
      return;
    }

    // Printable pairs.
    if (first >= 0x20) this.putChar(state, standardChar(first));
    if (second >= 0x20) this.putChar(state, standardChar(second));
  }

  private channelFor(field2: boolean, first: number, second: number): number {
    const base = field2 ? 2 : 0;
    const isControl =
      first === 0x14 ||
      first === 0x1c ||
      first === 0x15 ||
      first === 0x1d;
    const isPac = first >= 0x10 && first <= 0x1f && second >= 0x40 && second <= 0x7f;
    const isMidRowOrSpecial =
      (first === 0x11 || first === 0x19) && second >= 0x20 && second <= 0x3f;
    if (isControl || isPac || isMidRowOrSpecial) {
      return base + ((first & 0x08) !== 0 ? 1 : 0);
    }
    return this.lastChannel[field2 ? 1 : 0] ?? base;
  }

  private active(state: ChannelState): Atsc608Row[] {
    return state.mode === 'pop-on' ? state.nonDisplayed : state.displayed;
  }

  private putChar(state: ChannelState, char: string): void {
    const screen = this.active(state);
    const row = Math.max(0, Math.min(ROWS - 1, state.cursorRow));
    const col = Math.max(0, Math.min(COLS - 1, state.cursorCol));
    const cells = screen[row];
    if (cells) {
      cells[col] = { char, pen: { ...state.pen } };
    }
    state.cursorCol = Math.min(COLS, col + 1);
  }

  private putExtended(state: ChannelState, char: string): void {
    if (state.cursorCol > 0) {
      state.cursorCol -= 1;
      const screen = this.active(state);
      const row = Math.max(0, Math.min(ROWS - 1, state.cursorRow));
      const col = Math.max(0, Math.min(COLS - 1, state.cursorCol));
      const cells = screen[row];
      if (cells) cells[col] = null;
    }
    this.putChar(state, char);
  }

  private miscControl(state: ChannelState, code: number): void {
    switch (code) {
      case 0x20: // RCL
        state.mode = 'pop-on';
        state.cursorRow = 0;
        state.cursorCol = 0;
        break;
      case 0x21: // BS
        if (state.cursorCol > 0) {
          state.cursorCol -= 1;
          const screen = this.active(state);
          const row = Math.max(0, Math.min(ROWS - 1, state.cursorRow));
          const cells = screen[row];
          if (cells) cells[Math.max(0, Math.min(COLS - 1, state.cursorCol))] = null;
        }
        break;
      case 0x24: {
        // DER
        const screen = this.active(state);
        const row = Math.max(0, Math.min(ROWS - 1, state.cursorRow));
        const cells = screen[row];
        if (cells) {
          for (let col = state.cursorCol; col < COLS; col += 1) cells[col] = null;
        }
        break;
      }
      case 0x25:
      case 0x26:
      case 0x27:
        state.mode = 'roll-up';
        state.rollUpRows = code === 0x25 ? 2 : code === 0x26 ? 3 : 4;
        state.cursorRow = ROWS - 1;
        state.cursorCol = 0;
        state.pen = { ...DEFAULT_PEN };
        break;
      case 0x29: // RDC
        state.mode = 'paint-on';
        break;
      case 0x2c: // EDM
        state.displayed = emptyScreen();
        break;
      case 0x2d: // CR
        this.carriageReturn(state);
        break;
      case 0x2e: // ENM
        state.nonDisplayed = emptyScreen();
        break;
      case 0x2f: {
        // EOC: swap displayed and non-displayed memories.
        const temp = state.displayed;
        state.displayed = state.nonDisplayed;
        state.nonDisplayed = temp;
        state.mode = 'pop-on';
        break;
      }
      case 0x2a: // TR
        state.mode = 'text';
        state.displayed = emptyScreen();
        state.cursorRow = 0;
        state.cursorCol = 0;
        break;
      case 0x2b: // RTD
        state.mode = 'text';
        break;
      default:
        break;
    }
  }

  private carriageReturn(state: ChannelState): void {
    if (state.mode === 'roll-up') {
      const base = Math.max(0, Math.min(ROWS - 1, state.cursorRow));
      const rows = Math.max(1, state.rollUpRows);
      const top = Math.max(0, base - rows + 1);
      for (let row = top; row < base; row += 1) {
        state.displayed[row] = state.displayed[row + 1]?.slice() ?? [];
      }
      state.displayed[base] = Array.from({ length: COLS }, () => null);
      state.cursorCol = 0;
    } else if (state.cursorRow + 1 < ROWS) {
      state.cursorRow += 1;
      state.cursorCol = 0;
    }
  }

  private midRow(state: ChannelState, byte: number): void {
    const index = byte - 0x20;
    const underline = (index & 1) !== 0;
    const colorIndex = index >> 1;
    state.pen =
      colorIndex <= 6
        ? { color: colorFromIndex(colorIndex), italics: false, underline }
        : { color: 'white', italics: true, underline };
    // A mid-row code occupies one character cell.
    this.putChar(state, ' ');
  }

  private pac(state: ChannelState, firstByte: number, second: number): void {
    const folded = firstByte >= 0x18 ? firstByte - 0x08 : firstByte;
    const pair = rowPairFor(folded);
    const secondOfPair = second >= 0x60;
    const row =
      folded === 0x10
        ? 11
        : Math.max(1, Math.min(ROWS, pair + (secondOfPair ? 1 : 0)));
    const attr = second & 0x1f;
    const underline = (attr & 1) !== 0;
    let color: Atsc608Color = 'white';
    let italics = false;
    let indent = 0;
    if (attr >= 0x10) {
      indent = ((attr - 0x10) >> 1) * 4;
    } else {
      const colorIndex = attr >> 1;
      if (colorIndex <= 6) {
        color = colorFromIndex(colorIndex);
      } else {
        color = 'white';
        italics = true;
      }
    }
    state.cursorRow = row - 1;
    state.cursorCol = Math.max(0, Math.min(COLS - 1, indent));
    state.pen = { color, italics, underline };
  }

  /** One snapshot per channel, so CC1–CC4 can be reported separately. */
  snapshots(): Atsc608Snapshot[] {
    return this.channels.map((state, index) => ({
      channel: (index + 1) as 1 | 2 | 3 | 4,
      mode: state.mode,
      rows: cloneRows(state.displayed),
      text: screenText(state.displayed),
    }));
  }

  snapshot(): Atsc608Snapshot | undefined {
    let best: { channel: 1 | 2 | 3 | 4; state: ChannelState; text: string } | undefined;
    for (let index = 0; index < this.channels.length; index += 1) {
      const state = this.channels[index] as ChannelState;
      const text = screenText(state.displayed);
      if (text.length === 0) continue;
      if (!best || text.length > best.text.length) {
        best = {
          channel: (index + 1) as 1 | 2 | 3 | 4,
          state,
          text,
        };
      }
    }
    if (!best) {
      // Keep an empty snapshot for pop-on screens that were just cleared.
      const state = this.channels[0] as ChannelState;
      return {
        channel: 1,
        mode: state.mode,
        rows: cloneRows(state.displayed),
        text: '',
      };
    }
    return {
      channel: best.channel,
      mode: best.state.mode,
      rows: cloneRows(best.state.displayed),
      text: best.text,
    };
  }
}

export function screenText(rows: Atsc608Row[]): string {
  return rows
    .map((row) => row.map((cell) => cell?.char ?? ' ').join('').replace(/\s+$/g, ''))
    .filter((line) => line.length > 0)
    .join('\n');
}
