import { describe, expect, it } from 'vitest';
import {
  crc32Mpeg2,
  mjdToUnixSeconds,
  parseDvbDateTime,
  parseDvbDurationSeconds,
  parseEit,
  parseTdt,
  parseTot,
} from '@tsinspect/core';
import {
  buildSection,
  concat,
  descriptor,
  dvbDateTimeBytes,
  dvbDurationBytes,
} from './helpers.js';

function shortEventDescriptor(language: string, name: string, text: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const textBytes = new TextEncoder().encode(text);
  const body = new Uint8Array(5 + nameBytes.length + textBytes.length);
  body.set(new TextEncoder().encode(language), 0);
  body[3] = nameBytes.length;
  body.set(nameBytes, 4);
  body[4 + nameBytes.length] = textBytes.length;
  body.set(textBytes, 5 + nameBytes.length);
  return descriptor(0x4d, body);
}

function extendedEventDescriptor(language: string, text: string, tag = 0x4e): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  const textBytes =
    tag === 0xc4
      ? Uint8Array.from([0x1b, 0x28, 0x4a, ...encoded]) // designate G0 as ARIB alphanumeric
      : encoded;
  const body = new Uint8Array(6 + textBytes.length);
  body[0] = 0x00; // descriptor number 0, last 0
  body.set(new TextEncoder().encode(language), 1);
  body[4] = 0; // no items
  body[5] = textBytes.length;
  body.set(textBytes, 6);
  return descriptor(tag, body);
}

function eitEventSection(): Uint8Array {
  const start = Date.UTC(2026, 10, 6, 12, 0, 0) / 1000;
  const shortEvent = shortEventDescriptor('eng', 'Evening News', 'The latest headlines.');
  const extended = extendedEventDescriptor('eng', 'Extended description.');
  const content = descriptor(0x54, new Uint8Array([0x20, 0x00]));
  const eventDescriptors = concat([shortEvent, extended, content]);

  const body = new Uint8Array(6 + 12 + eventDescriptors.length);
  body[0] = 0x12; // transport_stream_id
  body[1] = 0x34;
  body[2] = 0x20; // original_network_id
  body[3] = 0x00;
  body[4] = 0x00; // segment_last_section_number
  body[5] = 0x4e; // last_table_id
  const event = 6;
  body[event] = 0x00; // event_id
  body[event + 1] = 0x2a;
  body.set(dvbDateTimeBytes(start), event + 2);
  body.set(dvbDurationBytes(5400), event + 7);
  body[event + 10] = 0x80 | ((eventDescriptors.length >> 8) & 0x0f); // running
  body[event + 11] = eventDescriptors.length & 0xff;
  body.set(eventDescriptors, event + 12);

  return buildSection(0x4e, body, { tableIdExtension: 0x0401, version: 2 });
}

