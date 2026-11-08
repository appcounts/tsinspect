/**
 * DVB Teletext in PES (ETSI EN 300 472 / EN 300 706).
 *
 * A PES payload starts with a data_identifier (0x10-0x1F), followed by
 * data_units. Teletext units use id 0x02 (normal) or 0x03 (subtitle) and carry
 * a 44-byte data field: line offset/field parity, framing code, 2-byte packet
 * address, and the 40-byte teletext packet body.
 */

import { iso6937G2 } from '../descriptors/descriptor.js';
import { reverse8, unham84 } from './teletext-tables.js';

export { reverse8, unham84 };

/** Page-header control bits C4-C14 (ETSI EN 300 706 table 2). */
export interface TeletextControlBits {
  /** C4: erase the previously transmitted rows of this page. */
  erasePage: boolean;
  /** C5: newsflash page. */
  newsflash: boolean;
  /** C6: subtitle page. */
  subtitle: boolean;
  /** C7: suppress the page header row. */
  suppressHeader: boolean;
  /** C8: page contents changed since the previous transmission. */
  updateIndicator: boolean;
  /** C9: page is out of numerical sequence. */
  interruptedSequence: boolean;
  /** C10: rows 1-24 are not to be displayed. */
  inhibitDisplay: boolean;
  /** C11: magazine serial transmission mode. */
  magazineSerial: boolean;
  /** C12-C14 national option character subset (0-7). */
  nationalSubset: number;
}

/** One X/26 enhancement triplet (address 6 bits, mode 5 bits, data 7 bits). */
export interface TeletextTriplet {
  address: number;
  mode: number;
  data: number;
}

/** A Fastext or TOP navigation link carried by an X/27/0 packet. */
export interface TeletextPageLink {
  magazine: number;
  page: number;
  /** Page label as displayed, for example "1:80". */
  label: string;
  kind: 'flof' | 'top';
  /** Fastext colour key, for the first four links. */
  color?: 'red' | 'green' | 'yellow' | 'blue';
  /** Sub-page code, when transmitted. */
  subcode?: number;
}

/** Teletext enhancement level and navigation facilities for a page. */
export interface TeletextNavigation {
  /** Full Level One Facilities (Fastext) links are present. */
  flof: boolean;
  /** Table Of Pages navigation is signalled. */
  top: boolean;
  /** Fastext link control bits are present. */
  fastext: boolean;
  level: 1 | 1.5 | 2.5;
}

export interface TeletextPacket {
  magazine: number;
  page: number;
  row: number;
  text: string;
  subtitle: boolean;
  /** National option subset from the page header (0-7, Latin default). */
  subset: number;
  /** Data unit id which carried this packet (0x02 normal, 0x03 subtitle). */
  unitId: number;
  /** Page header control bits; only present on row-0 packets. */
  control?: TeletextControlBits;
  /** Raw 40-byte row payload, for colour/mosaic rendering. */
  raw?: Uint8Array;
  /** X/26 Level 1.5/2.5 enhancement triplets. */
  triplets?: TeletextTriplet[];
  /** X/26 designation code (0-15). */
  designation?: number;
  /** X/27/0 page links (Fastext / TOP). */
  links?: TeletextPageLink[];
  /** X/28/0 navigation signalling. */
  navigation?: TeletextNavigation;
}

export interface TeletextPes {
  dataIdentifier: number;
  packets: TeletextPacket[];
  subtitlePackets: number;
}

/** G0 positions replaced by the Latin national option subsets. */
const NATIONAL_POSITIONS = [0x23, 0x24, 0x40, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f, 0x60, 0x7b, 0x7c, 0x7d, 0x7e];

