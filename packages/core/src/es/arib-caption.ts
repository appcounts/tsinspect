import { decodeAribString, type AribProfile } from '../descriptors/arib-string.js';

/**
 * Best-effort ARIB caption decoder for the statement body
 * (ARIB STD-B24 volume 1, part 3, independent PES transmission).
 *
 * The PES carries a data group whose data-unit loop contains one or more
 * data units. A data unit with parameter 0x20 is the caption statement body:
 * an 8-bit character stream with C0/C1/CSI controls. This module reads the
 * character stream, keeps the style state and returns positioned text runs.
 *
 * The renderer is intentionally conservative: colours, sizes, underline,
 * ornament, bold/italic and CSI positions are decoded. DRCS glyphs are not
 * rasterised, and unsupported controls are skipped without failing the cue.
 */

export interface AribCaptionText {
  text: string;
  /** Byte offset of the first statement byte inside the PES payload. */
  offset: number;
}

export type AribTextSize = 'small' | 'medium' | 'normal' | 'custom';

export interface AribTextStyle {
  /** Foreground colour as CSS hex, only when it differs from white. */
  color?: string;
  /** Background colour as CSS hex, only when explicitly set. */
  background?: string;
  /** Character size mode. */
  size?: AribTextSize;
  /** Horizontal scale for medium/custom sizes (1 = normal). */
  widthScale?: number;
  /** Vertical scale for small/custom sizes (1 = normal). */
  heightScale?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  conceal?: boolean;
  flash?: boolean;
  ornament?: 'none' | 'outline' | 'shadow' | 'hollow';
  ornamentColor?: string;
}

export interface AribTextRun {
  text: string;
  style: AribTextStyle;
  /** Absolute x position in display pixels, when ACPS set one. */
  x?: number;
  /** Absolute y position (character bottom) in display pixels. */
  y?: number;
}

export interface AribTextLine {
  runs: AribTextRun[];
  /** Absolute x position in display pixels, when ACPS set one. */
  x?: number;
  /** Absolute y position (character bottom) in display pixels. */
  y?: number;
  /** Cell row when APS set one (0-based). */
  row?: number;
  /** Cell column when APS set one (0-based). */
  column?: number;
}

export interface AribCaptionDisplay {
  /** Display region left edge in logical pixels (CSI SDP). */
  x?: number;
  /** Display region top edge in logical pixels (CSI SDP). */
  y?: number;
  /** Display region width in logical pixels (CSI SDF). */
  width?: number;
  /** Display region height in logical pixels (CSI SDF). */
  height?: number;
  /** CSI SWF display format (0 = 4:3, 1 = 16:9). */
  format?: number;
}

/** Broadcast font metrics from ARIB STD-B24 A/C profiles. */
export interface AribFontMetrics {
  profile: 'A' | 'C';
  /** Logical plane the metrics belong to. */
  planeWidth: number;
  planeHeight: number;
  /** Default caption display area inside the logical plane. */
  display: { x: number; y: number; width: number; height: number };
  fontWidth: number;
  fontHeight: number;
  horizontalSpacing: number;
  verticalSpacing: number;
  /** Full character cell width/height (font + spacing). */
  charWidth: number;
  charHeight: number;
}

/** A DRCS bitmap glyph decoded from a data unit with parameter 0x30/0x31. */
export interface AribDrcsGlyph {
  /** Private-use character used to reference this glyph in text runs. */
  char: string;
  /** DRCS set: 0 for DRCS-0, 1..15 for DRCS-1..15. */
  set: number;
  /** Character code (low byte for 1-byte sets, 16-bit for DRCS-0). */
  code: number;
  width: number;
  height: number;
  /** Encoded depth (0 = 2 levels / 1 bit per pixel). */
  depth: number;
  /** Row-major alpha mask, 0 = transparent, 255 = opaque. */
  pixels: Uint8Array;
}

/** Persistent DRCS definitions shared by successive caption PES packets. */
export interface AribDrcsContext {
  /** Glyphs keyed by their private-use character. */
  glyphs: Map<string, AribDrcsGlyph>;
  /** Glyphs keyed by their low-byte code for C-profile text references. */
  byCode: Map<number, AribDrcsGlyph>;
}

export interface AribCaptionOptions {
  /** Force A (full service) or C (1-seg/mobile) profile metrics. */
  fontProfile?: 'A' | 'C';
  /** Video width used to infer the profile when fontProfile is omitted. */
  displayWidth?: number;
  displayHeight?: number;
  /** Persistent DRCS definitions; omit for a one-shot decode. */
  drcs?: AribDrcsContext;
}

