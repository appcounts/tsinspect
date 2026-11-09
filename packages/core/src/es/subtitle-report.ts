/**
 * Subtitle report across services: detects subtitle/caption streams from PMT
 * descriptors, reassembles their PES packets and extracts text where the
 * subtitle format carries text. DVB bitmap subtitles are indexed but not
 * transcribed.
 */

import { resolveAribProfile } from '../descriptors/arib-profile.js';
import type { PacketLayout, ProbeResult, ProbeStream } from '../model/types.js';
import type { PesPacket } from '../pes/assembler.js';
import { collectPesPackets } from '../pes/index.js';
import {
  type AribCaptionDisplay,
  type AribCaptionLanguage,
  type AribCaptionOptions,
  type AribDrcsGlyph,
  type AribFontMetrics,
  type AribTextLine,
  createAribDrcsContext,
  extractAribCaptionStyled,
  parseAribCaptionLanguages,
} from './arib-caption.js';
import { Atsc608Decoder, type Atsc608Snapshot } from './atsc-608.js';
import { Atsc708Decoder, type Atsc708Snapshot } from './atsc-708.js';
import { parseAtscCaptionPayload } from './atsc-captions.js';
import { indexDvbSubtitlePes } from './dvb-subtitle.js';
import { collectDvbSubtitleTimeline } from './dvb-subtitle-render.js';
import {
  parseTeletextPes,
  TeletextCollector,
  type TeletextNavigation,
  type TeletextPage,
  type TeletextPageLink,
} from './teletext.js';
import { buildTeletextLayer, type TeletextLayer } from './teletext-render.js';
import { parseVbiPes } from './vbi.js';

export type SubtitleFormat =
  | 'teletext'
  | 'dvb-subtitle'
  | 'arib-caption'
  | 'atsc-caption'
  | 'vbi-teletext'
  | 'vbi';

export type SubtitleCategory = 'teletext' | 'subtitle' | 'caption' | 'vbi';

const FORMAT_CATEGORY: Record<SubtitleFormat, SubtitleCategory> = {
  teletext: 'teletext',
  'vbi-teletext': 'teletext',
  'dvb-subtitle': 'subtitle',
  'arib-caption': 'subtitle',
  'atsc-caption': 'caption',
  vbi: 'vbi',
};

/** Teletext, subtitles, closed captions and VBI are distinct data families. */
export function subtitleCategory(format: SubtitleFormat): SubtitleCategory {
  return FORMAT_CATEGORY[format];
}

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
  /** Teletext page label, when available. */
  label?: string;
}

export interface SubtitlePreviewFrame {
  start: number;
  end: number;
  label?: string;
  layer: TeletextLayer;
}

/**
 * Subtitle-layer preview data. Only the subtitle layer is carried; it is not
 * composited over video. Width/height use the original display geometry when
 * known (Teletext uses a 4:3 720x576 cell grid).
 */
export interface TeletextPreview {
  kind: 'teletext';
  width: number;
  height: number;
  frames: SubtitlePreviewFrame[];
  truncated: boolean;
}

export interface BitmapPreviewFrame {
  start: number;
  end: number;
  label?: string;
}

/** One browsable Teletext page (subtitle or general content). */
export interface TeletextBrowsePage {
  label: string;
  magazine: number;
  page: number;
  subtitle: boolean;
  text: string;
  layer: TeletextLayer;
  links?: TeletextPageLink[];
  navigation?: TeletextNavigation;
  firstSeen?: number;
  lastSeen?: number;
}

/** Full-page Teletext browser data, independent of the subtitle cue list. */
export interface TeletextBrowse {
  pages: TeletextBrowsePage[];
  total: number;
  truncated: boolean;
  /** Pages carrying Fastext/TOP links. */
  linkCount: number;
}

/**
 * Bitmap preview metadata. Pixel data is rendered on demand by the server so
 * a long DVB bitmap stream does not embed every full-resolution frame in the
 * subtitle report JSON.
 */
export interface BitmapPreview {
  kind: 'bitmap';
  width: number;
  height: number;
  frames: BitmapPreviewFrame[];
  truncated: boolean;
  /** Frame pixels are fetched from /api/sessions/:id/subtitles/frame. */
  onDemand: true;
}

export interface TextPreviewGlyph {
  /** Private-use character referenced from the styled runs. */
  char: string;
  width: number;
  height: number;
  /** Base64-encoded row-major alpha mask. */
  pixels: string;
}

export interface TextPreviewFrame {
  start: number;
  end: number;
  label?: string;
  /** Plain text lines for compact consumers. */
  lines: string[];
  /** Styled runs decoded from ARIB C0/C1/CSI controls. */
  styledLines: AribTextLine[];
  /** DRCS glyphs referenced by this frame. */
  drcs?: TextPreviewGlyph[];
  /** Caption display region when CSI SDP/SDF set one. */
  display?: AribCaptionDisplay;
}

/** Text-layer preview used by formats whose styles are decoded best-effort. */
export interface TextPreview {
  kind: 'text';
  width: number;
  height: number;
  frames: TextPreviewFrame[];
  truncated: boolean;
  format?: SubtitleFormat;
  /** True when at least one frame carries a non-default style. */
  styled?: boolean;
  /** Broadcast font metrics (ARIB A/C profile) used for layout. */
  metrics?: AribFontMetrics;
  /** True when at least one frame references a DRCS glyph. */
  drcs?: boolean;
  note?: string;
}