/** ETSI EN 300 706 table 36 Latin national option subsets. */
const NATIONAL_SUBSETS: string[][] = [
  ['£', '$', '@', '«', '½', '»', '^', '#', '-', '¼', '¦', '¾', '÷'], // English
  ['é', 'ï', 'à', 'ë', 'ê', 'ù', 'î', '#', 'è', 'â', 'ô', 'û', 'ç'], // French
  ['#', '¤', 'É', 'Ä', 'Ö', 'Å', 'Ü', '_', 'é', 'ä', 'ö', 'å', 'ü'], // Swedish/Finnish/Hungarian
  ['#', 'ů', 'č', 'ť', 'ž', 'ý', 'í', 'ř', 'é', 'á', 'ě', 'ú', 'š'], // Czech/Slovak
  ['#', '$', '§', 'Ä', 'Ö', 'Ü', '^', '_', '°', 'ä', 'ö', 'ü', 'ß'], // German
  ['ç', '$', '¡', 'á', 'é', 'í', 'ó', 'ú', '¿', 'ü', 'ñ', 'è', 'à'], // Portuguese/Spanish
  ['£', '$', 'é', '°', 'ç', '»', '^', '#', 'ù', 'à', 'ò', 'è', 'ì'], // Italian
  ['#', '¤', 'Ţ', 'Â', 'Ş', 'Ă', 'Î', 'ı', 'ţ', 'â', 'ş', 'ă', 'î'], // Romanian
];

function decodeTeletextRow(bytes: Uint8Array, subset = 0): string {
  let out = '';
  // Rows start in the alphanumeric (alpha) mode. Spacing attributes 0x00-0x07
  // select alpha colours, while 0x10-0x17 switch to mosaics; mosaic bytes are
  // graphics, not readable text, so they become blanks in text output.
  let alpha = true;
  for (let index = 0; index < bytes.length; index += 1) {
    const value = bytes[index] as number;
    const code = value & 0x7f;
    if (code <= 0x07) {
      alpha = true;
      out += ' ';
    } else if (code >= 0x10 && code <= 0x17) {
      alpha = false;
      out += ' ';
    } else if (code === 0x1e) {
      // Hold mosaics.
      alpha = false;
      out += ' ';
    } else if (code === 0x1f) {
      // Release mosaics, returning to the alpha set.
      alpha = true;
      out += ' ';
    } else if (code === 0x1b) {
      // Escape selects one character from the G2 supplementary set.
      const next = bytes[index + 1];
      if (next === undefined) {
        out += ' ';
      } else {
        index += 1;
        out += alpha ? iso6937G2(next & 0x7f) ?? ' ' : ' ';
      }
    } else if (code >= 0x20) {
      out += alpha ? teletextCharacter(value, subset) : ' ';
    } else {
      out += ' ';
    }
  }
  return out.replace(/\s+$/g, '');
}

/** Decode one 7-bit Teletext G0 character, applying the national subset. */
export function teletextCharacter(value: number, subset = 0): string {
  const mapping = NATIONAL_SUBSETS[subset] ?? NATIONAL_SUBSETS[0];
  const character = value & 0x7f;
  const position = NATIONAL_POSITIONS.indexOf(character);
  if (character === 0x7f) return '█';
  if (character < 0x20) return ' ';
  if (position >= 0 && mapping !== undefined) {
    return mapping[position] ?? String.fromCharCode(character);
  }
  return String.fromCharCode(character);
}

/** Decode a Hamming-protected header nibble, treating errors as zero. */
function safeNibble(value: number): number {
  const nibble = unham84(value);
  return nibble === 0xff ? 0 : nibble;
}

/** Decode one Hamming 8/4 pair (low byte first) into an 8-bit value. */
function unham16(data: Uint8Array, offset: number): number {
  const low = safeNibble(data[offset] as number);
  const high = safeNibble(data[offset + 1] as number);
  return (high << 4) | low;
}

/** Decode one Hamming 24/18 triplet (D1-D4 | D5-D11 | D12-D18). */
function unham24(data: Uint8Array, offset: number): number {
  const d1d4 = (data[offset] as number) >> 3;
  const d5d11 = (data[offset + 1] as number) & 0x7f;
  const d12d18 = (data[offset + 2] as number) & 0x7f;
  return d1d4 | (d5d11 << 4) | (d12d18 << 11);
}

/** Parse the 13 X/26 enhancement triplets carried after the designation. */
function parseTriplets(data: Uint8Array): TeletextTriplet[] {
  const triplets: TeletextTriplet[] = [];
  for (let offset = 1; offset + 2 < data.length && triplets.length < 13; offset += 3) {
    const value = unham24(data, offset);
    // Unused triplet slots are transmitted as zero bytes; they must not be
    // decoded as "black at column 0" attributes.
    if (value === 0) continue;
    triplets.push({
      address: value & 0x3f,
      mode: (value >> 6) & 0x1f,
      data: (value >> 11) & 0x7f,
    });
  }
  return triplets;
}