describe('DVB time', () => {
  it('converts MJD and BCD to Unix time', () => {
    expect(mjdToUnixSeconds(40587)).toBe(0);
    const date = parseDvbDateTime(dvbDateTimeBytes(Date.UTC(2026, 10, 6, 12, 34, 56) / 1000));
    expect(date?.iso).toBe('2026-11-06T12:34:56.000Z');
  });

  it('rejects invalid BCD digits', () => {
    expect(parseDvbDateTime(new Uint8Array([0x4c, 0x1f, 0x1a, 0x00, 0x00]))).toBeNull();
    expect(parseDvbDurationSeconds(new Uint8Array([0x01, 0x6a, 0x00]))).toBeNull();
  });

  it('parses a TDT section', () => {
    const utc = dvbDateTimeBytes(Date.UTC(2026, 0, 2, 3, 4, 5) / 1000);
    const section = buildSection(0x70, utc, { long: false });
    const table = parseTdt(section);
    expect(table?.name).toBe('TDT');
    expect(table?.utc?.iso).toBe('2026-01-02T03:04:05.000Z');
  });

  it('parses a TOT section with a local time offset descriptor', () => {
    const utc = dvbDateTimeBytes(Date.UTC(2026, 6, 1, 10, 0, 0) / 1000);
    const offsetBody = new Uint8Array(13);
    offsetBody.set(new TextEncoder().encode('FRA'), 0);
    offsetBody[3] = 0x01; // polarity 1 (negative)
    offsetBody[4] = 0x02; // BCD hours
    offsetBody[5] = 0x00; // BCD minutes
    const offset = descriptor(0x58, offsetBody);

    const sectionLength = 5 + 2 + offset.length + 4;
    const section = new Uint8Array(3 + sectionLength);
    section[0] = 0x73;
    section[1] = 0xb0 | ((sectionLength >> 8) & 0x0f);
    section[2] = sectionLength & 0xff;
    section.set(utc, 3);
    section[8] = 0xf0 | ((offset.length >> 8) & 0x0f);
    section[9] = offset.length & 0xff;
    section.set(offset, 10);
    const crc = crc32Mpeg2(section.subarray(0, section.length - 4));
    section[section.length - 4] = (crc >>> 24) & 0xff;
    section[section.length - 3] = (crc >>> 16) & 0xff;
    section[section.length - 2] = (crc >>> 8) & 0xff;
    section[section.length - 1] = crc & 0xff;

    const table = parseTot(section);
    expect(table?.name).toBe('TOT');
    expect(table?.utc?.iso).toBe('2026-07-01T10:00:00.000Z');
    expect(table?.crcValid).toBe(true);
    const fields = table?.localTimeOffsetDescriptors[0]?.fields;
    expect(fields?.countryCode).toBe('FRA');
    expect(fields?.localTimeOffset).toBe('-02:00');
  });
});

describe('EIT', () => {
  it('parses present/following events, times and descriptors', () => {
    const eit = parseEit(eitEventSection());
    expect(eit).not.toBeNull();
    expect(eit?.serviceId).toBe(0x0401);
    expect(eit?.transportStreamId).toBe(0x1234);
    expect(eit?.originalNetworkId).toBe(0x2000);
    expect(eit?.kind).toBe('present-following');
    expect(eit?.version).toBe(2);
    expect(eit?.events).toHaveLength(1);

    const event = eit?.events[0];
    expect(event?.eventId).toBe(0x2a);
    expect(event?.name).toBe('Evening News');
    expect(event?.text).toBe('The latest headlines.');
    expect(event?.durationSec).toBe(5400);
    expect(event?.startTimeIso).toBe('2026-11-06T12:00:00.000Z');
    expect(event?.endTimeIso).toBe('2026-11-06T13:30:00.000Z');
    expect(event?.runningStatus).toBe(4);
    expect(event?.runningStatusName).toBe('running');
    expect(event?.descriptors.map((d) => d.tag)).toEqual([0x4d, 0x4e, 0x54]);
  });

  it('uses the ISDB extended event descriptor for event text', () => {
    const start = Date.UTC(2026, 10, 6, 12, 0, 0) / 1000;
    const extended = extendedEventDescriptor('jpn', 'ISDB detail', 0xc4);
    const body = new Uint8Array(6 + 12 + extended.length);
    body[0] = 0x12;
    body[1] = 0x34;
    body[2] = 0x20;
    body[3] = 0x00;
    body[4] = 0x00;
    body[5] = 0x4e;
    body[6] = 0x00;
    body[7] = 0x2a;
    body.set(dvbDateTimeBytes(start), 8);
    body.set(dvbDurationBytes(1800), 13);
    body[16] = 0x80 | ((extended.length >> 8) & 0x0f);
    body[17] = extended.length & 0xff;
    body.set(extended, 18);

    const eit = parseEit(buildSection(0x4e, body, { tableIdExtension: 0x0401 }), 'arib');
    expect(eit?.events[0]?.name).toBeUndefined();
    expect(eit?.events[0]?.text).toBe('ISDB detail');
  });

  it('returns null for a non-EIT table', () => {
    const section = buildSection(0x42, new Uint8Array(3));
    expect(parseEit(section)).toBeNull();
  });
});