export interface AribStyledCaption {
  text: string;
  lines: AribTextLine[];
  display?: AribCaptionDisplay;
  /** True when at least one run differs from the default white/normal style. */
  styled: boolean;
  /** Byte offset of the first statement byte inside the PES payload. */
  offset: number;
  /** DRCS glyphs referenced by this caption. */
  drcs?: AribDrcsGlyph[];
  /** Broadcast font metrics used for layout. */
  metrics: AribFontMetrics;
}

const FONT_METRICS_A: AribFontMetrics = {
  profile: 'A',
  planeWidth: 960,
  planeHeight: 540,
  display: { x: 170, y: 30, width: 620, height: 480 },
  fontWidth: 36,
  fontHeight: 36,
  horizontalSpacing: 4,
  verticalSpacing: 24,
  charWidth: 40,
  charHeight: 60,
};

const FONT_METRICS_C: AribFontMetrics = {
  profile: 'C',
  planeWidth: 320,
  planeHeight: 180,
  display: { x: 0, y: 0, width: 300, height: 160 },
  fontWidth: 18,
  fontHeight: 18,
  horizontalSpacing: 2,
  verticalSpacing: 12,
  charWidth: 20,
  charHeight: 30,
};

/** Create an empty persistent DRCS context. */
export function createAribDrcsContext(): AribDrcsContext {
  return { glyphs: new Map(), byCode: new Map() };
}

function selectFontMetrics(options: AribCaptionOptions): AribFontMetrics {
  if (options.fontProfile === 'A') return FONT_METRICS_A;
  if (options.fontProfile === 'C') return FONT_METRICS_C;
  const width = options.displayWidth ?? 0;
  const height = options.displayHeight ?? 0;
  return width > 0 && width <= 320 && height > 0 && height <= 180
    ? FONT_METRICS_C
    : FONT_METRICS_A;
}

const US = 0x1f;

const COLOR_HEX = [
  '#000000',
  '#ff0000',
  '#00ff00',
  '#ffff00',
  '#0000ff',
  '#ff00ff',
  '#00ffff',
  '#ffffff',
];

interface MutableStyle {
  color: string;
  background?: string;
  size: AribTextSize;
  widthScale: number;
  heightScale: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  conceal: boolean;
  flash: boolean;
  ornament: 'none' | 'outline' | 'shadow' | 'hollow';
  ornamentColor?: string;
}

interface MutableRun {
  text: string;
  style: MutableStyle;
  x?: number;
  y?: number;
}

interface MutableLine {
  runs: MutableRun[];
  x?: number;
  y?: number;
  row?: number;
  column?: number;
}

interface CaptionState {
  style: MutableStyle;
  lines: MutableLine[];
  line: MutableLine;
  run: MutableRun | null;
  display: AribCaptionDisplay;
  /** Current ACPS position in logical pixels. */
  x?: number;
  y?: number;
  /** Current character cell metrics (SSM/SHS/SVS). */
  charWidth?: number;
  charHeight?: number;
  charGapX?: number;
  charGapY?: number;
  styled: boolean;
  /** DRCS glyphs referenced by the decoded text. */
  usedDrcs: Map<string, AribDrcsGlyph>;
  /** CS was seen; discard the previous screen when new text arrives. */
  pendingClear: boolean;
}

function readU24(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] ?? 0) << 16) |
    ((data[offset + 1] ?? 0) << 8) |
    (data[offset + 2] ?? 0)
  );
}

function defaultStyle(): MutableStyle {
  return {
    color: '#ffffff',
    size: 'normal',
    widthScale: 1,
    heightScale: 1,
    bold: false,
    italic: false,
    underline: false,
    conceal: false,
    flash: false,
    ornament: 'none',
  };
}

function freshState(metrics: AribFontMetrics): CaptionState {
  const line: MutableLine = { runs: [] };
  return {
    style: defaultStyle(),
    lines: [],
    line,
    run: null,
    display: {},
    styled: false,
    usedDrcs: new Map(),
    pendingClear: false,
    charWidth: metrics.charWidth,
    charHeight: metrics.charHeight,
  };
}

function resetStyle(style: MutableStyle): void {
  const next = defaultStyle();
  style.color = next.color;
  style.background = next.background;
  style.size = next.size;
  style.widthScale = next.widthScale;
  style.heightScale = next.heightScale;
  style.bold = next.bold;
  style.italic = next.italic;
  style.underline = next.underline;
  style.conceal = next.conceal;
  style.flash = next.flash;
  style.ornament = next.ornament;
  style.ornamentColor = next.ornamentColor;
}

function paletteColor(index: number): string {
  return COLOR_HEX[index & 0x07] ?? '#ffffff';
}