const FLOF_COLORS: Array<TeletextPageLink['color']> = ['red', 'green', 'yellow', 'blue'];

/** Parse the six page links of an X/27/0 packet. */
function parsePageLinks(
  data: Uint8Array,
  magazine: number,
  kind: 'flof' | 'top',
): TeletextPageLink[] {
  const links: TeletextPageLink[] = [];
  for (let index = 0; index < 6; index += 1) {
    const offset = 1 + index * 6;
    if (offset + 5 >= data.length) break;
    const b1 = unham16(data, offset);
    const b2 = unham16(data, offset + 2);
    const b3 = unham16(data, offset + 4);
    const linkMagazine = (((b3 >> 5) & 0x06) | (b2 >> 7)) ^ magazine || 8;
    if (b1 === 0xff) continue;
    const link: TeletextPageLink = {
      magazine: linkMagazine,
      page: linkMagazine * 256 + b1,
      label: pageLabel(linkMagazine, b1),
      kind,
    };
    const color = FLOF_COLORS[index];
    if (color !== undefined) link.color = color;
    if (b2 !== 0xff || b3 !== 0xff) link.subcode = (b3 * 256 + b2) & 0x3f7f;
    links.push(link);
  }
  return links;
}

/**
 * Decode the page-header control bits.
 *
 * Header body layout (EN 300 706 figure 9):
 * `[0]` page units, `[1]` page tens, `[2]` S1, `[3]` S2+C4, `[4]` S3,
 * `[5]` S4+C5+C6, `[6]` C7-C10, `[7]` C11-C14.
 */
function decodeControlBits(data: Uint8Array): TeletextControlBits {
  const s2c4 = safeNibble(data[3] as number);
  const s4c5c6 = safeNibble(data[5] as number);
  const c7c10 = safeNibble(data[6] as number);
  const c11c14 = safeNibble(data[7] as number);
  return {
    erasePage: (s2c4 & 0x08) !== 0,
    newsflash: (s4c5c6 & 0x04) !== 0,
    subtitle: (s4c5c6 & 0x08) !== 0,
    suppressHeader: (c7c10 & 0x01) !== 0,
    updateIndicator: (c7c10 & 0x02) !== 0,
    interruptedSequence: (c7c10 & 0x04) !== 0,
    inhibitDisplay: (c7c10 & 0x08) !== 0,
    magazineSerial: (c11c14 & 0x01) !== 0,
    nationalSubset: (c11c14 >> 1) & 0x07,
  };
}