export interface Atsc608CellPreview {
  char: string;
  color?: string;
  italics?: boolean;
  underline?: boolean;
  background?: string;
}

export interface Atsc608RowPreview {
  row: number;
  cells: Array<Atsc608CellPreview | null>;
}

export interface Atsc608PreviewFrame {
  start: number;
  end: number;
  mode: 'pop-on' | 'roll-up' | 'paint-on' | 'text';
  rows: Atsc608RowPreview[];
}

export interface Atsc608Preview {
  kind: 'atsc608';
  width: number;
  height: number;
  frames: Atsc608PreviewFrame[];
  truncated: boolean;
  channel?: number;
}

export interface Atsc708CellPreview {
  char: string;
  fg?: string;
  bg?: string;
  italics?: boolean;
  underline?: boolean;
}

export interface Atsc708WindowPreview {
  id: number;
  priority: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rowCount: number;
  columnCount: number;
  justify: number;
  fillColor?: string;
  fillOpacity?: number;
  borderColor?: string;
  borderType?: number;
  rows: Array<Array<Atsc708CellPreview | null>>;
}

export interface Atsc708PreviewFrame {
  start: number;
  end: number;
  service: number;
  windows: Atsc708WindowPreview[];
}

export interface Atsc708Preview {
  kind: 'atsc708';
  width: number;
  height: number;
  frames: Atsc708PreviewFrame[];
  truncated: boolean;
  service?: number;
}

export type SubtitlePreview =
  | TeletextPreview
  | BitmapPreview
  | TextPreview
  | Atsc608Preview
  | Atsc708Preview;

export interface SubtitleStreamReport {
  pid: number;
  pidHex: string;
  format: SubtitleFormat;
  category: SubtitleCategory;
  formatName: string;
  cues: SubtitleCue[];
  cueCount: number;
  truncated: boolean;
  /** DVB bitmap subtitle segment count. */
  segmentCount?: number;
  /** DVB bitmap subtitle page ids. */
  pageIds?: number[];
  /** VBI data unit count. */
  unitCount?: number;
  /** ATSC CEA-708 payload byte count. */
  dtvccBytes?: number;
  /** ATSC caption mode used for the text cues. */
  mode?: '608' | '708';
  /** CEA-608 caption channel (1–4). */
  channel?: number;
  /** CEA-708 caption service number. */
  service?: number;
  /** Human-readable note for metadata-only or empty streams. */
  note?: string;
  /** Subtitle-layer preview, when the format can be drawn accurately. */
  preview?: SubtitlePreview;
  /** Full Teletext page browser (all pages, Fastext/TOP links). */
  browse?: TeletextBrowse;
  /** Languages announced by ARIB caption management data. */
  captionLanguages?: AribCaptionLanguage[];
}

export interface SubtitleServiceReport {
  programNumber: number;
  name?: string;
  streams: SubtitleStreamReport[];
}

export interface SubtitleReport {
  services: SubtitleServiceReport[];
  totalCues: number;
  truncated: boolean;
}

export interface SubtitleReportOptions {
  /** ARIB text profile; auto uses the signalled country, then packet size. */
  profile?: 'japan' | 'brazil';
  /** Per-stream cue cap. */
  maxCuesPerStream?: number;
}

const ARIB_CAPTION_IDS = new Set([0x0008, 0x0012]);
const MAX_PREVIEW_FRAMES = 200;

const FORMAT_NAMES: Record<SubtitleFormat, string> = {
  teletext: 'DVB Teletext subtitles',
  'dvb-subtitle': 'DVB bitmap subtitles',
  'arib-caption': 'ARIB captions',
  'atsc-caption': 'ATSC CEA-608/708 closed captions',
  'vbi-teletext': 'VBI Teletext subtitles',
  vbi: 'VBI data',
};

function detectFormat(stream: ProbeStream): SubtitleFormat | undefined {
  const tags = new Set(stream.descriptors.map((descriptor) => descriptor.tag));
  if (tags.has(0x59)) return 'dvb-subtitle';
  if (tags.has(0x56)) return 'teletext';
  if (tags.has(0x46)) return 'vbi-teletext';
  if (tags.has(0x45)) return 'vbi';
  if (tags.has(0x86)) return 'atsc-caption';
  if (
    stream.descriptors.some(
      (descriptor) =>
        descriptor.tag === 0xfd && ARIB_CAPTION_IDS.has(Number(descriptor.fields?.dataComponentId)),
    )
  ) {
    return 'arib-caption';
  }
  return undefined;
}

function cleanCueText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeBase64(data: Uint8Array): string {
  let output = '';
  for (let index = 0; index < data.length; index += 3) {
    const b0 = data[index] ?? 0;
    const b1 = data[index + 1] ?? 0;
    const b2 = data[index + 2] ?? 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    output += BASE64_ALPHABET[(triple >> 18) & 63] ?? '=';
    output += BASE64_ALPHABET[(triple >> 12) & 63] ?? '=';
    output += index + 1 < data.length ? (BASE64_ALPHABET[(triple >> 6) & 63] ?? '=') : '=';
    output += index + 2 < data.length ? (BASE64_ALPHABET[triple & 63] ?? '=') : '=';
  }
  return output;
}

