import { describe, expect, it } from 'vitest';
import { PesAssembler, SectionAssembler, parsePesHeader } from '@tsinspect/core';
import { buildPacket, buildSection, patBody, packetizeSection } from './helpers.js';

function feed(assembler: SectionAssembler, packets: Uint8Array[]) {
  const out: Uint8Array[] = [];
  packets.forEach((packet, index) => {
    const pusi = (packet[1]! & 0x40) !== 0;
    out.push(...assembler.push(packet.subarray(4), pusi, index, index * 188).map((s) => s.data));
  });
  return out;
}

describe('section assembler', () => {
  it('assembles a section contained in one packet', () => {
    const section = buildSection(0x00, patBody([{ programNumber: 1, pid: 0x1000 }]));
    const assembler = new SectionAssembler(0);
    const sections = feed(assembler, packetizeSection(0, section));
    expect(sections).toHaveLength(1);
    expect(sections[0]).toEqual(section);
  });

  it('assembles a section spanning several packets', () => {
    const programs = Array.from({ length: 80 }, (_, index) => ({
      programNumber: index + 1,
      pid: 0x1000 + index,
    }));
    const section = buildSection(0x00, patBody(programs));
    expect(section.length).toBeGreaterThan(184);

    const assembler = new SectionAssembler(0);
    const sections = feed(assembler, packetizeSection(0, section));
    expect(sections).toHaveLength(1);
    expect(sections[0]).toEqual(section);
  });

  it('handles two sections in one packet', () => {
    const first = buildSection(0x42, new Uint8Array(3));
    const second = buildSection(0x42, new Uint8Array(3));
    const payload = new Uint8Array(184).fill(0xff);
    payload[0] = 0x00;
    payload.set(first, 1);
    payload.set(second, 1 + first.length);
    const packet = buildPacket(0x11, payload, { pusi: true });

    const assembler = new SectionAssembler(0x11);
    expect(feed(assembler, [packet])).toHaveLength(2);
  });

  it('uses the pointer_field to finish a section split across packets', () => {
    const section = buildSection(0x42, new Uint8Array(200).fill(0x41));
    const assembler = new SectionAssembler(0x11);

    const firstPayload = new Uint8Array(184).fill(0xff);
    firstPayload[0] = 0x00;
    firstPayload.set(section.subarray(0, 183), 1);
    const firstPacket = buildPacket(0x11, firstPayload, { pusi: true });

    const remaining = section.length - 183;
    const secondPayload = new Uint8Array(184).fill(0xff);
    secondPayload[0] = remaining; // pointer_field: bytes of the old section
    secondPayload.set(section.subarray(183), 1);
    const secondPacket = buildPacket(0x11, secondPayload, { pusi: true, cc: 1 });

    const sections = feed(assembler, [firstPacket, secondPacket]);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toEqual(section);
  });

  it('ignores stuffing after a complete section', () => {
    const section = buildSection(0x42, new Uint8Array(3));
    const assembler = new SectionAssembler(0x11);
    const sections = feed(assembler, packetizeSection(0x11, section));
    expect(sections).toHaveLength(1);
    expect(assembler.pendingBytes).toBe(0);
  });
});

/** Build a PES packet whose payload may be followed by 0xFF stuffing. */
function pesPacket(options: {
  streamId?: number;
  packetLength: number;
  payload: Uint8Array;
  stuffing?: number;
}): Uint8Array {
  const stuffing = options.stuffing ?? 0;
  const data = new Uint8Array(9 + options.payload.length + stuffing);
  data[0] = 0x00;
  data[1] = 0x00;
  data[2] = 0x01;
  data[3] = options.streamId ?? 0xbd;
  data[4] = (options.packetLength >> 8) & 0xff;
  data[5] = options.packetLength & 0xff;
  data[6] = 0x80; // '10' marker
  data[7] = 0x00; // no PTS/DTS, no optional fields
  data[8] = 0x00; // PES_header_data_length
  data.set(options.payload, 9);
  data.fill(0xff, 9 + options.payload.length);
  return data;
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('PES assembler payload length', () => {
  it('stops at packetLength and drops trailing stuffing', () => {
    const data = pesPacket({
      packetLength: 8, // 8 bytes after the length field = 5 payload + 3 stuffing
      payload: text('hello'),
      stuffing: 10,
    });
    const assembler = new PesAssembler(0x0100);
    const packets = assembler.push(data, true, 0, 0);

    expect(packets).toHaveLength(1);
    const packet = packets[0]!;
    expect(packet.complete).toBe(true);
    expect(new TextDecoder().decode(packet.payload)).toBe('hello');
    expect(packet.payload).toHaveLength(5);
  });

  it('keeps everything available when packetLength is 0', () => {
    const data = pesPacket({ packetLength: 0, payload: text('hello'), stuffing: 6 });
    const assembler = new PesAssembler(0x0100);
    expect(assembler.push(data, true, 0, 0)).toHaveLength(0);

    const packets = assembler.flush();
    expect(packets).toHaveLength(1);
    const packet = packets[0]!;
    // A zero length means "unknown": the assembler cannot tell stuffing from
    // payload, so it keeps the bytes it has and marks the packet incomplete.
    expect(packet.complete).toBe(false);
    expect(packet.payload).toHaveLength(11);
    expect(new TextDecoder().decode(packet.payload.subarray(0, 5))).toBe('hello');
  });

  it('keeps the actual bytes when packetLength exceeds the data received', () => {
    const data = pesPacket({ packetLength: 100, payload: text('hello') });
    const assembler = new PesAssembler(0x0100);
    expect(assembler.push(data, true, 0, 0)).toHaveLength(0);

    const packets = assembler.flush();
    expect(packets).toHaveLength(1);
    const packet = packets[0]!;
    expect(packet.complete).toBe(false);
    expect(new TextDecoder().decode(packet.payload)).toBe('hello');
  });
});

/** PES packet for a stream id that has no optional PES header. */
function shortPes(streamId: number, packetLength: number, payload: Uint8Array): Uint8Array {
  const data = new Uint8Array(6 + payload.length);
  data[0] = 0x00;
  data[1] = 0x00;
  data[2] = 0x01;
  data[3] = streamId;
  data[4] = (packetLength >> 8) & 0xff;
  data[5] = packetLength & 0xff;
  data.set(payload, 6);
  return data;
}

describe('PES streams without an optional PES header', () => {
  it('starts the payload right after the 6-byte header', () => {
    const header = parsePesHeader(shortPes(0xbe, 5, text('hello')));
    expect(header).not.toBeNull();
    expect(header!.payloadOffset).toBe(6);
    expect(header!.headerDataLength).toBe(0);
    expect(header!.pts).toBeUndefined();
  });

  it('completes a packet as soon as its declared length is available', () => {
    const assembler = new PesAssembler(0x0100);
    const packets = assembler.push(shortPes(0xbc, 5, text('abcde')), true, 0, 0);

    expect(packets).toHaveLength(1);
    expect(packets[0]!.complete).toBe(true);
    expect(new TextDecoder().decode(packets[0]!.payload)).toBe('abcde');
  });

  it('handles a one-byte payload without waiting for more header bytes', () => {
    const assembler = new PesAssembler(0x0100);
    const packets = assembler.push(shortPes(0xbf, 1, text('x')), true, 0, 0);

    expect(packets).toHaveLength(1);
    expect(new TextDecoder().decode(packets[0]!.payload)).toBe('x');
    expect(assembler.pendingBytes).toBe(0);
  });
});