export function parseTeletextPes(payload: Uint8Array): TeletextPes | null {
  if (payload.length < 2) return null;
  const dataIdentifier = payload[0] as number;
  if (dataIdentifier < 0x10 || dataIdentifier > 0x1f) return null;

  const packets: TeletextPacket[] = [];
  let subtitlePackets = 0;
  const currentPage = new Map<number, number>();
  const currentSubtitle = new Map<number, boolean>();
  const currentSubset = new Map<number, number>();
  let cursor = 1;

  while (cursor + 2 <= payload.length) {
    const unitId = payload[cursor] as number;
    const unitLength = payload[cursor + 1] as number;
    const start = cursor + 2;
    const end = Math.min(payload.length, start + unitLength);

    if ((unitId === 0x02 || unitId === 0x03) && unitLength >= 44 && start + 44 <= payload.length) {
      const transmitted = payload.subarray(start, start + 44);
      // Teletext transmits each byte LSB first. The data field begins with the
      // line-offset/field-parity byte and the framing code, then the two
      // Hamming-protected address bytes and the 40-byte packet body.
      const packet = new Uint8Array(44);
      for (let i = 0; i < 44; i += 1) packet[i] = reverse8(transmitted[i] as number);

      const address = (unham84(packet[3] as number) << 4) | unham84(packet[2] as number);
      const magazine = (address & 0x07) || 8;
      const row = (address >> 3) & 0x1f;
      const data = packet.subarray(4, 44);
      if (unham84(packet[2] as number) === 0xff || unham84(packet[3] as number) === 0xff) {
        cursor = end;
        continue;
      }

      if (row === 0) {
        const control = decodeControlBits(data);
        const page = (safeNibble(data[1] as number) << 4) | safeNibble(data[0] as number);
        // C6 is the authoritative subtitle flag. Data unit 0x03 merely marks a
        // subtitle service and can also carry associated pages such as NOS
        // page 1:99, so it must not classify a page on its own.
        const subtitle = control.subtitle;
        currentPage.set(magazine, page);
        currentSubtitle.set(magazine, subtitle);
        currentSubset.set(magazine, control.nationalSubset);
        packets.push({
          magazine,
          page,
          row,
          text: '',
          subtitle,
          subset: control.nationalSubset,
          unitId,
          control,
        });
      } else if (row >= 1 && row <= 23) {
        const page = currentPage.get(magazine) ?? -1;
        const subtitle = currentSubtitle.get(magazine) ?? false;
        const subset = currentSubset.get(magazine) ?? 0;
        if (subtitle) subtitlePackets += 1;
        packets.push({
          magazine,
          page,
          row,
          text: decodeTeletextRow(data, subset),
          subtitle,
          subset,
          unitId,
          raw: data.slice(),
        });
      } else if (row === 26) {
        const page = currentPage.get(magazine) ?? -1;
        if (page >= 0) {
          packets.push({
            magazine,
            page,
            row,
            text: '',
            subtitle: currentSubtitle.get(magazine) ?? false,
            subset: currentSubset.get(magazine) ?? 0,
            unitId,
            triplets: parseTriplets(data),
            designation: safeNibble(data[0] as number),
          });
        }
      } else if (row === 27 || row === 28) {
        const page = currentPage.get(magazine) ?? -1;
        if (page >= 0) {
          const designation = safeNibble(data[0] as number);
          const common = {
            magazine,
            page,
            row,
            text: '',
            subtitle: currentSubtitle.get(magazine) ?? false,
            subset: currentSubset.get(magazine) ?? 0,
            unitId,
          };
          if (row === 27 && designation <= 3) {
            packets.push({
              ...common,
              links: parsePageLinks(data, magazine, 'flof'),
            });
          } else if (row === 28 && (designation === 0 || designation === 4)) {
            const functionBits = unham24(data, 1) & 0x0f;
            packets.push({
              ...common,
              navigation: {
                flof: false,
                top: functionBits === 1 || functionBits === 2,
                fastext: false,
                level: 2.5,
              },
            });
          }
        }
      }
      // Rows 24-25 and 29-31 carry other enhancement data, not display text.
    }

    cursor = end;
  }

  return { dataIdentifier, packets, subtitlePackets };
}

export interface TeletextPage {
  magazine: number;
  page: number;
  /** Page number as displayed, for example "1:00". */
  label: string;
  subtitle: boolean;
  rows: string[];
  /** Row numbers (1-23) aligned with `rows`. */
  rowNumbers: number[];
  /** Raw 40-byte row data aligned with `rows`, for colour rendering. */
  rowData: Array<Uint8Array | undefined>;
  /** National option subset used for accented characters. */
  subset: number;
  /** Page header control bits for the current transmission. */
  control?: TeletextControlBits;
  text: string;
  /** Timestamp of the page header, when collected across PES packets. */
  startTime?: number;
  /** Timestamp of the latest row update / completed snapshot. */
  updateTime?: number;
  /** Fastext / TOP page links. */
  links?: TeletextPageLink[];
  /** Enhancement level and navigation facilities. */
  navigation?: TeletextNavigation;
  /** X/26 enhancement triplets grouped by designation. */
  enhancements?: Array<{ designation: number; triplets: TeletextTriplet[] }>;
}

function pageLabel(magazine: number, page: number): string {
  return `${magazine}:${page.toString(16).padStart(2, '0')}`.toUpperCase();
}