function previewGlyphs(glyphs: AribDrcsGlyph[] | undefined): TextPreviewGlyph[] | undefined {
  if (!glyphs || glyphs.length === 0) return undefined;
  return glyphs.map((glyph) => ({
    char: glyph.char,
    width: glyph.width,
    height: glyph.height,
    pixels: encodeBase64(glyph.pixels),
  }));
}

function teletextCues(
  packets: PesPacket[],
  maxCues: number,
): {
  byLabel: Map<string, { cues: SubtitleCue[]; frames: SubtitlePreviewFrame[]; truncated: boolean }>;
  pages: TeletextPage[];
  browse: TeletextBrowse;
  truncated: boolean;
} {
  const collector = new TeletextCollector();
  const pages: TeletextPage[] = [];
  for (const pes of packets) {
    const teletext = parseTeletextPes(pes.payload);
    if (!teletext) continue;
    pages.push(...collector.push(teletext, pes.ptsSeconds ?? 0));
  }
  pages.push(...collector.flush());

  const byLabel = new Map<string, TeletextPage[]>();
  for (const page of pages) {
    if (!page.subtitle || page.control?.inhibitDisplay) continue;
    if (cleanCueText(page.text).length === 0) continue;
    const list = byLabel.get(page.label);
    if (list) list.push(page);
    else byLabel.set(page.label, [page]);
  }

  const result = new Map<
    string,
    { cues: SubtitleCue[]; frames: SubtitlePreviewFrame[]; truncated: boolean }
  >();
  let truncated = false;

  for (const [label, list] of byLabel) {
    list.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
    const unique: TeletextPage[] = [];
    let lastSignature = '';
    for (const page of list) {
      const text = cleanCueText(page.text);
      const signature = `${text}\u0000${page.rowData
        .map((row) => (row ? Array.from(row).join(',') : ''))
        .join('|')}`;
      if (signature === lastSignature) continue;
      lastSignature = signature;
      unique.push(page);
    }

    const cues: SubtitleCue[] = [];
    const frames: SubtitlePreviewFrame[] = [];
    let labelTruncated = false;
    for (let index = 0; index < unique.length; index += 1) {
      const page = unique[index] as TeletextPage;
      const start = page.updateTime ?? page.startTime ?? 0;
      const next = unique[index + 1];
      const nextStart = next ? (next.updateTime ?? next.startTime) : undefined;
      const end =
        nextStart !== undefined && nextStart > start && nextStart - start <= 5
          ? nextStart
          : start + 5;
      cues.push({ start, end, text: cleanCueText(page.text), label });
      if (frames.length < MAX_PREVIEW_FRAMES) {
        frames.push({
          start,
          end,
          label,
          layer: buildTeletextLayer(page),
        });
      }
      if (cues.length >= maxCues) {
        labelTruncated = true;
        truncated = true;
        break;
      }
    }
    cues.sort((a, b) => a.start - b.start);
    frames.sort((a, b) => a.start - b.start);
    result.set(label, { cues, frames, truncated: labelTruncated });
  }

  return {
    byLabel: result,
    truncated,
    pages,
    browse: teletextBrowse(pages),
  };
}

const TELETEXT_BROWSE_LIMIT = 80;

/** Build the full-page browser payload from every collected Teletext page. */
function teletextBrowse(pages: TeletextPage[]): TeletextBrowse {
  const latest = new Map<string, TeletextPage>();
  for (const page of pages) {
    if (page.page < 0) continue;
    if (page.control?.inhibitDisplay) continue;
    if (!page.rowData.some((row) => row !== undefined)) continue;
    const stamp = page.updateTime ?? page.startTime ?? 0;
    const previous = latest.get(page.label);
    const previousStamp = previous?.updateTime ?? previous?.startTime ?? -1;
    if (!previous || stamp >= previousStamp) latest.set(page.label, page);
  }
  const all = [...latest.values()].sort((a, b) => a.magazine - b.magazine || a.page - b.page);
  const shown = all.slice(0, TELETEXT_BROWSE_LIMIT).map((page) => ({
    label: page.label,
    magazine: page.magazine,
    page: page.page,
    subtitle: page.subtitle,
    text: page.text,
    layer: buildTeletextLayer(page),
    ...(page.links !== undefined ? { links: page.links } : {}),
    ...(page.navigation !== undefined ? { navigation: page.navigation } : {}),
    ...(page.startTime !== undefined ? { firstSeen: page.startTime } : {}),
    ...(page.updateTime !== undefined ? { lastSeen: page.updateTime } : {}),
  }));
  return {
    pages: shown,
    total: all.length,
    truncated: all.length > shown.length,
    linkCount: shown.reduce((sum, page) => sum + (page.links?.length ?? 0), 0),
  };
}

interface AribCueEntry {
  start: number;
  text: string;
  lines: AribTextLine[];
  display?: AribCaptionDisplay;
  styled: boolean;
  drcs?: AribDrcsGlyph[];
  metrics: AribFontMetrics;
}

