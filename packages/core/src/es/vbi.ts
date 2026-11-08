import { hex } from '../util/bytes.js';

/**
 * DVB VBI data in PES (ETSI EN 300 472).
 *
 * VBI PES packets start with a data_identifier (0x10-0x1F) and carry
 * data_units. Teletext units (0x02/0x03) are shared with the Teletext parser;
 * VPS (0x04), WSS (0x05), closed caption (0x06) and monochrome samples
 * (0x07) are indexed with their raw payload.
 */

export interface VbiUnit {
  id: number;
  name: string;
  length: number;
  raw: string;
  /** WSS: aspect ratio code when the unit is 2 bytes. */
  aspectRatio?: number;
  /** VPS: programme source when the unit is at least one byte. */
  programmeSource?: number;
}

export interface VbiPes {
  dataIdentifier: number;
  units: VbiUnit[];
}

export function vbiUnitName(id: number): string {
  switch (id) {
    case 0x02:
      return 'Teletext (non-subtitle)';
    case 0x03:
      return 'Teletext (subtitle)';
    case 0x04:
      return 'VPS';
    case 0x05:
      return 'WSS';
    case 0x06:
      return 'Closed caption';
    case 0x07:
      return 'Monochrome 4:2:2';
    case 0xff:
      return 'Stuffing';
    default:
      return `Data unit 0x${id.toString(16).padStart(2, '0').toUpperCase()}`;
  }
}

export function parseVbiPes(payload: Uint8Array): VbiPes | null {
  if (payload.length < 2) return null;
  const dataIdentifier = payload[0] as number;
  if (dataIdentifier < 0x10 || dataIdentifier > 0x1f) return null;

  const units: VbiUnit[] = [];
  let cursor = 1;
  while (cursor + 2 <= payload.length) {
    const id = payload[cursor] as number;
    const length = payload[cursor + 1] as number;
    const start = cursor + 2;
    const end = Math.min(payload.length, start + length);
    const data = payload.subarray(start, end);
    units.push({
      id,
      name: vbiUnitName(id),
      length,
      raw: hex(data),
      ...(id === 0x05 && data.length >= 2
        ? { aspectRatio: ((data[0] as number) >> 4) & 0x0f }
        : {}),
      ...(id === 0x04 && data.length >= 1 ? { programmeSource: data[0] as number } : {}),
    });
    cursor = end;
  }

  return { dataIdentifier, units };
}