function styleKey(style: MutableStyle, x?: number, y?: number): string {
  return [
    style.color,
    style.background ?? '',
    style.size,
    style.widthScale,
    style.heightScale,
    style.bold ? 1 : 0,
    style.italic ? 1 : 0,
    style.underline ? 1 : 0,
    style.conceal ? 1 : 0,
    style.flash ? 1 : 0,
    style.ornament,
    style.ornamentColor ?? '',
    x ?? '',
    y ?? '',
  ].join('|');
}

function flushRun(state: CaptionState): void {
  if (!state.run) return;
  if (state.run.text.length === 0) {
    state.run = null;
    return;
  }
  state.line.runs.push(state.run);
  state.run = null;
}

function startRun(state: CaptionState): MutableRun {
  flushRun(state);
  const run: MutableRun = {
    text: '',
    style: { ...state.style },
    ...(state.x !== undefined ? { x: state.x } : {}),
    ...(state.y !== undefined ? { y: state.y } : {}),
  };
  state.run = run;
  return run;
}

function appendText(state: CaptionState, text: string): void {
  if (text.length === 0) return;
  if (state.pendingClear) {
    // CS followed by new text means a new screen; a trailing CS (no further
    // text) keeps the screen that was just decoded. Preserve any position
    // (APS/ACPS) that was set between CS and the first character.
    state.lines = [];
    state.line = { ...state.line, runs: [] };
    state.run = null;
    state.pendingClear = false;
  }
  if (
    state.run &&
    styleKey(state.run.style, state.run.x, state.run.y) !==
      styleKey(state.style, state.x, state.y)
  ) {
    flushRun(state);
  }
  const run = state.run ?? startRun(state);
  run.text += text;
}

function flushLine(state: CaptionState): void {
  flushRun(state);
  const hasText = state.line.runs.some((run) => run.text.length > 0);
  if (hasText) {
    state.lines.push(state.line);
  }
  state.line = { runs: [] };
}

function newLine(state: CaptionState, x?: number, y?: number): void {
  flushLine(state);
  if (x !== undefined) state.line.x = x;
  if (y !== undefined) state.line.y = y;
}

function plainText(value: string): string {
  // DRCS runs reference private-use characters; keep a visible geta mark in
  // plain-text exports instead of an unresolved PUA code point.
  return value.replace(/[\ue000-\uf8ff]/g, '\u3013');
}

function finishCaption(
  state: CaptionState,
  offset: number,
  metrics: AribFontMetrics,
): AribStyledCaption {
  flushLine(state);
  const lines = state.lines
    .map((line) => ({
      ...line,
      runs: line.runs
        .map((run) => ({
          ...run,
          text: run.text.replace(/[ \t]+$/g, ''),
        }))
        .filter((run) => run.text.length > 0),
    }))
    .filter((line) => line.runs.length > 0);

  const text = lines
    .map((line) => plainText(line.runs.map((run) => run.text).join('')))
    .filter((value) => value.length > 0)
    .join('\n');

  const publicLines: AribTextLine[] = lines.map((line) => ({
    ...(line.x !== undefined ? { x: line.x } : {}),
    ...(line.y !== undefined ? { y: line.y } : {}),
    ...(line.row !== undefined ? { row: line.row } : {}),
    ...(line.column !== undefined ? { column: line.column } : {}),
    runs: line.runs.map((run) => {
      const style: AribTextStyle = {};
      if (run.style.color !== '#ffffff') style.color = run.style.color;
      if (run.style.background) style.background = run.style.background;
      if (run.style.size !== 'normal') style.size = run.style.size;
      if (run.style.widthScale !== 1) style.widthScale = run.style.widthScale;
      if (run.style.heightScale !== 1) style.heightScale = run.style.heightScale;
      if (run.style.bold) style.bold = true;
      if (run.style.italic) style.italic = true;
      if (run.style.underline) style.underline = true;
      if (run.style.conceal) style.conceal = true;
      if (run.style.flash) style.flash = true;
      if (run.style.ornament !== 'none') style.ornament = run.style.ornament;
      if (run.style.ornamentColor) style.ornamentColor = run.style.ornamentColor;
      return {
        text: run.text,
        style,
        ...(run.x !== undefined ? { x: run.x } : {}),
        ...(run.y !== undefined ? { y: run.y } : {}),
      };
    }),
  }));

  const trimmedDisplay = Object.fromEntries(
    Object.entries(state.display).filter(([, value]) => value !== undefined),
  ) as AribCaptionDisplay;

  return {
    text,
    lines: publicLines,
    ...(Object.keys(trimmedDisplay).length > 0 ? { display: trimmedDisplay } : {}),
    styled: state.styled,
    offset,
    ...(state.usedDrcs.size > 0 ? { drcs: [...state.usedDrcs.values()] } : {}),
    metrics,
  };
}