function glyphSignature(glyphs: AribDrcsGlyph[] | undefined): string {
  return (glyphs ?? [])
    .map((glyph) => {
      let checksum = 0;
      for (const value of glyph.pixels) checksum = (checksum * 31 + value) >>> 0;
      return `${glyph.char}:${glyph.width}x${glyph.height}:${checksum}`;
    })
    .join(',');
}

function aribCues(
  packets: PesPacket[],
  profile: 'japan' | 'brazil',
  maxCues: number,
  display?: { width: number; height: number },
  fontProfile?: 'A' | 'C',
): {
  cues: SubtitleCue[];
  frames: TextPreviewFrame[];
  truncated: boolean;
  styled: boolean;
  metrics?: AribFontMetrics;
  drcs: boolean;
  languages: AribCaptionLanguage[];
} {
  const ordered = [...packets].sort((a, b) => (a.ptsSeconds ?? 0) - (b.ptsSeconds ?? 0));
  const drcsContext = createAribDrcsContext();
  const options: AribCaptionOptions = {
    drcs: drcsContext,
    ...(display?.width !== undefined ? { displayWidth: display.width } : {}),
    ...(display?.height !== undefined ? { displayHeight: display.height } : {}),
    ...(fontProfile ? { fontProfile } : {}),
  };
  const entries: AribCueEntry[] = [];
  const languages = new Map<string, AribCaptionLanguage>();
  let lastSignature: string | undefined;
  let truncated = false;
  for (const pes of ordered) {
    for (const language of parseAribCaptionLanguages(pes.payload)) {
      languages.set(language.code, language);
    }
    const caption = extractAribCaptionStyled(pes.payload, profile, options);
    if (!caption) continue;
    const text = cleanCueText(caption.text);
    if (text.length === 0) continue;
    const signature = JSON.stringify({
      text,
      lines: caption.lines,
      display: caption.display,
      drcs: glyphSignature(caption.drcs),
    });
    if (signature === lastSignature) continue;
    lastSignature = signature;
    entries.push({
      start: pes.ptsSeconds ?? 0,
      text,
      lines: caption.lines,
      ...(caption.display ? { display: caption.display } : {}),
      styled: caption.styled,
      ...(caption.drcs ? { drcs: caption.drcs } : {}),
      metrics: caption.metrics,
    });
    if (entries.length >= maxCues) {
      truncated = true;
      break;
    }
  }

  const cues: SubtitleCue[] = entries.map((entry, index) => {
    const nextStart = entries[index + 1]?.start;
    return {
      start: entry.start,
      end: nextStart !== undefined && nextStart > entry.start ? nextStart : entry.start + 5,
      text: entry.text,
    };
  });

  const frames: TextPreviewFrame[] = entries.map((entry, index) => ({
    start: cues[index]?.start ?? entry.start,
    end: cues[index]?.end ?? entry.start + 5,
    lines: entry.lines
      .map((line) => line.runs.map((run) => run.text).join(''))
      .filter((line) => line.trim().length > 0),
    styledLines: entry.lines,
    ...(entry.drcs ? { drcs: previewGlyphs(entry.drcs) } : {}),
    ...(entry.display ? { display: entry.display } : {}),
  }));

  return {
    cues,
    frames,
    truncated,
    styled: entries.some((entry) => entry.styled),
    ...(entries[0]?.metrics ? { metrics: entries[0].metrics } : {}),
    drcs: entries.some((entry) => (entry.drcs?.length ?? 0) > 0),
    languages: [...languages.values()],
  };
}

const ATSC_608_COLORS: Record<string, string> = {
  white: '#ffffff',
  green: '#00ff00',
  blue: '#0000ff',
  cyan: '#00ffff',
  red: '#ff0000',
  yellow: '#ffff00',
  magenta: '#ff00ff',
};

interface Atsc608Entry {
  start: number;
  snapshot: Atsc608Snapshot;
  signature: string;
}

interface Atsc708Entry {
  start: number;
  snapshot: Atsc708Snapshot;
  signature: string;
}

function atsc608Signature(snapshot: Atsc608Snapshot): string {
  return snapshot.rows
    .map((row) =>
      row
        .map((cell) =>
          cell
            ? `${cell.char}${cell.pen.color}${cell.pen.italics ? 'i' : ''}${cell.pen.underline ? 'u' : ''}`
            : '.',
        )
        .join(''),
    )
    .join('\n');
}

function atsc708Signature(snapshot: Atsc708Snapshot): string {
  return snapshot.windows
    .map(
      (window) =>
        `${window.id}:${window.priority}:${window.anchorPoint}:${window.anchorVertical}:${window.anchorHorizontal}:${window.rowCount}:${window.columnCount}:${window.justify}:` +
        window.rows
          .map((row) =>
            row
              .map((cell) =>
                cell
                  ? `${cell.char}${cell.fg}${cell.bg}${cell.italics ? 'i' : ''}${cell.underline ? 'u' : ''}`
                  : '.',
              )
              .join(''),
          )
          .join('/'),
    )
    .join('|');
}

