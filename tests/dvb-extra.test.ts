import { describe, expect, it } from 'vitest';
import { parseAit, parseBat, parseRst, parseSit } from '@tsinspect/core';
import { buildSection, concat, descriptor } from './helpers.js';

function u16(value: number): Uint8Array {
  return Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);
}

function sectionLength(value: number): Uint8Array {
  return u16(0xf000 | (value & 0x0fff));
}

describe('DVB extra tables', () => {
  it('parses BAT bouquet name and transport stream loop', () => {
    const bouquetName = descriptor(0x47, new TextEncoder().encode('My Bouquet'));
    const serviceList = descriptor(0x41, Uint8Array.from([0x00, 0x01, 0x01]));
    const transports = concat([
      u16(0x0001),
      u16(0x0002),
      sectionLength(serviceList.length),
      serviceList,
    ]);
    const body = concat([
      sectionLength(bouquetName.length),
      bouquetName,
      sectionLength(transports.length),
      transports,
    ]);
    const section = buildSection(0x4a, body, { tableIdExtension: 0x0042 });

    const bat = parseBat(section);
    expect(bat).not.toBeNull();
    expect(bat?.bouquetId).toBe(0x0042);
    expect(bat?.bouquetName).toBe('My Bouquet');
    expect(bat?.crcValid).toBe(true);
    expect(bat?.transports).toHaveLength(1);
    expect(bat?.transports[0]?.transportStreamId).toBe(1);
    expect(bat?.transports[0]?.originalNetworkId).toBe(2);
    expect(bat?.transports[0]?.descriptors[0]?.tag).toBe(0x41);
  });

  it('parses RST running-status entries', () => {
    const body = concat([u16(0x0001), u16(0x0002), Uint8Array.from([0x80])]);
    const section = buildSection(0x71, body, { long: false });

    const rst = parseRst(section);
    expect(rst?.entries).toEqual([
      { serviceId: 1, eventId: 2, runningStatus: 4, runningStatusName: 'running' },
    ]);
  });

  it('parses AIT common and application loops', () => {
    const appDescriptor = descriptor(0x01, new TextEncoder().encode('app'));
    const applications = concat([
      u16(0x0000),
      u16(0x0001), // organization id 1 (low half)
      u16(0x0001),
      Uint8Array.from([0x01]),
      sectionLength(appDescriptor.length),
      appDescriptor,
    ]);
    const body = concat([
      sectionLength(0), // common descriptors
      sectionLength(applications.length),
      applications,
    ]);
    const section = buildSection(0x74, body, { tableIdExtension: 0x0001 });

    const ait = parseAit(section);
    expect(ait).not.toBeNull();
    expect(ait?.applicationType).toBe(1);
    expect(ait?.applications).toHaveLength(1);
    expect(ait?.applications[0]?.organizationId).toBe(1);
    expect(ait?.applications[0]?.applicationId).toBe(1);
    expect(ait?.applications[0]?.controlCode).toBe(1);
    expect(ait?.applications[0]?.descriptors[0]?.tag).toBe(0x01);
  });

  it('parses the SIT service loop', () => {
    const serviceDescriptor = descriptor(0x41, Uint8Array.from([0x00, 0x01, 0x01]));
    const services = concat([
      u16(0x0001),
      Uint8Array.from([0xc0 | (serviceDescriptor.length >> 8), serviceDescriptor.length & 0xff]),
      serviceDescriptor,
    ]);
    const body = concat([
      sectionLength(0), // transmission info descriptors
      services,
    ]);
    const section = buildSection(0x7f, body);

    const sit = parseSit(section);
    expect(sit?.services).toHaveLength(1);
    expect(sit?.services[0]?.serviceId).toBe(1);
    expect(sit?.services[0]?.runningStatus).toBe(4);
    expect(sit?.services[0]?.runningStatusName).toBe('running');
    expect(sit?.services[0]?.descriptors[0]?.tag).toBe(0x41);
  });
});