function isEncodingControl(value: number): boolean {
  // ESC, LS0, LS1, SS2 and SS3 belong to the text encoding, not to caption
  // layout, so they stay inside the text span for decodeAribString.
  return value === 0x1b || value === 0x0f || value === 0x0e || value === 0x19 || value === 0x1d;
}

function controlParameters(
  value: number,
  data: Uint8Array,
  cursor: number,
): { params: number[]; next: number } {
  let next = cursor + 1;
  const params: number[] = [];
  if (value === 0x16) {
    // PAPF: one-byte forward distance.
    if (next < data.length) params.push(data[next++] as number);
  } else if (value === 0x1c) {
    // APS: row and column offsets from 0x40.
    for (let i = 0; i < 2 && next < data.length; i += 1) params.push(data[next++] as number);
  } else if (value === 0x8b) {
    // SZX: one-byte size selector.
    if (next < data.length) params.push(data[next++] as number);
  } else if (value === 0x90) {
    // COL: 0x20 palette selector has a second byte.
    if (next < data.length) {
      const first = data[next++] as number;
      params.push(first);
      if (first === 0x20 && next < data.length) params.push(data[next++] as number);
    }
  } else if (
    value === 0x91 ||
    value === 0x92 ||
    value === 0x93 ||
    value === 0x94 ||
    value === 0x97 ||
    value === 0x98
  ) {
    if (next < data.length) params.push(data[next++] as number);
  } else if (value === 0x95) {
    // MACRO: skip to the MACRO 0x4F terminator.
    while (next + 1 < data.length) {
      if (data[next] === 0x95 && data[next + 1] === 0x4f) {
        next += 2;
        break;
      }
      next += 1;
    }
  } else if (value === 0x9d) {
    // TIME: 0x20 introduces the delay in 100 ms units; otherwise skip to 0x40-0x43.
    if (next < data.length) {
      if (data[next] === 0x20) {
        params.push(0x20);
        next += 1;
        if (next < data.length) params.push(data[next++] as number);
      } else {
        while (next < data.length) {
          const candidate = data[next] as number;
          if (candidate >= 0x40 && candidate <= 0x43) break;
          next += 1;
        }
        if (next < data.length) params.push(data[next++] as number);
      }
    }
  }
  return { params, next };
}

interface CsiToken {
  params: number[];
  final: number;
  next: number;
}

function parseCsi(data: Uint8Array, start: number): CsiToken | null {
  let cursor = start;
  let value = 0;
  let haveValue = false;
  const params: number[] = [];
  while (cursor < data.length) {
    const byte = data[cursor] as number;
    if (byte >= 0x30 && byte <= 0x39) {
      value = value * 10 + (byte - 0x30);
      haveValue = true;
      cursor += 1;
      continue;
    }
    if (byte === 0x3b) {
      params.push(haveValue ? value : 0);
      value = 0;
      haveValue = false;
      cursor += 1;
      continue;
    }
    if (byte === 0x3a) {
      // Sub-parameter separator: keep the flat numeric list.
      params.push(haveValue ? value : 0);
      value = 0;
      haveValue = false;
      cursor += 1;
      continue;
    }
    if (byte >= 0x20 && byte <= 0x2f) {
      // Intermediate byte; the value is not used for caption layout.
      cursor += 1;
      continue;
    }
    if (byte >= 0x40 && byte <= 0x7e) {
      if (haveValue || params.length > 0) params.push(haveValue ? value : 0);
      return { params, final: byte, next: cursor + 1 };
    }
    // Malformed CSI: stop at the offending byte.
    return { params, final: 0, next: cursor };
  }
  return null;
}

function applyColor(state: CaptionState, params: number[]): void {
  const first = params[0];
  if (first === undefined) return;
  if (first === 0x20) {
    // Palette selection. The renderer uses the standard 8-colour default map.
    state.styled = true;
    return;
  }
  const kind = first & 0xf0;
  const index = first & 0x0f;
  if (kind === 0x40) {
    state.style.color = paletteColor(index);
    state.styled = true;
  } else if (kind === 0x50) {
    state.style.background = paletteColor(index);
    state.styled = true;
  }
}

function applySize(state: CaptionState, mode: AribTextSize, widthScale: number, heightScale: number): void {
  state.style.size = mode;
  state.style.widthScale = widthScale;
  state.style.heightScale = heightScale;
  if (mode !== 'normal') state.styled = true;
}

function applySzx(state: CaptionState, code: number | undefined): void {
  switch (code) {
    case 0x60: // micro
      applySize(state, 'custom', 0.5, 0.5);
      break;
    case 0x41: // high wide
      applySize(state, 'custom', 1, 2);
      break;
    case 0x44: // width wide
      applySize(state, 'custom', 2, 1);
      break;
    case 0x45: // wide
      applySize(state, 'custom', 2, 2);
      break;
    case 0x6b: // half-width normal height
      applySize(state, 'custom', 0.5, 1);
      break;
    case 0x64: // normal width half-height
      applySize(state, 'custom', 1, 0.5);
      break;
    default:
      break;
  }
}