function atsc608Rows(snapshot: Atsc608Snapshot): Atsc608RowPreview[] {
  const rows: Atsc608RowPreview[] = [];
  snapshot.rows.forEach((cells, row) => {
    if (!cells.some((cell) => cell !== null)) return;
    rows.push({
      row,
      cells: cells.map((cell) =>
        cell
          ? {
              char: cell.char,
              ...(cell.pen.color !== 'white'
                ? { color: ATSC_608_COLORS[cell.pen.color] ?? '#ffffff' }
                : {}),
              ...(cell.pen.italics ? { italics: true } : {}),
              ...(cell.pen.underline ? { underline: true } : {}),
            }
          : null,
      ),
    });
  });
  return rows;
}

function atsc708Windows(
  snapshot: Atsc708Snapshot,
  width: number,
  height: number,
): Atsc708WindowPreview[] {
  const charWidth = Math.max(8, Math.round(width / 60));
  const charHeight = Math.max(12, Math.round(height / 30));
  return snapshot.windows.map((window) => {
    const windowWidth = window.columnCount * charWidth;
    const windowHeight = window.rowCount * charHeight;
    const relative = window.relative || window.anchorVertical > 74 || window.anchorHorizontal > 209;
    const anchorX = relative
      ? (window.anchorHorizontal / 100) * width
      : (window.anchorHorizontal / 209) * width;
    const anchorY = relative
      ? (window.anchorVertical / 100) * height
      : (window.anchorVertical / 74) * height;
    let x = anchorX;
    let y = anchorY;
    if (window.anchorPoint === 1 || window.anchorPoint === 4 || window.anchorPoint === 7) {
      x -= windowWidth / 2;
    } else if (window.anchorPoint === 2 || window.anchorPoint === 5 || window.anchorPoint === 8) {
      x -= windowWidth;
    }
    if (window.anchorPoint >= 3 && window.anchorPoint <= 5) {
      y -= windowHeight / 2;
    } else if (window.anchorPoint >= 6) {
      y -= windowHeight;
    }
    x = Math.max(0, Math.min(Math.max(0, width - windowWidth), x));
    y = Math.max(0, Math.min(Math.max(0, height - windowHeight), y));
    return {
      id: window.id,
      priority: window.priority,
      x,
      y,
      width: windowWidth,
      height: windowHeight,
      rowCount: window.rowCount,
      columnCount: window.columnCount,
      justify: window.justify,
      ...(window.fillOpacity !== 3 ? { fillColor: window.fillColor } : {}),
      fillOpacity: window.fillOpacity,
      ...(window.borderType !== 0 ? { borderColor: window.borderColor } : {}),
      borderType: window.borderType,
      rows: window.rows.map((row) =>
        row.map((cell) =>
          cell
            ? {
                char: cell.char,
                ...(cell.fg !== '#ffffff' ? { fg: cell.fg } : {}),
                ...(cell.bg !== '#000000' ? { bg: cell.bg } : {}),
                ...(cell.italics ? { italics: true } : {}),
                ...(cell.underline ? { underline: true } : {}),
              }
            : null,
        ),
      ),
    };
  });
}

