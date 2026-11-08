import { crc32Mpeg2 } from '@tsinspect/core';

export interface SectionOptions {
  tableIdExtension?: number;
  version?: number;
  currentNext?: boolean;
  sectionNumber?: number;
  lastSectionNumber?: number;
  long?: boolean;
  /** Append a CRC (long sections default to true). */
  crc?: boolean;
}

/** Build a PSI/SI section with a correct CRC-32/MPEG-2 trailer. */
export function buildSection(
  tableId: number,
  body: Uint8Array,
  options: SectionOptions = {},
): Uint8Array {
  const isLong = options.long ?? true;
  if (!isLong) {
    const sectionLength = body.length;
    const section = new Uint8Array(3 + sectionLength);
    section[0] = tableId;
    section[1] = 0x30 | ((sectionLength >> 8) & 0x0f);
    section[2] = sectionLength & 0xff;
    section.set(body, 3);
    return section;
  }

  const withCrc = options.crc ?? true;
  const sectionLength = 5 + body.length + (withCrc ? 4 : 0);
  if (sectionLength > 0x3fd) throw new Error('section too long for test helper');

  const section = new Uint8Array(3 + sectionLength);
  section[0] = tableId;
  section[1] = 0xb0 | ((sectionLength >> 8) & 0x0f);
  section[2] = sectionLength & 0xff;

  const extension = options.tableIdExtension ?? 0x0001;
  section[3] = (extension >> 8) & 0xff;
  section[4] = extension & 0xff;

  const version = options.version ?? 0;
  section[5] = 0xc1 | ((version & 0x1f) << 1) | (options.currentNext === false ? 0 : 1);
  section[6] = options.sectionNumber ?? 0;
  section[7] = options.lastSectionNumber ?? 0;

  section.set(body, 8);

  if (withCrc) {
    const crc = crc32Mpeg2(section.subarray(0, section.length - 4));
    const at = section.length - 4;
    section[at] = (crc >>> 24) & 0xff;
    section[at + 1] = (crc >>> 16) & 0xff;
    section[at + 2] = (crc >>> 8) & 0xff;
    section[at + 3] = crc & 0xff;
  }

  return section;
}

export interface PacketOptions {
  pusi?: boolean;
  cc?: number;
  /** 27 MHz PCR value; adds an adaptation field with PCR and no payload. */
  pcrTicks?: number;
  /** Extra bytes between packet start and the sync byte, for 192-byte layouts. */
  prefixLength?: number;
  /** Extra bytes after the 188-byte packet, for 204/208-byte layouts. */
  trailerLength?: number;
}

export function buildPacket(pid: number, payload: Uint8Array, options: PacketOptions = {}): Uint8Array {
  const prefix = options.prefixLength ?? 0;
  const trailer = options.trailerLength ?? 0;
  const packet = new Uint8Array(prefix + 188 + trailer);
  packet.fill(0xff, prefix, prefix + 188);

  const base = prefix;
  packet[base] = 0x47;
  packet[base + 1] = (options.pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
  packet[base + 2] = pid & 0xff;

  if (options.pcrTicks !== undefined) {
    // Adaptation field only (AFC = 2), flags = PCR present, PCR length = 6.
    packet[base + 3] = 0x20 | ((options.cc ?? 0) & 0x0f);
    packet[base + 4] = 7;
    packet[base + 5] = 0x10;
    writePcr(packet, base + 6, options.pcrTicks);
    return packet;
  }

  const maxPayload = 184;
  const data = payload.subarray(0, maxPayload);
  packet[base + 3] = 0x10 | ((options.cc ?? 0) & 0x0f);
  packet.set(data, base + 4);
  return packet;
}

/** Split a section over packets, honouring the pointer_field on the first one. */
export function packetizeSection(
  pid: number,
  section: Uint8Array,
  ccStart = 0,
  options: Omit<PacketOptions, 'pusi' | 'cc' | 'pcrTicks'> = {},
): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let cc = ccStart;
  let first = true;

  while (offset < section.length) {
    const payload = new Uint8Array(184);
    payload.fill(0xff);
    let cursor = 0;
    if (first) {
      payload[cursor] = 0x00; // pointer_field
      cursor += 1;
      first = false;
    }
    const take = Math.min(184 - cursor, section.length - offset);
    payload.set(section.subarray(offset, offset + take), cursor);
    offset += take;
    chunks.push(
      buildPacket(pid, payload, { ...options, pusi: chunks.length === 0, cc }),
    );
    cc = (cc + 1) & 0x0f;
  }

  return chunks;
}

/** ATSC A/65 Multiple String Structure with one uncompressed ASCII segment. */
export function atscMss(text: string): Uint8Array {
  const bytes = [...text].map((character) => character.charCodeAt(0));
  return Uint8Array.from([
    1, // number_of_strings
    0x65, 0x6e, 0x67, // language "eng"
    1, // number_of_segments
    0x00, 0x00, // uncompressed, Unicode range 0x0000
    bytes.length,
    ...bytes,
  ]);
}

/** Minimal MSB-first bit writer for building binary fixtures. */
export class BitWriter {
  private readonly bits: number[] = [];

  write(value: number, count: number): this {
    for (let i = count - 1; i >= 0; i -= 1) {
      this.bits.push((value >> i) & 1);
    }
    return this;
  }

