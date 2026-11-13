/**
 * BIOP (Broadcast Inter-ORB Protocol) parsing for DVB object carousels.
 *
 * The wire format follows ISO/IEC 13818-6 clause 8.12 as restricted by
 * ETSI TS 102 812 (MHP) Annex B.2.3. Parsing is deliberately defensive:
 * carousels in the wild contain a mix of well formed and truncated messages,
 * so any structural problem yields `undefined` and the caller keeps what it
 * had instead of failing the whole analysis.
 */

import { readU16, readU32 } from '../util/bytes.js';

export const BIOP_MAGIC = 0x42494f50; // "BIOP"
export const TAG_BIOP = 0x49534f06;
export const TAG_LITE_OPTIONS = 0x49534f05;
export const TAG_OBJECT_LOCATION = 0x49534f50; // "ISOP"
export const TAG_CONN_BINDER = 0x49534f40; // "ISO@"
export const TAG_SERVICE_LOCATION = 0x49534f46; // "ISOF"

export type BiopKind =
  | 'file'
  | 'directory'
  | 'service-gateway'
  | 'stream'
  | 'stream-event'
  | 'unknown';

export interface BiopObjectLocation {
  carouselId: number;
  moduleId: number;
  /** Printable object key with trailing NUL bytes removed. */
  objectKey: string;
  /** Exact key bytes as uppercase hex, used for identity matching. */
  objectKeyHex: string;
}

export interface BiopTap {
  id: number;
  use: number;
  assocTag: number;
  transactionId?: number;
  timeout?: number;
}

export interface BiopServiceLocation {
  carouselId?: number;
  transportStreamId?: number;
  originalNetworkId?: number;
  serviceId?: number;
  /** Object path carried as a CORBA CosNaming name. */
  path?: string[];
}

export interface BiopProfile {
  profileId: number;
  location?: BiopObjectLocation;
  serviceLocation?: BiopServiceLocation;
  taps: BiopTap[];
}

export interface BiopIor {
  /** Short object kind alias, e.g. "dir", "fil", "srg". */
  typeId: string;
  profiles: BiopProfile[];
}

export interface BiopBinding {
  /** Binding name (the directory entry name). */
  name: string;
  /** Name component kind alias, usually the target object kind. */
  kind?: string;
  /** 1 = nobject (file/stream), 2 = ncontext (directory). */
  type: number;
  ior?: BiopIor;
  contentSize?: number;
  contentType?: string;
}

export interface BiopMessage {
  kind: BiopKind;
  objectKind: string;
  objectKey: string;
  objectKeyHex: string;
  /** Total message bytes including the 12-byte message header. */
  length: number;
  /** DSM::File::ContentSize announced in the objectInfo field. */
  contentSize?: number;
  contentType?: string;
  /** Directory and service gateway bindings. */
  bindings?: BiopBinding[];
  /** Stream taps. */
  taps?: BiopTap[];
  contentLength?: number;
  content?: Uint8Array;
}

const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_BINDINGS = 4096;
const MAX_NAME_BYTES = 1024;

function byte(data: Uint8Array, offset: number): number {
  return data[offset] ?? 0;
}

function u64(data: Uint8Array, offset: number): number {
  const high = readU32(data, offset);
  const low = readU32(data, offset + 4);
  // Sizes above 2^53 lose precision, but such an object cannot be exported
  // anyway; the clamped value stays monotonic for display.
  return high * 0x1_0000_0000 + low;
}

/** Decode a CORBA/CDR-Lite string body (length prefix already consumed). */
function cdrString(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  let text = '';
  for (let index = 0; index < end; index += 1) {
    const value = bytes[index] as number;
    if (value >= 0x20 && value <= 0x7e) text += String.fromCharCode(value);
    else text += '\u00b7';
  }
  return text;
}

function hexBytes(bytes: Uint8Array): string {
  let text = '';
  for (const value of bytes) text += value.toString(16).padStart(2, '0').toUpperCase();
  return text;
}

function kindOf(objectKind: string): BiopKind {
  switch (objectKind) {
    case 'fil':
      return 'file';
    case 'dir':
      return 'directory';
    case 'srg':
      return 'service-gateway';
    case 'str':
      return 'stream';
    case 'ste':
      return 'stream-event';
    default:
      return 'unknown';
  }
}

interface Cursor {
  data: Uint8Array;
  pos: number;
  end: number;
}

function need(cursor: Cursor, count: number): boolean {
  return count >= 0 && cursor.pos + count <= cursor.end;
}