function applyCsi(state: CaptionState, params: number[], final: number): void {
  switch (final) {
    case 0x53: // SWF
      if (params[0] !== undefined) {
        state.display.format = params[0];
        state.styled = true;
      }
      break;
    case 0x6e: // RCS raster colour
      if (params[0] !== undefined) {
        state.style.background = paletteColor(params[0]);
        state.styled = true;
      }
      break;
    case 0x61: {
      // ACPS: x, y in logical pixels.
      const x = params[0];
      const y = params[1];
      if (x !== undefined && y !== undefined) {
        state.x = x;
        state.y = y;
        newLine(state, x, y);
        state.styled = true;
      }
      break;
    }
    case 0x56: // SDF display size
      if (params[0] !== undefined) state.display.width = params[0];
      if (params[1] !== undefined) state.display.height = params[1];
      state.styled = true;
      break;
    case 0x5f: // SDP display position
      if (params[0] !== undefined) state.display.x = params[0];
      if (params[1] !== undefined) state.display.y = params[1];
      state.styled = true;
      break;
    case 0x57: // SSM character cell size
      if (params[0] !== undefined) state.charWidth = params[0];
      if (params[1] !== undefined) state.charHeight = params[1];
      break;
    case 0x58: // SHS horizontal interval
      if (params[0] !== undefined) state.charGapX = params[0];
      break;
    case 0x59: // SVS vertical interval
      if (params[0] !== undefined) state.charGapY = params[0];
      break;
    case 0x63: {
      // ORN ornament: 0 none, 1 outline, 2 shadow, 3 hollow.
      const kind = params[0];
      if (kind !== undefined && kind <= 3) {
        state.style.ornament = (['none', 'outline', 'shadow', 'hollow'] as const)[kind] ?? 'none';
        const color = params[1];
        if (color !== undefined && (kind === 1 || kind === 2)) {
          const index = ((Math.floor(color / 100) << 4) | (color % 100)) & 0x7f;
          state.style.ornamentColor = paletteColor(index);
        }
        if (kind !== 0) state.styled = true;
      }
      break;
    }
    case 0x64: {
      // MDF font style: bit 0 bold, bit 1 italic.
      const mode = params[0] ?? 0;
      state.style.bold = (mode & 1) !== 0;
      state.style.italic = (mode & 2) !== 0;
      if (state.style.bold || state.style.italic) state.styled = true;
      break;
    }
    default:
      break;
  }
}

function applyControl(state: CaptionState, code: number, params: number[]): void {
  switch (code) {
    case 0x0c: // CS clear screen
      // A statement may end with TIME + CS: the text before CS is the visible
      // screen, while CS prepares the next one. Keep what was just decoded
      // unless new text arrives afterwards.
      flushLine(state);
      state.line = { runs: [] };
      state.x = undefined;
      state.y = undefined;
      state.pendingClear = true;
      resetStyle(state.style);
      break;
    case 0x0d: // APR newline
    case 0x0a: // APD next line
      newLine(state);
      break;
    case 0x0b: // APU previous line
      newLine(state);
      break;
    case 0x08: {
      // APB backspace: remove the last character of the current run.
      if (!state.run) startRun(state);
      if (state.run && state.run.text.length > 0) {
        state.run.text = state.run.text.slice(0, -1);
      }
      break;
    }
    case 0x09:
      appendText(state, ' ');
      break;
    case 0x16:
      // PAPF forward. One cell per parameter step (best effort).
      if (state.run) {
        const steps = params[0] ?? 1;
        state.run.text += ' '.repeat(Math.max(1, steps));
      }
      break;
    case 0x1c: {
      // APS cell position: row/column are offset by 0x40.
      const row = params[0];
      const column = params[1];
      if (row !== undefined && column !== undefined) {
        newLine(state);
        state.line.row = Math.max(0, row - 0x40);
        state.line.column = Math.max(0, column - 0x40);
        // APS uses character-cell coordinates. When SSM supplied the cell
        // metrics, convert them to logical pixels for the renderer.
        if (state.charWidth !== undefined) {
          state.line.x = state.charWidth * state.line.column;
        }
        if (state.charHeight !== undefined) {
          state.line.y = state.charHeight * (state.line.row + 1);
        }
        state.styled = true;
      }
      break;
    }
    case 0x80:
    case 0x81:
    case 0x82:
    case 0x83:
    case 0x84:
    case 0x85:
    case 0x86:
    case 0x87:
      state.style.color = COLOR_HEX[code - 0x80] ?? '#ffffff';
      state.styled = true;
      break;
    case 0x88:
      applySize(state, 'small', 0.5, 0.5);
      break;
    case 0x89:
      applySize(state, 'medium', 0.5, 1);
      break;
    case 0x8a:
      applySize(state, 'normal', 1, 1);
      break;
    case 0x8b:
      applySzx(state, params[0]);
      break;
    case 0x90:
      applyColor(state, params);
      break;
    case 0x91: // FLC
      state.style.flash = params[0] !== 0x4f;
      if (state.style.flash) state.styled = true;
      break;
    case 0x92: // CDC conceal
      state.style.conceal = params[0] !== 0x4f;
      if (state.style.conceal) state.styled = true;
      break;
    case 0x99: // SPL underline off
      state.style.underline = false;
      break;
    case 0x9a: // STL underline on
      state.style.underline = true;
      state.styled = true;
      break;
    default:
      break;
  }
}