function atscCues(
  packets: PesPacket[],
  maxCues: number,
  width: number,
  height: number,
): {
  groups608: Array<{ channel: number; cues: SubtitleCue[]; frames: Atsc608PreviewFrame[] }>;
  groups708: Array<{ service: number; cues: SubtitleCue[]; frames: Atsc708PreviewFrame[] }>;
  truncated: boolean;
  dtvccBytes: number;
} {
  const ordered = [...packets].sort((a, b) => (a.ptsSeconds ?? 0) - (b.ptsSeconds ?? 0));
  const decoder608 = new Atsc608Decoder();
  const decoder708 = new Atsc708Decoder();
  const entries608 = new Map<number, Atsc608Entry[]>();
  const entries708 = new Map<number, Atsc708Entry[]>();
  const last608 = new Map<number, string>();
  const last708 = new Map<number, string>();
  let dtvccBytes = 0;

  const append = <T>(store: Map<number, T[]>, key: number, entry: T): void => {
    const entries = store.get(key) ?? [];
    entries.push(entry);
    store.set(key, entries);
  };

  for (const pes of ordered) {
    const caption = parseAtscCaptionPayload(pes.payload);
    if (!caption) continue;
    const start = pes.ptsSeconds ?? 0;
    dtvccBytes += caption.dtvccBytes;
    decoder608.pushUnits(caption.units);
    decoder708.pushUnits(caption.units);

    // Each 608 channel keeps its own timeline so CC1–CC4 are separate streams.
    for (const snapshot of decoder608.snapshots()) {
      const signature = atsc608Signature(snapshot);
      if (signature === (last608.get(snapshot.channel) ?? '')) continue;
      last608.set(snapshot.channel, signature);
      append(entries608, snapshot.channel, { start, snapshot, signature });
    }

    // 708 snapshots only list services with visible text; a missing service
    // that used to show text gets a clearing entry.
    const visible708 = new Set<number>();
    for (const snapshot of decoder708.snapshots()) {
      visible708.add(snapshot.service);
      const signature = atsc708Signature(snapshot);
      if (signature === (last708.get(snapshot.service) ?? '')) continue;
      last708.set(snapshot.service, signature);
      append(entries708, snapshot.service, { start, snapshot, signature });
    }
    for (const [service, signature] of last708) {
      if (signature.length === 0 || visible708.has(service)) continue;
      last708.set(service, '');
      append(entries708, service, {
        start,
        snapshot: { service, windows: [], text: '' },
        signature: '',
      });
    }
  }

  const buildCues = (
    entries: Array<{ start: number; snapshot: { text: string } }>,
  ): SubtitleCue[] => {
    const cues: SubtitleCue[] = [];
    for (let index = 0; index < entries.length && cues.length < maxCues; index += 1) {
      const entry = entries[index] as { start: number; snapshot: { text: string } };
      const text = entry.snapshot.text.trim();
      if (text.length === 0) continue;
      const next = entries[index + 1]?.start;
      cues.push({
        start: entry.start,
        end: next !== undefined && next > entry.start ? next : entry.start + 5,
        text,
      });
    }
    return cues;
  };

  const buildFrames608 = (entries: Atsc608Entry[]): Atsc608PreviewFrame[] => {
    const frames: Atsc608PreviewFrame[] = [];
    for (let index = 0; index < entries.length && frames.length < 500; index += 1) {
      const entry = entries[index] as Atsc608Entry;
      if (entry.snapshot.text.trim().length === 0) continue;
      const next = entries[index + 1]?.start;
      frames.push({
        start: entry.start,
        end: next !== undefined && next > entry.start ? next : entry.start + 5,
        mode: entry.snapshot.mode,
        rows: atsc608Rows(entry.snapshot),
      });
    }
    return frames;
  };

  const buildFrames708 = (entries: Atsc708Entry[]): Atsc708PreviewFrame[] => {
    const frames: Atsc708PreviewFrame[] = [];
    for (let index = 0; index < entries.length && frames.length < 500; index += 1) {
      const entry = entries[index] as Atsc708Entry;
      if (entry.snapshot.text.trim().length === 0) continue;
      const next = entries[index + 1]?.start;
      frames.push({
        start: entry.start,
        end: next !== undefined && next > entry.start ? next : entry.start + 5,
        service: entry.snapshot.service,
        windows: atsc708Windows(entry.snapshot, width, height),
      });
    }
    return frames;
  };

  const groups608 = [...entries608.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([channel, entries]) => ({
      channel,
      cues: buildCues(entries),
      frames: buildFrames608(entries),
    }))
    .filter((group) => group.cues.length > 0 || group.frames.length > 0);

  const groups708 = [...entries708.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([service, entries]) => ({
      service,
      cues: buildCues(entries),
      frames: buildFrames708(entries),
    }))
    .filter((group) => group.cues.length > 0 || group.frames.length > 0);

  return {
    groups608,
    groups708,
    truncated:
      groups608.some((group) => group.cues.length >= maxCues) ||
      groups708.some((group) => group.cues.length >= maxCues),
    dtvccBytes,
  };
}

function dvbSubtitleReport(packets: PesPacket[]): SubtitleStreamReportBase | undefined {
  let segmentCount = 0;
  const pageIds = new Set<number>();
  for (const pes of packets) {
    const index = indexDvbSubtitlePes(pes.payload);
    if (!index) continue;
    segmentCount += index.segments.length;
    for (const segment of index.segments) pageIds.add(segment.pageId);
  }
  if (segmentCount === 0) return undefined;
  const timeline = collectDvbSubtitleTimeline(packets);
  return {
    pid: 0,
    pidHex: '',
    format: 'dvb-subtitle',
    formatName: FORMAT_NAMES['dvb-subtitle'],
    cues: [],
    cueCount: 0,
    truncated: false,
    segmentCount,
    pageIds: [...pageIds].sort((a, b) => a - b),
    note:
      timeline.frames.length > 0
        ? 'Bitmap subtitles; pixel preview is rendered from CLUT and object data.'
        : 'Bitmap subtitles; display sets and metadata are indexed, but no visible frame was found in the sampled data.',
    ...(timeline.frames.length > 0
      ? {
          preview: {
            kind: 'bitmap' as const,
            width: timeline.width,
            height: timeline.height,
            frames: timeline.frames,
            truncated: timeline.truncated,
            onDemand: true as const,
          },
        }
      : {}),
  };
}

type SubtitleStreamReportBase = Omit<SubtitleStreamReport, 'category'>;

function teletextPreview(frames: SubtitlePreviewFrame[]): TeletextPreview {
  return {
    kind: 'teletext',
    width: 720,
    height: 576,
    frames,
    truncated: frames.length >= MAX_PREVIEW_FRAMES,
  };
}