function readTap(cursor: Cursor): BiopTap | undefined {
  if (!need(cursor, 7)) return undefined;
  const id = readU16(cursor.data, cursor.pos);
  const use = readU16(cursor.data, cursor.pos + 2);
  const assocTag = readU16(cursor.data, cursor.pos + 4);
  const selectorLength = byte(cursor.data, cursor.pos + 6);
  cursor.pos += 7;
  const tap: BiopTap = { id, use, assocTag };
  if (use === 0x0016 && selectorLength >= 0x0a && need(cursor, 0x0a)) {
    // BIOP_DELIVERY_PARA_USE selector: selector_type, transactionId, timeout.
    if (readU16(cursor.data, cursor.pos) === 0x0001) {
      tap.transactionId = readU32(cursor.data, cursor.pos + 2);
      tap.timeout = readU32(cursor.data, cursor.pos + 6);
    }
  }
  cursor.pos += selectorLength;
  if (cursor.pos > cursor.end) return undefined;
  return tap;
}

function readTaps(cursor: Cursor): BiopTap[] | undefined {
  if (!need(cursor, 1)) return undefined;
  const count = byte(cursor.data, cursor.pos);
  cursor.pos += 1;
  const taps: BiopTap[] = [];
  for (let index = 0; index < count; index += 1) {
    const tap = readTap(cursor);
    if (!tap) return undefined;
    taps.push(tap);
  }
  return taps;
}

function readServiceLocation(bytes: Uint8Array): BiopServiceLocation {
  const location: BiopServiceLocation = {};
  const cursor: Cursor = { data: bytes, pos: 0, end: bytes.length };
  if (!need(cursor, 1)) return location;
  const domainLength = byte(cursor.data, cursor.pos);
  cursor.pos += 1;
  if (domainLength >= 20 && need(cursor, 20)) {
    // DVB carousel NSAP address: AFI(1), type(1), carouselId(4), OUI
    // specifier(4), TSID(2), ONID(2), serviceId(2), reserved(4).
    const domain = bytes.subarray(cursor.pos, cursor.pos + 20);
    location.carouselId = readU32(domain, 2);
    location.transportStreamId = readU16(domain, 10);
    location.originalNetworkId = readU16(domain, 12);
    location.serviceId = readU16(domain, 14);
  }
  cursor.pos += domainLength;

  if (!need(cursor, 4)) return location;
  const nameCount = readU32(cursor.data, cursor.pos);
  cursor.pos += 4;
  if (nameCount > 64) return location;
  const path: string[] = [];
  for (let index = 0; index < nameCount; index += 1) {
    if (!need(cursor, 4)) return location;
    const idLength = readU32(cursor.data, cursor.pos);
    cursor.pos += 4;
    if (idLength > MAX_NAME_BYTES || !need(cursor, idLength)) return location;
    path.push(cdrString(cursor.data.subarray(cursor.pos, cursor.pos + idLength)));
    cursor.pos += idLength;
    if (!need(cursor, 4)) return location;
    const kindLength = readU32(cursor.data, cursor.pos);
    cursor.pos += 4;
    if (kindLength > MAX_NAME_BYTES || !need(cursor, kindLength)) return location;
    cursor.pos += kindLength;
  }
  location.path = path;
  return location;
}

function readProfileBody(profileId: number, bytes: Uint8Array): BiopProfile {
  const profile: BiopProfile = { profileId, taps: [] };
  const cursor: Cursor = { data: bytes, pos: 0, end: bytes.length };
  if (!need(cursor, 2)) return profile;
  cursor.pos += 1; // byte_order
  const componentCount = byte(cursor.data, cursor.pos);
  cursor.pos += 1;

  for (let index = 0; index < componentCount; index += 1) {
    if (!need(cursor, 5)) break;
    const tag = readU32(cursor.data, cursor.pos);
    const length = byte(cursor.data, cursor.pos + 4);
    cursor.pos += 5;
    if (!need(cursor, length)) break;
    const component = bytes.subarray(cursor.pos, cursor.pos + length);

    if (tag === TAG_OBJECT_LOCATION && component.length >= 9) {
      const keyLength = byte(component, 8);
      const keyBytes = component.subarray(9, 9 + keyLength);
      profile.location = {
        carouselId: readU32(component, 0),
        moduleId: readU16(component, 4),
        objectKey: cdrString(keyBytes),
        objectKeyHex: hexBytes(keyBytes),
      };
    } else if (tag === TAG_CONN_BINDER) {
      const tapCursor: Cursor = { data: component, pos: 0, end: component.length };
      const taps = readTaps(tapCursor);
      if (taps) profile.taps = taps;
    } else if (tag === TAG_SERVICE_LOCATION && component.length >= 1) {
      profile.serviceLocation = readServiceLocation(component);
    }
    cursor.pos += length;
  }
  return profile;
}

