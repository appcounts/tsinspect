import { isSectionCrcValid } from '../section/crc32.js';

/**
 * Indonesian Early Warning System carried as private sections in a DVB-T2
 * multiplex (Permen Kominfo No. 3/2014).
 *
 * The EWS PID is signalled as a user-private elementary stream (stream_type
 * 0x80). Its sections use table_id 0x80 and distinguish the three tables with
 * table_id_extension:
 *   0x01 TRDW - region of disaster warning (postal codes + severity level)
 *   0x02 TCDW - disaster code (type, authority, position, date, details)
 *   0x03 TMDW - disaster message (advice text shown on screen)
 */
export const EWS_TABLE_ID = 0x80;

export const EWS_TABLE_TRDW = 0x01;
export const EWS_TABLE_TCDW = 0x02;
export const EWS_TABLE_TMDW = 0x03;

export type EwsTableKind = 'TRDW' | 'TCDW' | 'TMDW';

/** One location code entry of a TRDW section. */
export interface EwsLocation {
  /** Postal code digits (BCD, trailing 0xF padding removed), e.g. "47400". */
  code: string;
  description: string;
}

/** TRDW entry: the disaster warning region for one disaster and severity. */
export interface EwsRegion {
  disasterCode: number;
  /** 0x01 = Awas (caution), 0x02 = Siaga (stand-by), 0x03 = Waspada (alert). */
  locationTypeCode: number;
  packageId: number;
  locations: EwsLocation[];
}

/** TCDW entry: the disaster code description. */
export interface EwsDisaster {
  packageId: number;
  /** 0x01 = BMKG, 0x02 = BNPB. */
  authority: number;
  disasterCode: number;
  name: string;
  position: string;
  date: string;
  characteristic: string;
}

/** TMDW entry: the information message for one severity level. */
export interface EwsMessage {
  locationTypeCode: number;
  packageId: number;
  message: string;
}

export interface EwsSection {
  kind: EwsTableKind;
  tableIdExtension: number;
  version: number;
  sectionNumber: number;
  lastSectionNumber: number;
  regions: EwsRegion[];
  disasters: EwsDisaster[];
  messages: EwsMessage[];
}

const AUTHORITY_NAMES: Record<number, string> = {
  0x01: 'BMKG',
  0x02: 'BNPB',
};

const DISASTER_NAMES: Record<number, string> = {
  0x01: 'Earthquake',
  0x02: 'Tsunami',
  0x03: 'Volcano',
  0x04: 'Land slide',
  0x05: 'Flood',
  0x06: 'Drought',
  0x07: 'Forest fire',
  0x08: 'Erosion',
  0x09: 'Building fire',
  0x0a: 'Extreme wave',
  0x0b: 'Extreme weather',
  0x0c: 'Technology failure',
  0x0d: 'Epidemic disease',
  0x0e: 'Social conflict',
};

export function ewsTableName(tableIdExtension: number): string {
  switch (tableIdExtension) {
    case EWS_TABLE_TRDW:
      return 'EWS TRDW (disaster region)';
    case EWS_TABLE_TCDW:
      return 'EWS TCDW (disaster code)';
    case EWS_TABLE_TMDW:
      return 'EWS TMDW (disaster message)';
    default:
      return 'EWS (Indonesia)';
  }
}

export function ewsAuthorityName(authority: number): string | undefined {
  return AUTHORITY_NAMES[authority];
}

export function ewsDisasterName(disasterCode: number): string | undefined {
  return DISASTER_NAMES[disasterCode];
}

class Reader {
  private cursor: number;

  constructor(
    private readonly data: Uint8Array,
    start: number,
    private readonly end: number,
  ) {
    this.cursor = start;
  }

  get done(): boolean {
    return this.cursor >= this.end;
  }

  get remaining(): number {
    return this.end - this.cursor;
  }

  u8(): number | null {
    if (this.cursor + 1 > this.end) return null;
    const value = this.data[this.cursor] as number;
    this.cursor += 1;
    return value;
  }

  u16(): number | null {
    if (this.cursor + 2 > this.end) return null;
    const value =
      ((this.data[this.cursor] as number) << 8) | (this.data[this.cursor + 1] as number);
    this.cursor += 2;
    return value;
  }

