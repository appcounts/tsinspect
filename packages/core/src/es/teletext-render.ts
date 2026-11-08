import type { TeletextPage, TeletextTriplet } from './teletext.js';
import { teletextCharacter } from './teletext.js';
import { iso6937G2 } from '../descriptors/descriptor.js';

/** One 40-column Teletext character cell with the attributes active at that position. */
export interface TeletextCell {
  char: string;
  /** Foreground colour index 0-7 (black, red, green, yellow, blue, magenta, cyan, white). */
  fg: number;
  /** Background colour index 0-7, or -1 for the default transparent background. */
  bg: number;
  /** Cell occupies two text rows. */
  doubleHeight?: boolean;
  /** Cell is a 2x3 mosaic block instead of a character. */
  mosaic?: boolean;
  /** Six mosaic bits, most significant bit first. */
  mosaicBits?: number;
  /** Concealed cells keep their background but hide the character/mosaic. */
  conceal?: boolean;
  /** Cell is inside a Teletext box (start box / end box). */
  boxed?: boolean;
}

export interface TeletextLine {
  /** Logical row 0-24. */
  row: number;
  cells: TeletextCell[];
}

export interface TeletextLayer {
  kind: 'teletext';
  columns: number;
  rows: number;
  lines: TeletextLine[];
}

const COLUMNS = 40;
const ROWS = 25;

/**
 * Decode one 40-byte Teletext row into display cells.
 *
 * Handles the Level 1 spacing attributes (alpha/mosaic colours, background,
 * double height, conceal and box) and mosaic pixel codes. Flash is decoded as
 * a static frame because the preview is time-driven by the WebUI timeline.
 */
function decodeRow(raw: Uint8Array, subset: number): TeletextCell[] {
  let fg = 7;
  let bg = -1;
  let doubleHeight = false;
  let mosaic = false;
  let conceal = false;
  let boxed = false;
  const cells: TeletextCell[] = [];

  const push = (char: string): void => {
    cells.push({
      char,
      fg,
      bg,
      ...(doubleHeight ? { doubleHeight: true } : {}),
      ...(conceal ? { conceal: true } : {}),
      ...(boxed ? { boxed: true } : {}),
    });
  };
  const pushBlank = (): void => push(' ');

  for (let i = 0; i < raw.length && cells.length < COLUMNS; i += 1) {
    const value = raw[i] as number;
    const code = value & 0x7f;

    if (code <= 0x07) {
      fg = code;
      mosaic = false;
      pushBlank();
    } else if (code === 0x08 || code === 0x09) {
      // Flash / steady; static preview.
      pushBlank();
    } else if (code === 0x0a) {
      boxed = false;
      pushBlank();
    } else if (code === 0x0b) {
      boxed = true;
      pushBlank();
    } else if (code === 0x0c) {
      doubleHeight = false;
      pushBlank();
    } else if (code === 0x0d) {
      doubleHeight = true;
      pushBlank();
    } else if (code >= 0x10 && code <= 0x17) {
      fg = code - 0x10;
      mosaic = true;
      pushBlank();
    } else if (code === 0x18) {
      conceal = true;
      pushBlank();
    } else if (code === 0x19 || code === 0x1a) {
      // Contiguous / separated mosaics; keep the current mode.
      pushBlank();
    } else if (code === 0x1b) {
      // Escape selects one character from the G2 supplementary set.
      const next = raw[i + 1] ?? 0x20;
      i += 1;
      push(iso6937G2(next & 0x7f) ?? ' ');
    } else if (code === 0x1c) {
      bg = 0;
      pushBlank();
    } else if (code === 0x1d) {
      bg = fg;
      pushBlank();
    } else if (code === 0x1e) {
      mosaic = true;
      pushBlank();
    } else if (code === 0x1f) {
      mosaic = false;
      pushBlank();
    } else if (code >= 0x20) {
      if (mosaic) {
        cells.push({
          char: ' ',
          fg,
          bg,
          mosaic: true,
          mosaicBits: code & 0x3f,
          ...(doubleHeight ? { doubleHeight: true } : {}),
          ...(conceal ? { conceal: true } : {}),
          ...(boxed ? { boxed: true } : {}),
        });
      } else {
        push(teletextCharacter(value, subset));
      }
    } else {
      pushBlank();
    }
  }

  while (cells.length < COLUMNS) pushBlank();
  return cells;
}

/** Apply X/26 Level 1.5/2.5 triplets to the decoded cells. */
function applyTriplets(cells: TeletextCell[], triplets: TeletextTriplet[]): void {
  for (const triplet of triplets) {
    if (triplet.address >= 40) continue;
    const cell = cells[triplet.address];
    if (!cell) continue;
    const value = triplet.data;
    switch (triplet.mode) {
      case 0x00:
        cell.fg = value & 0x07;
        break;
      case 0x01:
      case 0x02:
        cell.mosaic = true;
        cell.mosaicBits = value & 0x3f;
        cell.char = ' ';
        break;
      case 0x04:
        cell.bg = value & 0x07;
        break;
      case 0x05:
        cell.fg = value & 0x07;
        cell.bg = (value >> 3) & 0x07;
        break;
      case 0x06:
        cell.conceal = true;
        break;
      case 0x07:
        cell.boxed = true;
        break;
      default:
        break;
    }
  }
}

/** Apply row-level X/26 triplets (address 40-63) to whole lines. */
function applyRowTriplets(
  lines: TeletextLine[],
  triplets: TeletextTriplet[],
  fallbackRow: number,
): void {
  for (const triplet of triplets) {
    if (triplet.address < 40) continue;
    const row = triplet.address - 40;
    const line =
      lines.find((item) => item.row === row) ??
      (row === fallbackRow ? lines.find((item) => item.row === fallbackRow) : undefined);
    if (!line) continue;
    for (const cell of line.cells) {
      if (triplet.mode === 0x01) cell.fg = triplet.data & 0x07;
      else if (triplet.mode === 0x04) cell.bg = triplet.data & 0x07;
    }
  }
}

/** Build a drawable Teletext layer from one collected page. */
export function buildTeletextLayer(page: TeletextPage): TeletextLayer {
  const lines: TeletextLine[] = [];
  const skipHeader = page.subtitle || page.control?.suppressHeader === true;

  for (let index = 0; index < page.rowData.length; index += 1) {
    const raw = page.rowData[index];
    if (!raw) continue;
    const row = page.rowNumbers[index] ?? index;
    if (row < 0 || row >= ROWS) continue;
    if (skipHeader && row === 0) continue;
    const cells = decodeRow(raw, page.subset);
    const visible = cells.some(
      (cell) =>
        cell.char !== ' ' || cell.mosaic === true || cell.boxed === true || cell.bg >= 0,
    );
    if (visible) lines.push({ row, cells });
  }

  for (const enhancement of page.enhancements ?? []) {
    const row = enhancement.designation + 1;
    const line = lines.find((item) => item.row === row);
    if (line) applyTriplets(line.cells, enhancement.triplets);
    applyRowTriplets(lines, enhancement.triplets, row);
  }

  return { kind: 'teletext', columns: COLUMNS, rows: ROWS, lines };
}