function decodeEucJp(bytes: number[]): string {
  try {
    return new TextDecoder('euc-jp').decode(Uint8Array.from(bytes));
  } catch {
    return bytes
      .map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.'))
      .join('');
  }
}

/** Private-use character for a DRCS glyph (stable per set/code). */
function drcsCharacter(set: number, characterCode: number): string {
  if (set >= 1 && set <= 15) {
    const code = characterCode & 0x7f;
    if (code < 0x21 || code > 0x7e) return '';
    return String.fromCodePoint(0xe000 + (set - 1) * 94 + (code - 0x21));
  }
  const first = (characterCode >> 8) & 0x7f;
  const second = characterCode & 0x7f;
  if (first < 0x21 || first > 0x7e || second < 0x21 || second > 0x7e) return '';
  return String.fromCodePoint(0xe600 + (first - 0x21) * 94 + (second - 0x21));
}

function decodeDrcsGlyph(
  characterCode: number,
  width: number,
  height: number,
  depth: number,
  bitsPerPixel: number,
  rowBytes: number,
  data: Uint8Array,
): AribDrcsGlyph | null {
  if (width <= 0 || height <= 0 || width > 512 || height > 512) return null;
  const first = (characterCode >> 8) & 0xff;
  const set = first >= 0x41 && first <= 0x4f ? first - 0x40 : 0;
  const char = drcsCharacter(set, characterCode);
  if (!char) return null;

  const levels = (1 << bitsPerPixel) - 1;
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const bitIndex = x * bitsPerPixel;
      const byteIndex = y * rowBytes + (bitIndex >> 3);
      const bitOffset = bitIndex & 7;
      let value = 0;
      for (let bit = 0; bit < bitsPerPixel; bit += 1) {
        const absolute = byteIndex + ((bitOffset + bit) >> 3);
        const shift = 7 - ((bitOffset + bit) & 7);
        value = (value << 1) | (((data[absolute] ?? 0) >> shift) & 1);
      }
      pixels[y * width + x] = value === 0 ? 0 : Math.round((value / levels) * 255);
    }
  }

  return {
    char,
    set,
    code: set >= 1 ? characterCode & 0xff : characterCode,
    width,
    height,
    depth,
    pixels,
  };
}

/** Parse a DRCS data unit (parameter 0x30/0x31) into a persistent context. */
function parseDrcsDataUnit(data: Uint8Array, context: AribDrcsContext): void {
  if (data.length < 1) return;
  const numberOfCode = data[0] as number;
  let cursor = 1;
  for (let codeIndex = 0; codeIndex < numberOfCode; codeIndex += 1) {
    if (cursor + 3 > data.length) break;
    const characterCode = ((data[cursor] as number) << 8) | (data[cursor + 1] as number);
    const numberOfFont = data[cursor + 2] as number;
    cursor += 3;
    for (let fontIndex = 0; fontIndex < numberOfFont; fontIndex += 1) {
      if (cursor >= data.length) break;
      const modeByte = data[cursor] as number;
      const mode = modeByte & 0x0f;
      cursor += 1;
      if (mode === 0 || mode === 1) {
        if (cursor + 3 > data.length) break;
        const depth = data[cursor] as number;
        const width = data[cursor + 1] as number;
        const height = data[cursor + 2] as number;
        cursor += 3;
        const bitsPerPixel = Math.min(8, Math.max(1, depth + 1));
        const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
        const dataLength = rowBytes * height;
        const pattern = data.subarray(cursor, Math.min(data.length, cursor + dataLength));
        cursor += dataLength;
        const glyph = decodeDrcsGlyph(
          characterCode,
          width,
          height,
          depth,
          bitsPerPixel,
          rowBytes,
          pattern,
        );
        if (glyph) {
          context.glyphs.set(glyph.char, glyph);
          if (glyph.set >= 1) {
            context.byCode.set(glyph.code & 0xff, glyph);
          } else {
            context.byCode.set(glyph.code, glyph);
          }
        }
      } else {
        // Geometric DRCS is not rasterised; skip its payload.
        if (cursor + 3 > data.length) break;
        cursor += 2; // regionX, regionY
        const length = ((data[cursor] as number) << 8) | (data[cursor + 1] as number);
        cursor += 2 + length;
      }
    }
  }
}

