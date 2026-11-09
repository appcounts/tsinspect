import type { DescriptorInfo } from '../model/types.js';
import { hex, readU16, readU8 } from '../util/bytes.js';
import { decodeAribString } from './arib-string.js';
import { descriptorName } from './names.js';
import { decodeDvbString } from './dvb-string.js';
import { DESCRIPTOR_HANDLERS, type DescriptorContext } from './registry.js';

export { descriptorName } from './names.js';
export { iso6937G2 } from './dvb-string.js';
export { decodeDvbString };

/** Text decoding rules used by the service/EPG descriptors of a standard. */
export type TextEncoding = 'dvb' | 'arib' | 'sbtvd';

export interface RawDescriptor {
  tag: number;
  length: number;
  data: Uint8Array;
}

export function parseRawDescriptors(data: Uint8Array, start: number, length: number): RawDescriptor[] {
  const descriptors: RawDescriptor[] = [];
  const end = Math.min(data.length, start + length);
  let cursor = start;

  while (cursor + 2 <= end) {
    const tag = readU8(data, cursor);
    const descLength = readU8(data, cursor + 1);
    if (cursor + 2 + descLength > end) break;
    descriptors.push({
      tag,
      length: descLength,
      data: data.subarray(cursor + 2, cursor + 2 + descLength),
    });
    cursor += 2 + descLength;
  }

  return descriptors;
}

/** One event entry of an ISDB emergency_information_descriptor (tag 0xFC). */
export interface EmergencyInformationEvent {
  serviceId: number;
  started: boolean;
  /** 0 = first-level (EWBS) signal, 1 = second-level signal. */
  signalLevel: number;
  areaCodes: number[];
}

/**
 * Parse the ISDB emergency_information_descriptor used by EWBS
 * (ARIB STD-B10, 6.2.24).
 */
export function parseEmergencyInformationDescriptor(
  data: Uint8Array,
): EmergencyInformationEvent[] {
  const events: EmergencyInformationEvent[] = [];
  let cursor = 0;
  while (cursor + 4 <= data.length) {
    const serviceId = readU16(data, cursor);
    const flags = readU8(data, cursor + 2);
    cursor += 3;
    const areaLength = readU8(data, cursor);
    cursor += 1;
    const end = Math.min(data.length, cursor + areaLength);
    const areaCodes: number[] = [];
    while (cursor + 2 <= end) {
      areaCodes.push(readU16(data, cursor) >> 4);
      cursor += 2;
    }
    cursor = end;
    events.push({
      serviceId,
      started: (flags & 0x80) !== 0,
      signalLevel: (flags & 0x40) >> 6,
      areaCodes,
    });
  }
  return events;
}

export function describeDescriptor(
  raw: RawDescriptor,
  textEncoding: TextEncoding = 'dvb',
): DescriptorInfo {
  const d = raw.data;
  const fields: Record<string, string | number | boolean> = {};
  const decodeText =
    textEncoding === 'arib'
      ? (value: Uint8Array): string => decodeAribString(value)
      : textEncoding === 'sbtvd'
        ? (value: Uint8Array): string => decodeAribString(value, { profile: 'brazil' })
        : (value: Uint8Array): string => decodeDvbString(value);

  const context: DescriptorContext = { decodeText, readU32, readBits };
  const handler = DESCRIPTOR_HANDLERS[raw.tag];
  if (handler !== undefined) {
    Object.assign(fields, handler(raw, d, context));
  } else {
    switch (raw.tag) {
      case 0xfc: {
        // ISDB emergency information descriptor (ARIB STD-B10, 6.2.24).
        const events = parseEmergencyInformationDescriptor(d);
        if (events.length > 0) {
          const first = events[0] as EmergencyInformationEvent;
          fields.serviceId = first.serviceId;
          fields.ewbsStarted = events.some((event) => event.started);
          fields.signalLevel = first.signalLevel;
          fields.areaCodes = first.areaCodes
            .map((code) => `0x${code.toString(16).padStart(3, '0').toUpperCase()}`)
            .join(', ');
          fields.events = events.length;
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    tag: raw.tag,
    tagHex: `0x${raw.tag.toString(16).padStart(2, '0').toUpperCase()}`,
    length: raw.length,
    name:
      raw.tag === 0x7f && fields.extensionTag === 0x15
        ? 'AC-4'
        : raw.tag === 0x7f && fields.extensionTag === 0x06
          ? 'Supplementary audio'
          : raw.tag === 0x7f && fields.extensionTag === 0x19
            ? 'Audio preselection'
            : descriptorName(raw.tag),
    raw: hex(d),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };
}

export function describeDescriptors(
  raw: RawDescriptor[],
  textEncoding: TextEncoding = 'dvb',
): DescriptorInfo[] {
  return raw.map((descriptor) => describeDescriptor(descriptor, textEncoding));
}

function readU32(data: Uint8Array, offset: number): number {
  return (
    readU8(data, offset) * 0x1000000 +
    (readU8(data, offset + 1) << 16) +
    (readU8(data, offset + 2) << 8) +
    readU8(data, offset + 3)
  );
}

function readBits(data: Uint8Array, bitOffset: number, count: number): number {
  let value = 0;
  for (let i = 0; i < count; i += 1) {
    const position = bitOffset + i;
    const byte = readU8(data, position >> 3);
    value = value * 2 + ((byte >> (7 - (position & 7))) & 1);
  }
  return value;
}