interface ParsedIor {
  ior: BiopIor;
  next: number;
}

/**
 * Parse an IOR and report where it ends. Returns undefined when the reference
 * is truncated or uses an implausible layout.
 */
function parseIorAt(data: Uint8Array, offset: number, end = data.length): ParsedIor | undefined {
  const cursor: Cursor = { data, pos: offset, end };
  if (!need(cursor, 8)) return undefined;
  const typeIdLength = readU32(cursor.data, cursor.pos);
  cursor.pos += 4;
  if (typeIdLength === 0 || typeIdLength > 16 || !need(cursor, typeIdLength)) return undefined;
  const typeId = cdrString(cursor.data.subarray(cursor.pos, cursor.pos + typeIdLength));
  cursor.pos += typeIdLength;

  if (!need(cursor, 4)) return undefined;
  const profileCount = readU32(cursor.data, cursor.pos);
  cursor.pos += 4;
  if (profileCount === 0 || profileCount > 16) return undefined;

  const profiles: BiopProfile[] = [];
  for (let index = 0; index < profileCount; index += 1) {
    if (!need(cursor, 8)) return undefined;
    const profileId = readU32(cursor.data, cursor.pos);
    const profileLength = readU32(cursor.data, cursor.pos + 4);
    cursor.pos += 8;
    if (profileLength > MAX_MESSAGE_BYTES || !need(cursor, profileLength)) return undefined;
    const profileBytes = data.subarray(cursor.pos, cursor.pos + profileLength);
    if (profileId === TAG_BIOP || profileId === TAG_LITE_OPTIONS) {
      profiles.push(readProfileBody(profileId, profileBytes));
    } else {
      profiles.push({ profileId, taps: [] });
    }
    cursor.pos += profileLength;
  }
  return { ior: { typeId, profiles }, next: cursor.pos };
}

/** Parse an IOR without reporting its encoded length. */
export function parseIor(data: Uint8Array, offset: number, end = data.length): BiopIor | undefined {
  return parseIorAt(data, offset, end)?.ior;
}

function contentTypeDescriptor(descriptors: Uint8Array): string | undefined {
  let pos = 0;
  while (pos + 2 <= descriptors.length) {
    const tag = descriptors[pos] as number;
    const length = descriptors[pos + 1] as number;
    const start = pos + 2;
    if (start + length > descriptors.length) return undefined;
    if (tag === 0x72) {
      let text = '';
      for (let index = start; index < start + length; index += 1) {
        const value = descriptors[index] as number;
        if (value >= 0x20 && value <= 0x7e) text += String.fromCharCode(value);
      }
      if (text.length > 0) return text;
    }
    pos = start + length;
  }
  return undefined;
}

function readBinding(cursor: Cursor): BiopBinding | undefined {
  if (!need(cursor, 1)) return undefined;
  const componentCount = byte(cursor.data, cursor.pos);
  cursor.pos += 1;
  let name = '';
  let kind: string | undefined;
  for (let index = 0; index < componentCount; index += 1) {
    if (!need(cursor, 1)) return undefined;
    const idLength = byte(cursor.data, cursor.pos);
    cursor.pos += 1;
    if (idLength > MAX_NAME_BYTES || !need(cursor, idLength)) return undefined;
    const id = cdrString(cursor.data.subarray(cursor.pos, cursor.pos + idLength));
    cursor.pos += idLength;
    if (!need(cursor, 1)) return undefined;
    const kindLength = byte(cursor.data, cursor.pos);
    cursor.pos += 1;
    if (kindLength > MAX_NAME_BYTES || !need(cursor, kindLength)) return undefined;
    if (index === 0) {
      kind = cdrString(cursor.data.subarray(cursor.pos, cursor.pos + kindLength));
    }
    cursor.pos += kindLength;
    if (index === 0) name = id;
  }

  if (!need(cursor, 1)) return undefined;
  const bindingType = byte(cursor.data, cursor.pos);
  cursor.pos += 1;

  const parsed = parseIorAt(cursor.data, cursor.pos, cursor.end);
  if (!parsed) return undefined;
  cursor.pos = parsed.next;

  const binding: BiopBinding = {
    name,
    type: bindingType,
    ior: parsed.ior,
    ...(kind !== undefined ? { kind } : {}),
  };

  if (!need(cursor, 2)) return binding;
  const infoLength = readU16(cursor.data, cursor.pos);
  cursor.pos += 2;
  if (infoLength > 0) {
    if (!need(cursor, infoLength)) return undefined;
    const info = cursor.data.subarray(cursor.pos, cursor.pos + infoLength);
    if (info.length >= 8) binding.contentSize = u64(info, 0);
    if (info.length >= 10) binding.contentType = contentTypeDescriptor(info.subarray(8));
    cursor.pos += infoLength;
  }
  return binding;
}