function drcsResolver(
  context: AribDrcsContext,
  state: CaptionState,
): (set: number, first: number, second?: number) => string | undefined {
  return (set, first, second) => {
    const characterCode =
      set >= 1
        ? (((0x40 + set) << 8) | (first & 0x7f))
        : (((first & 0x7f) << 8) | ((second ?? 0) & 0x7f));
    const char = drcsCharacter(set, characterCode);
    if (!char) return undefined;
    const glyph = context.glyphs.get(char);
    if (!glyph) return undefined;
    state.usedDrcs.set(glyph.char, glyph);
    return glyph.char;
  };
}

function decodeEucJpSpan(
  bytes: number[],
  context: AribDrcsContext,
  state: CaptionState,
): string {
  let result = '';
  let pending: number[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    result += decodeEucJp(pending);
    pending = [];
  };
  for (const value of bytes) {
    // In C-profile captions, single bytes 0x21-0x2E are DRCS references.
    if (value >= 0x21 && value <= 0x2e) {
      const glyph = context.byCode.get(value);
      if (glyph) {
        flush();
        state.usedDrcs.set(glyph.char, glyph);
        result += glyph.char;
        continue;
      }
    }
    pending.push(value);
  }
  flush();
  return result;
}

function decodeTextSpan(
  bytes: number[],
  mode: 'euc-jp' | 'arib',
  profile: AribProfile,
  context: AribDrcsContext,
  state: CaptionState,
): string {
  if (bytes.length === 0) return '';
  const data = Uint8Array.from(
    bytes.map((value) => (value === 0x7f || value === 0xa0 ? 0x20 : value)),
  );
  if (mode === 'euc-jp') {
    return decodeEucJpSpan(bytes, context, state);
  }
  return decodeAribString(data, {
    profile,
    drcs: drcsResolver(context, state),
  });
}

function detectTextMode(
  body: Uint8Array,
  profile: AribProfile,
  context: AribDrcsContext,
  fontProfile: 'A' | 'C',
): 'euc-jp' | 'arib' {
  if (profile === 'brazil') return 'arib';
  for (const value of body) {
    if (value === 0x1b || value === 0x19 || value === 0x1d) return 'arib';
  }
  for (const value of body) {
    if (value >= 0xa1) return 'euc-jp';
  }
  // In the C profile, single-byte codes 0x21-0x2E are DRCS references. The
  // A profile uses ESC designations for DRCS and keeps GL Kanji text instead.
  if (fontProfile === 'C') {
    for (const value of body) {
      if (value >= 0x21 && value <= 0x2e && context.byCode.has(value)) return 'euc-jp';
    }
  }
  return 'arib';
}

interface CaptionUnits {
  statements: Array<{ body: Uint8Array; offset: number }>;
  drcs: Uint8Array[];
}

/** One entry of the ARIB caption management data language loop. */
export interface AribCaptionLanguage {
  /** Language tag byte from the management data. */
  tag: number;
  /** ISO-639 language code, for example "jpn". */
  code: string;
}

/**
 * Extract the language loop from ARIB caption management data. This data is
 * separate from the statement bodies and describes which languages the
 * caption service carries.
 */