  bit(value: boolean): this {
    this.bits.push(value ? 1 : 0);
    return this;
  }

  get length(): number {
    return this.bits.length;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, index) => {
      const at = index >> 3;
      out[at] = (out[at] as number) | (bit << (7 - (index & 7)));
    });
    return out;
  }
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Encode a UTC time as the 5-byte MJD + BCD representation used by DVB. */
export function dvbDateTimeBytes(unixSeconds: number): Uint8Array {
  const mjd = Math.floor(unixSeconds / 86_400) + 40_587;
  const daySeconds = ((unixSeconds % 86_400) + 86_400) % 86_400;
  const hour = Math.floor(daySeconds / 3600);
  const minute = Math.floor((daySeconds % 3600) / 60);
  const second = daySeconds % 60;
  return new Uint8Array([
    (mjd >> 8) & 0xff,
    mjd & 0xff,
    bcd(hour),
    bcd(minute),
    bcd(second),
  ]);
}

/** Encode a duration as 3-byte BCD hours/minutes/seconds. */
export function dvbDurationBytes(seconds: number): Uint8Array {
  const hour = Math.floor(seconds / 3600);
  const minute = Math.floor((seconds % 3600) / 60);
  const second = seconds % 60;
  return new Uint8Array([bcd(hour), bcd(minute), bcd(second)]);
}

function bcd(value: number): number {
  return ((Math.floor(value / 10) & 0x0f) << 4) | (value % 10);
}

export function patBody(programs: Array<{ programNumber: number; pid: number }>): Uint8Array {
  const body = new Uint8Array(programs.length * 4);
  programs.forEach((program, index) => {
    const at = index * 4;
    body[at] = (program.programNumber >> 8) & 0xff;
    body[at + 1] = program.programNumber & 0xff;
    body[at + 2] = 0xe0 | ((program.pid >> 8) & 0x1f);
    body[at + 3] = program.pid & 0xff;
  });
  return body;
}

export function pmtBody(
  pcrPid: number,
  streams: Array<{ streamType: number; pid: number; descriptors?: Uint8Array }>,
): Uint8Array {
  const parts: Uint8Array[] = [];
  const head = new Uint8Array(4);
  head[0] = 0xe0 | ((pcrPid >> 8) & 0x1f);
  head[1] = pcrPid & 0xff;
  head[2] = 0xf0; // program_info_length = 0
  head[3] = 0x00;
  parts.push(head);

  for (const stream of streams) {
    const descriptors = stream.descriptors ?? new Uint8Array(0);
    const entry = new Uint8Array(5);
    entry[0] = stream.streamType;
    entry[1] = 0xe0 | ((stream.pid >> 8) & 0x1f);
    entry[2] = stream.pid & 0xff;
    entry[3] = 0xf0 | ((descriptors.length >> 8) & 0x0f);
    entry[4] = descriptors.length & 0xff;
    parts.push(entry, descriptors);
  }

  return concat(parts);
}

export function descriptor(tag: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + body.length);
  out[0] = tag;
  out[1] = body.length;
  out.set(body, 2);
  return out;
}

export function serviceDescriptor(serviceType: number, provider: string, name: string): Uint8Array {
  const providerBytes = new TextEncoder().encode(provider);
  const nameBytes = new TextEncoder().encode(name);
  const body = new Uint8Array(3 + providerBytes.length + nameBytes.length);
  body[0] = serviceType;
  body[1] = providerBytes.length;
  body.set(providerBytes, 2);
  body[2 + providerBytes.length] = nameBytes.length;
  body.set(nameBytes, 3 + providerBytes.length);
  return descriptor(0x48, body);
}

export function sdtBody(
  originalNetworkId: number,
  services: Array<{ serviceId: number; name: string; provider?: string; descriptors?: Uint8Array }>,
): Uint8Array {
  const parts: Uint8Array[] = [];
  const head = new Uint8Array(3);
  head[0] = (originalNetworkId >> 8) & 0xff;
  head[1] = originalNetworkId & 0xff;
  head[2] = 0xff;
  parts.push(head);

  for (const service of services) {
    const descriptors =
      service.descriptors ??
      serviceDescriptor(0x01, service.provider ?? 'Provider', service.name);
    const entry = new Uint8Array(5);
    entry[0] = (service.serviceId >> 8) & 0xff;
    entry[1] = service.serviceId & 0xff;
    entry[2] = 0xff; // EIT schedule + present/following
    entry[3] = 0x80 | ((descriptors.length >> 8) & 0x0f); // running status 4
    entry[4] = descriptors.length & 0xff;
    parts.push(entry, descriptors);
  }

  return concat(parts);
}

function writePcr(data: Uint8Array, offset: number, ticks: number): void {
  const base = Math.floor(ticks / 300);
  const extension = ticks % 300;
  data[offset] = Math.floor(base / 0x2000000) & 0xff;
  data[offset + 1] = Math.floor(base / 0x20000) & 0xff;
  data[offset + 2] = Math.floor(base / 0x200) & 0xff;
  data[offset + 3] = Math.floor(base / 0x2) & 0xff;
  data[offset + 4] = ((base & 0x01) << 7) | 0x7e | ((extension >> 8) & 0x01);
  data[offset + 5] = extension & 0xff;
}