/**
 * Parse one BIOP message starting at `offset`. `length` in the result is the
 * total size so callers can walk message sequences inside a module.
 */
export function parseBiopMessage(
  data: Uint8Array,
  offset: number,
  end = data.length,
): BiopMessage | undefined {
  if (offset + 12 > end) return undefined;
  if (readU32(data, offset) !== BIOP_MAGIC) return undefined;
  const messageSize = readU32(data, offset + 8);
  if (messageSize > MAX_MESSAGE_BYTES) return undefined;
  const total = 12 + messageSize;
  if (offset + total > end) return undefined;

  const cursor: Cursor = { data, pos: offset + 12, end: offset + total };
  if (!need(cursor, 1)) return undefined;
  const keyLength = byte(cursor.data, cursor.pos);
  cursor.pos += 1;
  if (keyLength > 16 || !need(cursor, keyLength)) return undefined;
  const keyBytes = cursor.data.subarray(cursor.pos, cursor.pos + keyLength);
  cursor.pos += keyLength;

  if (!need(cursor, 4)) return undefined;
  const kindLength = readU32(cursor.data, cursor.pos);
  cursor.pos += 4;
  if (kindLength > 16 || !need(cursor, kindLength)) return undefined;
  const objectKind = cdrString(cursor.data.subarray(cursor.pos, cursor.pos + kindLength));
  cursor.pos += kindLength;

  const message: BiopMessage = {
    kind: kindOf(objectKind),
    objectKind,
    objectKey: cdrString(keyBytes),
    objectKeyHex: hexBytes(keyBytes),
    length: total,
  };

  if (!need(cursor, 2)) return message;
  const objectInfoLength = readU16(cursor.data, cursor.pos);
  cursor.pos += 2;
  if (!need(cursor, objectInfoLength)) return undefined;
  if (objectInfoLength > 0) {
    const info = cursor.data.subarray(cursor.pos, cursor.pos + objectInfoLength);
    if (info.length >= 8) message.contentSize = u64(info, 0);
    if (info.length >= 10) message.contentType = contentTypeDescriptor(info.subarray(8));
    cursor.pos += objectInfoLength;
  }

  if (!need(cursor, 1)) return message;
  const contextCount = byte(cursor.data, cursor.pos);
  cursor.pos += 1;
  for (let index = 0; index < contextCount; index += 1) {
    if (!need(cursor, 6)) return message;
    const dataLength = readU16(cursor.data, cursor.pos + 4);
    cursor.pos += 6;
    if (!need(cursor, dataLength)) return message;
    cursor.pos += dataLength;
  }

  if (!need(cursor, 4)) return message;
  const bodyLength = readU32(cursor.data, cursor.pos);
  cursor.pos += 4;
  // messageBodyLength counts everything after the field itself.
  if (bodyLength > cursor.end - cursor.pos) return message;
  const bodyEnd = cursor.pos + bodyLength;

  if (message.kind === 'file') {
    if (bodyLength < 4) return message;
    const contentLength = readU32(cursor.data, cursor.pos);
    const contentStart = cursor.pos + 4;
    const available = Math.min(contentLength, bodyEnd - contentStart);
    message.contentLength = contentLength;
    if (available > 0)
      message.content = cursor.data.subarray(contentStart, contentStart + available);
    return message;
  }

  if (message.kind === 'directory' || message.kind === 'service-gateway') {
    if (bodyLength < 2) return message;
    const bindingsCount = readU16(cursor.data, cursor.pos);
    cursor.pos += 2;
    const bindings: BiopBinding[] = [];
    for (let index = 0; index < bindingsCount && index < MAX_BINDINGS; index += 1) {
      const binding = readBinding(cursor);
      if (!binding) break;
      bindings.push(binding);
    }
    message.bindings = bindings;
    return message;
  }

  if (message.kind === 'stream' || message.kind === 'stream-event') {
    const taps = readTaps(cursor);
    if (taps) message.taps = taps;
    return message;
  }

  return message;
}