function processStreamFormat(
  stream: ProbeStream,
  format: SubtitleFormat,
  packets: PesPacket[],
  profile: 'japan' | 'brazil',
  maxCues: number,
  display?: { width: number; height: number },
): SubtitleStreamReportBase {
  if (format === 'dvb-subtitle') {
    const report = dvbSubtitleReport(packets);
    if (report) return { ...report, pid: stream.pid, pidHex: stream.pidHex };
    return {
      pid: stream.pid,
      pidHex: stream.pidHex,
      format,
      formatName: FORMAT_NAMES[format],
      cues: [],
      cueCount: 0,
      truncated: false,
      note: 'No DVB subtitle display sets found in the sampled data.',
    };
  }

  if (format === 'arib-caption') {
    const dataComponentId = Number(
      stream.descriptors.find((descriptor) => descriptor.tag === 0xfd)?.fields?.dataComponentId,
    );
    const fontProfile = dataComponentId === 0x0012 ? 'C' : undefined;
    const result = aribCues(packets, profile, maxCues, display, fontProfile);
    const frames = result.frames.slice(0, 500);
    return {
      pid: stream.pid,
      pidHex: stream.pidHex,
      format,
      formatName: FORMAT_NAMES[format],
      cues: result.cues,
      cueCount: result.cues.length,
      truncated: result.truncated,
      ...(result.languages.length > 0 ? { captionLanguages: result.languages } : {}),
      ...(frames.length > 0
        ? {
            preview: {
              kind: 'text' as const,
              width: display?.width ?? 720,
              height: display?.height ?? 576,
              frames,
              truncated: result.frames.length > 500,
              format,
              styled: result.styled,
              ...(result.metrics ? { metrics: result.metrics } : {}),
              drcs: result.drcs,
              note: result.drcs
                ? 'ARIB style layer with DRCS glyphs and broadcast A/C-profile font metrics.'
                : result.styled
                  ? 'ARIB style layer with broadcast A/C-profile font metrics.'
                  : 'ARIB text layer: no style controls were found in the sampled statement bodies.',
            },
          }
        : {}),
      ...(result.cues.length === 0
        ? { note: 'No decodable ARIB caption text in the sampled data.' }
        : {}),
    };
  }

  // No-op fallback: all known formats are handled above, but keep a default
  // so TypeScript accepts the exhaustive return.
  return {
    pid: stream.pid,
    pidHex: stream.pidHex,
    format,
    formatName: FORMAT_NAMES[format],
    cues: [],
    cueCount: 0,
    truncated: false,
    note: `No decodable ${FORMAT_NAMES[format]} data in the sampled packets.`,
  };
}

function processAtscStream(
  stream: ProbeStream,
  packets: PesPacket[],
  maxCues: number,
  display?: { width: number; height: number },
): SubtitleStreamReport[] {
  const width = display?.width ?? 1920;
  const height = display?.height ?? 1080;
  const result = atscCues(packets, maxCues, width, height);
  const reports: SubtitleStreamReport[] = [];

  for (const group of result.groups608) {
    reports.push({
      pid: stream.pid,
      pidHex: stream.pidHex,
      format: 'atsc-caption',
      category: 'caption',
      formatName: 'ATSC CEA-608 closed captions',
      cues: group.cues,
      cueCount: group.cues.length,
      truncated: result.truncated,
      mode: '608',
      channel: group.channel,
      ...(group.frames.length > 0
        ? {
            preview: {
              kind: 'atsc608' as const,
              width,
              height,
              frames: group.frames,
              truncated: group.frames.length >= 500,
              channel: group.channel,
            },
          }
        : {}),
    });
  }

  for (const group of result.groups708) {
    reports.push({
      pid: stream.pid,
      pidHex: stream.pidHex,
      format: 'atsc-caption',
      category: 'caption',
      formatName: 'ATSC CEA-708 closed captions',
      cues: group.cues,
      cueCount: group.cues.length,
      truncated: result.truncated,
      mode: '708',
      dtvccBytes: result.dtvccBytes,
      service: group.service,
      ...(group.frames.length > 0
        ? {
            preview: {
              kind: 'atsc708' as const,
              width,
              height,
              frames: group.frames,
              truncated: group.frames.length >= 500,
              service: group.service,
            },
          }
        : {}),
    });
  }

  if (reports.length === 0) {
    reports.push({
      pid: stream.pid,
      pidHex: stream.pidHex,
      format: 'atsc-caption',
      category: 'caption',
      formatName: FORMAT_NAMES['atsc-caption'],
      cues: [],
      cueCount: 0,
      truncated: false,
      mode: '608',
      dtvccBytes: result.dtvccBytes,
      note: 'No CEA-608/708 caption text found in the sampled data.',
    });
  }
  return reports;
}