  u24Hex(): string | null {
    if (this.cursor + 3 > this.end) return null;
    const hex = `${(this.data[this.cursor] as number).toString(16).padStart(2, '0')}${(
      this.data[this.cursor + 1] as number
    )
      .toString(16)
      .padStart(2, '0')}${(this.data[this.cursor + 2] as number).toString(16).padStart(2, '0')}`;
    this.cursor += 3;
    return hex;
  }

  text(length: number): string | null {
    if (length < 0 || this.cursor + length > this.end) return null;
    let value = '';
    for (let i = 0; i < length; i += 1) {
      value += String.fromCharCode(this.data[this.cursor + i] as number);
    }
    this.cursor += length;
    return value;
  }
}

/** Decode a 24-bit BCD location code, dropping the trailing 0xF padding. */
function bcdLocation(hex: string): string {
  return hex.replace(/f+$/i, '').toUpperCase() || '0';
}

function parseTrdw(reader: Reader): EwsRegion[] {
  const disasterCode = reader.u16();
  const locationTypeCode = reader.u8();
  const packageId = reader.u8();
  const count = reader.u8();
  if (disasterCode === null || locationTypeCode === null || packageId === null || count === null) {
    return [];
  }
  const locations: EwsLocation[] = [];
  for (let i = 0; i < count; i += 1) {
    const hex = reader.u24Hex();
    const length = reader.u8();
    if (hex === null || length === null) break;
    const description = reader.text(length);
    if (description === null) break;
    locations.push({ code: bcdLocation(hex), description });
  }
  return [{ disasterCode, locationTypeCode, packageId, locations }];
}

function parseTcdw(reader: Reader): EwsDisaster[] {
  const count = reader.u8();
  if (count === null) return [];
  const disasters: EwsDisaster[] = [];
  for (let i = 0; i < count; i += 1) {
    const packageId = reader.u8();
    const authority = reader.u8();
    const disasterCode = reader.u16();
    if (packageId === null || authority === null || disasterCode === null) break;
    const readString = (): string => {
      const length = reader.u8();
      if (length === null) return '';
      return reader.text(length) ?? '';
    };
    disasters.push({
      packageId,
      authority,
      disasterCode,
      name: readString(),
      position: readString(),
      date: readString(),
      characteristic: readString(),
    });
  }
  return disasters;
}

function parseTmdw(reader: Reader): EwsMessage[] {
  const messages: EwsMessage[] = [];
  while (reader.remaining >= 4) {
    const locationTypeCode = reader.u8();
    const packageId = reader.u8();
    const length = reader.u16();
    if (locationTypeCode === null || packageId === null || length === null) break;
    const message = reader.text(length);
    if (message === null) break;
    messages.push({ locationTypeCode, packageId, message });
  }
  return messages;
}

/**
 * Parse one Indonesian EWS private section. Returns null when the section is
 * not an EWS table, is a "next" table, or fails CRC verification.
 */
export function parseEwsSection(data: Uint8Array): EwsSection | null {
  if (data.length < 12) return null;
  const tableId = data[0] as number;
  if (tableId !== EWS_TABLE_ID) return null;
  const b1 = data[1] as number;
  if ((b1 & 0x80) === 0) return null;
  if (3 + (((b1 & 0x0f) << 8) | (data[2] as number)) !== data.length) return null;
  if (!isSectionCrcValid(data)) return null;
  if (((data[5] as number) & 0x01) === 0) return null;

  const tableIdExtension = ((data[3] as number) << 8) | (data[4] as number);
  const version = ((data[5] as number) >> 1) & 0x1f;
  const sectionNumber = data[6] as number;
  const lastSectionNumber = data[7] as number;
  const reader = new Reader(data, 8, data.length - 4);

  switch (tableIdExtension) {
    case EWS_TABLE_TRDW:
      return {
        kind: 'TRDW',
        tableIdExtension,
        version,
        sectionNumber,
        lastSectionNumber,
        regions: parseTrdw(reader),
        disasters: [],
        messages: [],
      };
    case EWS_TABLE_TCDW:
      return {
        kind: 'TCDW',
        tableIdExtension,
        version,
        sectionNumber,
        lastSectionNumber,
        regions: [],
        disasters: parseTcdw(reader),
        messages: [],
      };
    case EWS_TABLE_TMDW:
      return {
        kind: 'TMDW',
        tableIdExtension,
        version,
        sectionNumber,
        lastSectionNumber,
        regions: [],
        disasters: [],
        messages: parseTmdw(reader),
      };
    default:
      return null;
  }
}