export function parseAribCaptionLanguages(payload: Uint8Array): AribCaptionLanguage[] {
  if (payload.length < 8) return [];
  const dataIdentifier = payload[0] as number;
  if (dataIdentifier !== 0x80 && dataIdentifier !== 0x81) return [];
  const pesHeaderLength = (payload[2] as number) & 0x0f;
  const groupStart = 3 + pesHeaderLength;
  if (groupStart + 6 > payload.length) return [];
  const groupId = ((payload[groupStart] as number) & 0xfc) >> 2;
  if (groupId !== 0x00 && groupId !== 0x20) return [];
  const count = payload[groupStart + 6] as number;
  let cursor = groupStart + 7;
  const languages: AribCaptionLanguage[] = [];
  for (let index = 0; index < count && cursor + 5 <= payload.length; index += 1) {
    const tag = payload[cursor] as number;
    const codeBytes = payload.subarray(cursor + 1, cursor + 4);
    const code = String.fromCharCode(...codeBytes);
    if (/^[A-Za-z]{3}$/.test(code)) languages.push({ tag, code });
    cursor += 5;
  }
  return languages;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Extract the 0x20 statement bodies and 0x30/0x31 DRCS units from a PES. */
function captionDataUnits(payload: Uint8Array): CaptionUnits | null {
  if (payload.length < 8) return null;
  const dataIdentifier = payload[0] as number;
  if (dataIdentifier !== 0x80 && dataIdentifier !== 0x81) return null;

  const pesHeaderLength = (payload[2] as number) & 0x0f;
  const groupStart = 3 + pesHeaderLength;
  if (groupStart + 6 > payload.length) return null;

  const groupId = ((payload[groupStart] as number) & 0xfc) >> 2;
  let loopStart = groupStart + 6;
  if (groupId === 0x00 || groupId === 0x20) {
    // Caption management data starts with a language loop.
    if (loopStart >= payload.length) return null;
    const languages = payload[loopStart] as number;
    loopStart += 1 + languages * 5;
  }
  if (loopStart + 3 > payload.length) return null;

  const loopLength = readU24(payload, loopStart);
  const loopEnd = Math.min(loopStart + 3 + loopLength, payload.length);
  let cursor = loopStart + 3;
  const units: CaptionUnits = { statements: [], drcs: [] };
  while (cursor + 5 <= loopEnd) {
    if (payload[cursor] !== US) break;
    const parameter = payload[cursor + 1] as number;
    const size = readU24(payload, cursor + 2);
    const dataStart = cursor + 5;
    const dataEnd = Math.min(dataStart + size, loopEnd);
    if (dataEnd > dataStart) {
      if (parameter === 0x20) {
        units.statements.push({
          body: payload.subarray(dataStart, dataEnd),
          offset: dataStart,
        });
      } else if (parameter === 0x30 || parameter === 0x31) {
        units.drcs.push(payload.subarray(dataStart, dataEnd));
      }
    }
    if (dataEnd <= dataStart) break;
    cursor = dataEnd;
  }
  return units.statements.length > 0 || units.drcs.length > 0 ? units : null;
}

function decodeCaptionBody(
  body: Uint8Array,
  profile: AribProfile,
  offset: number,
  context: AribDrcsContext,
  metrics: AribFontMetrics,
): AribStyledCaption {
  const mode = detectTextMode(body, profile, context, metrics.profile);
  const state = freshState(metrics);
  let textBytes: number[] = [];

  const flushText = (): void => {
    if (textBytes.length === 0) return;
    const text = decodeTextSpan(textBytes, mode, profile, context, state);
    textBytes = [];
    appendText(state, text);
  };

  let cursor = 0;
  while (cursor < body.length) {
    const value = body[cursor] as number;

    if (isEncodingControl(value)) {
      textBytes.push(value);
      cursor += 1;
      continue;
    }

    if (value === 0x9b) {
      flushText();
      const csi = parseCsi(body, cursor + 1);
      if (!csi) break;
      applyCsi(state, csi.params, csi.final);
      cursor = csi.next;
      continue;
    }

    if (value < 0x20 || (value >= 0x80 && value <= 0x9f)) {
      flushText();
      const { params, next } = controlParameters(value, body, cursor);
      applyControl(state, value, params);
      cursor = next;
      continue;
    }

    textBytes.push(value);
    cursor += 1;
  }
  flushText();

  return finishCaption(state, offset, metrics);
}

/**
 * Read a synchronized PES payload and return the styled caption statement.
 * Returns null when the payload does not contain a 0x20 caption data unit.
 */
export function extractAribCaptionStyled(
  payload: Uint8Array,
  profile: AribProfile = 'japan',
  options: AribCaptionOptions = {},
): AribStyledCaption | null {
  const units = captionDataUnits(payload);
  if (!units) return null;

  const context = options.drcs ?? createAribDrcsContext();
  for (const drcs of units.drcs) parseDrcsDataUnit(drcs, context);
  if (units.statements.length === 0) return null;

  const metrics = selectFontMetrics(options);
  const body = concatBytes(units.statements.map((statement) => statement.body));
  const caption = decodeCaptionBody(
    body,
    profile,
    units.statements[0]?.offset ?? 0,
    context,
    metrics,
  );
  return caption.text.length > 0 ? caption : null;
}

/** Plain-text compatibility wrapper used by the CLI extractor and reports. */
export function extractAribCaptionText(
  payload: Uint8Array,
  profile: AribProfile = 'japan',
  options: AribCaptionOptions = {},
): AribCaptionText | null {
  const caption = extractAribCaptionStyled(payload, profile, options);
  if (!caption) return null;
  return { text: caption.text, offset: caption.offset };
}