function renderedPage(
  magazine: number,
  page: number,
  subtitle: boolean,
  rows: Array<{ text: string; raw?: Uint8Array } | undefined>,
  subset: number,
  control: TeletextControlBits | undefined,
  startTime?: number,
  updateTime?: number,
  links?: TeletextPageLink[],
  navigation?: TeletextNavigation,
  enhancements?: Array<{ designation: number; triplets: TeletextTriplet[] }>,
): TeletextPage {
  const values: Array<{ row: number; text: string; raw?: Uint8Array }> = [];
  rows.forEach((row, index) => {
    if (row !== undefined) values.push({ row: index, ...row });
  });
  // Rows can arrive before the page header in the same transmission. Decode
  // them again with the final national option subset so Italian/French/etc.
  // accented characters are correct even when the first subset was unknown.
  const displayText = (row: { text: string; raw?: Uint8Array }): string =>
    row.raw !== undefined ? decodeTeletextRow(row.raw, subset) : row.text;
  return {
    magazine,
    page,
    label: pageLabel(magazine, page),
    subtitle,
    rows: values.map((row) => displayText(row)),
    rowNumbers: values.map((row) => row.row),
    rowData: values.map((row) => row.raw),
    subset,
    ...(control !== undefined ? { control } : {}),
    text: values
      .map((row) => displayText(row))
      .filter((row) => row.trim().length > 0)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    ...(startTime !== undefined ? { startTime } : {}),
    ...(updateTime !== undefined ? { updateTime } : {}),
    ...(links !== undefined && links.length > 0 ? { links } : {}),
    ...(navigation !== undefined ? { navigation } : {}),
    ...(enhancements !== undefined && enhancements.length > 0 ? { enhancements } : {}),
  };
}

interface PageState {
  magazine: number;
  page: number;
  subtitle: boolean;
  subset: number;
  control?: TeletextControlBits;
  rows: Array<{ text: string; raw?: Uint8Array } | undefined>;
  startTime?: number;
  updateTime?: number;
  /** Fastext / TOP page links. */
  links?: TeletextPageLink[];
  /** Enhancement level and navigation facilities. */
  navigation?: TeletextNavigation;
  /** X/26 enhancement triplets grouped by designation. */
  enhancements: Array<{ designation: number; triplets: TeletextTriplet[] }>;
  /** Whether the rows changed since the last snapshot. */
  dirty: boolean;
  /** Text of the last emitted snapshot, to suppress exact repeats. */
  emittedText?: string;
}

/**
 * Collects pages across PES packets, keeping the decoder's page memory.
 *
 * A page transmission ends at the next header with a different page number in
 * the same magazine, but its rows are retained until a header with C4 (erase
 * page) set starts a fresh transmission. Repeated headers with C4 clear update
 * rows in place instead of splitting the page into separate cues.
 */
export class TeletextCollector {
  private readonly pages = new Map<string, PageState>();
  private readonly current = new Map<number, string>();
  private readonly order: string[] = [];