function processTeletextStream(
  stream: ProbeStream,
  format: SubtitleFormat,
  packets: PesPacket[],
  maxCues: number,
): SubtitleStreamReport[] {
  let resolvedFormat: SubtitleFormat = format;
  let unitCount: number | undefined;

  if (format === 'vbi') {
    let hasTeletext = false;
    let units = 0;
    for (const pes of packets) {
      const vbi = parseVbiPes(pes.payload);
      if (!vbi) continue;
      units += vbi.units.length;
      if (vbi.units.some((unit) => unit.id === 0x02 || unit.id === 0x03)) {
        hasTeletext = true;
      }
    }
    unitCount = units;
    if (!hasTeletext) {
      return [
        {
          pid: stream.pid,
          pidHex: stream.pidHex,
          format,
          category: subtitleCategory(format),
          formatName: FORMAT_NAMES[format],
          cues: [],
          cueCount: 0,
          truncated: false,
          unitCount,
          note: 'VBI data units are indexed, but no text subtitles are present.',
        },
      ];
    }
    resolvedFormat = 'vbi-teletext';
  }

  const result = teletextCues(packets, maxCues);
  const reports: SubtitleStreamReport[] = [];

  if (result.byLabel.size === 0) {
    reports.push({
      pid: stream.pid,
      pidHex: stream.pidHex,
      format: resolvedFormat,
      category: subtitleCategory(resolvedFormat),
      formatName: FORMAT_NAMES[resolvedFormat],
      cues: [],
      cueCount: 0,
      truncated: result.truncated,
      ...(unitCount !== undefined ? { unitCount } : {}),
      note: 'No subtitle pages found in the sampled Teletext data.',
    });
  } else {
    // Filter out single-shot pages (cue count < 2) such as Teletext service
    // announcements or coverage notices — these are not subtitle tracks even
    // if they happen to carry a subtitle-layer row. A real subtitle track is
    // refreshed repeatedly by the broadcaster.
    const labels = [...result.byLabel.keys()]
      .filter((label) => {
        const group = result.byLabel.get(label)!;
        return group.cues.length >= 2;
      })
      .sort((a, b) => {
        const [aMagRaw, aPageRaw] = a.split(':').map((v) => Number.parseInt(v, 16));
        const [bMagRaw, bPageRaw] = b.split(':').map((v) => Number.parseInt(v, 16));
        const aMag = aMagRaw ?? 0;
        const aPage = aPageRaw ?? 0;
        const bMag = bMagRaw ?? 0;
        const bPage = bPageRaw ?? 0;
        return aMag - bMag || aPage - bPage;
      });
    for (const label of labels) {
      const group = result.byLabel.get(label)!;
      reports.push({
        pid: stream.pid,
        pidHex: stream.pidHex,
        format: resolvedFormat,
        category: subtitleCategory(resolvedFormat),
        formatName: FORMAT_NAMES[resolvedFormat],
        cues: group.cues,
        cueCount: group.cues.length,
        truncated: group.truncated || result.truncated,
        ...(unitCount !== undefined ? { unitCount } : {}),
        ...(group.frames.length > 0 ? { preview: teletextPreview(group.frames) } : {}),
        // Only the first report carries the full-page browse tree so it is not
        // duplicated for every magazine/page variant from the same PID.
        ...(reports.length === 0 && result.browse.pages.length > 0
          ? { browse: result.browse }
          : {}),
      });
    }
  }

  return reports;
}

function processStream(
  stream: ProbeStream,
  format: SubtitleFormat,
  packets: PesPacket[],
  profile: 'japan' | 'brazil',
  maxCues: number,
  display?: { width: number; height: number },
): SubtitleStreamReport[] {
  if (format === 'atsc-caption') {
    return processAtscStream(stream, packets, maxCues, display);
  }
  if (format === 'teletext' || format === 'vbi-teletext' || format === 'vbi') {
    return processTeletextStream(stream, format, packets, maxCues);
  }
  const report = processStreamFormat(stream, format, packets, profile, maxCues, display);
  return [{ ...report, category: subtitleCategory(report.format) }];
}

/** Build a per-service subtitle report from a probed transport stream. */
export function collectSubtitleReport(
  data: Uint8Array,
  layout: PacketLayout,
  result: ProbeResult,
  options: SubtitleReportOptions = {},
): SubtitleReport {
  const maxCues = options.maxCuesPerStream ?? 5000;
  const profile = resolveAribProfile(result, options.profile ?? 'auto');
  const targets = new Set<number>();
  for (const service of result.services) {
    for (const stream of service.streams) {
      if (detectFormat(stream)) targets.add(stream.pid);
    }
  }

  const packetsByPid = new Map<number, PesPacket[]>();
  if (targets.size > 0) {
    for (const pes of collectPesPackets(data, layout, targets)) {
      const list = packetsByPid.get(pes.pid);
      if (list) list.push(pes);
      else packetsByPid.set(pes.pid, [pes]);
    }
  }

  const cache = new Map<string, SubtitleStreamReport[]>();
  const services: SubtitleServiceReport[] = [];
  let totalCues = 0;
  let truncated = false;

  for (const service of result.services) {
    const streams: SubtitleStreamReport[] = [];
    const video = service.streams.find(
      (stream) =>
        stream.es?.kind === 'video' &&
        stream.es.width !== undefined &&
        stream.es.height !== undefined,
    );
    const display =
      video?.es?.width !== undefined && video.es.height !== undefined
        ? { width: video.es.width, height: video.es.height }
        : undefined;
    for (const stream of service.streams) {
      const format = detectFormat(stream);
      if (!format) continue;
      const cacheKey = `${stream.pid}:${format}:${display?.width ?? 0}x${display?.height ?? 0}`;
      let reports = cache.get(cacheKey);
      if (!reports) {
        reports = processStream(
          stream,
          format,
          packetsByPid.get(stream.pid) ?? [],
          profile,
          maxCues,
          display,
        );
        cache.set(cacheKey, reports);
      }
      for (const report of reports) {
        streams.push(report);
        totalCues += report.cueCount;
        if (report.truncated) truncated = true;
      }
    }
    if (streams.length > 0) {
      services.push({
        programNumber: service.programNumber,
        ...(service.name ? { name: service.name } : {}),
        streams,
      });
    }
  }

  return { services, totalCues, truncated };
}