  push(pes: TeletextPes, timeSec?: number): TeletextPage[] {
    const completed: TeletextPage[] = [];
    for (const packet of pes.packets) {
      if (packet.row === 0) {
        if (packet.page < 0) continue;
        const key = `${packet.magazine}:${packet.page}`;
        const previousKey = this.current.get(packet.magazine);
        const previous = previousKey !== undefined ? this.pages.get(previousKey) : undefined;
        const samePage = previousKey === key;
        const erase = packet.control?.erasePage ?? false;

        // A repeated header for the same page with C4 clear is an in-place
        // update; keep the page open instead of emitting a partial snapshot.
        if (previous !== undefined && (!samePage || erase)) {
          const snapshot = this.snapshot(previous, previous.updateTime ?? timeSec);
          if (snapshot) completed.push(snapshot);
        }

        let state = this.pages.get(key);
        if (!state) {
          state = {
            magazine: packet.magazine,
            page: packet.page,
            subtitle: packet.subtitle,
            subset: packet.subset,
            rows: [],
            enhancements: [],
            dirty: false,
            ...(packet.control !== undefined ? { control: packet.control } : {}),
            ...(timeSec !== undefined
              ? { startTime: timeSec, updateTime: timeSec }
              : {}),
          };
          this.pages.set(key, state);
          this.order.push(key);
        } else {
          if (erase) {
            state.rows = [];
            state.enhancements = [];
            state.links = undefined;
            state.dirty = true;
            state.emittedText = undefined;
            if (timeSec !== undefined) {
              state.startTime = timeSec;
              state.updateTime = timeSec;
            }
          }
          state.subtitle = packet.subtitle;
          state.subset = packet.subset;
          if (packet.control !== undefined) state.control = packet.control;
        }
        this.current.set(packet.magazine, key);
      } else {
        const key = this.current.get(packet.magazine);
        if (key === undefined) continue;
        const state = this.pages.get(key);
        if (!state) continue;
        if (packet.row === 26) {
          if (packet.triplets !== undefined && packet.triplets.length > 0) {
            state.enhancements.push({
              designation: packet.designation ?? 0,
              triplets: packet.triplets,
            });
            const navigation = state.navigation ?? {
              flof: false,
              top: false,
              fastext: false,
              level: 1 as const,
            };
            state.navigation = {
              ...navigation,
              level: navigation.level === 2.5 ? 2.5 : 1.5,
            };
            state.dirty = true;
            state.emittedText = undefined;
          }
          continue;
        }
        if (packet.row === 27) {
          if (packet.links !== undefined && packet.links.length > 0) {
            const top = state.navigation?.top ?? false;
            state.links = packet.links.map((link) => ({ ...link, kind: top ? 'top' : 'flof' }));
            const navigation = state.navigation ?? {
              flof: false,
              top: false,
              fastext: false,
              level: 1 as const,
            };
            state.navigation = {
              ...navigation,
              flof: true,
              fastext: true,
              level: navigation.level === 2.5 ? 2.5 : 1.5,
            };
            state.dirty = true;
            state.emittedText = undefined;
          }
          continue;
        }
        if (packet.row === 28) {
          if (packet.navigation !== undefined) {
            const navigation = state.navigation ?? {
              flof: false,
              top: false,
              fastext: false,
              level: 1 as const,
            };
            state.navigation = {
              ...navigation,
              top: navigation.top || packet.navigation.top,
              level: 2.5,
            };
            state.dirty = true;
            state.emittedText = undefined;
          }
          continue;
        }
        if (!isDisplayText(packet.text)) continue;
        const existing = state.rows[packet.row];
        if (existing?.text === packet.text) continue;
        state.rows[packet.row] = {
          text: packet.text,
          ...(packet.raw !== undefined ? { raw: packet.raw } : {}),
        };
        state.dirty = true;
        if (timeSec !== undefined) state.updateTime = timeSec;
      }
    }
    return completed;
  }

  flush(): TeletextPage[] {
    const result: TeletextPage[] = [];
    for (const key of this.order) {
      const state = this.pages.get(key);
      if (!state) continue;
      const snapshot = this.snapshot(state, state.updateTime);
      if (snapshot) result.push(snapshot);
    }
    return result;
  }

  private snapshot(state: PageState, updateTime?: number): TeletextPage | undefined {
    if (!state.dirty || !state.rows.some((row) => row !== undefined)) return undefined;
    const page = renderedPage(
      state.magazine,
      state.page,
      state.subtitle,
      state.rows,
      state.subset,
      state.control,
      state.startTime,
      updateTime ?? state.updateTime,
      state.navigation?.top && state.links !== undefined
        ? state.links.map((link) => ({ ...link, kind: 'top' as const }))
        : state.links,
      state.navigation,
      state.enhancements,
    );
    state.dirty = false;
    if (page.text === state.emittedText) return undefined;
    state.emittedText = page.text;
    return page;
  }
}

/**
 * True when a decoded row looks like display text rather than control data.
 *
 * Short subtitle lines such as "Ja, in 2012" are valid, so this only rejects
 * rows whose characters are mostly non-printable or mosaic blocks.
 */
function isDisplayText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const printable = (trimmed.match(/[\x20-\x7e\u00a0-\u024f]/g) ?? []).length;
  if (printable / trimmed.length < 0.6) return false;
  return /[A-Za-z0-9\u00c0-\u024f]/.test(trimmed);
}

/** Group the packets of one PES into pages and render their text rows. */
export function collectTeletextPages(pes: TeletextPes): TeletextPage[] {
  const collector = new TeletextCollector();
  const pages = collector.push(pes);
  pages.push(...collector.flush());
  return pages.filter((page) => page.rows.length > 0);
}
