import { describe, expect, it } from 'vitest';
import { parseNit, parsePat, parsePmt, parseSdt, parseAtscRrt } from '@tsinspect/core';
import {
  atscMss,
  buildSection,
  concat,
  descriptor,
  patBody,
  pmtBody,
  serviceDescriptor,
  sdtBody,
} from './helpers.js';

function networkNameDescriptor(name: string): Uint8Array {
  const bytes = new TextEncoder().encode(name);
  return descriptor(0x40, bytes);
}

describe('PAT', () => {
  it('parses programs and the network PID', () => {
    const section = buildSection(
      0x00,
      patBody([
        { programNumber: 0, pid: 0x0010 },
        { programNumber: 1, pid: 0x1000 },
        { programNumber: 2, pid: 0x1001 },
      ]),
      { tableIdExtension: 0x1234, version: 3 },
    );

    const pat = parsePat(section);
    expect(pat).not.toBeNull();
    expect(pat?.transportStreamId).toBe(0x1234);
    expect(pat?.version).toBe(3);
    expect(pat?.networkPid).toBe(0x0010);
    expect(pat?.programs).toEqual([
      { programNumber: 1, pid: 0x1000 },
      { programNumber: 2, pid: 0x1001 },
    ]);
    expect(pat?.crcValid).toBe(true);
  });
});

describe('PMT', () => {
  it('parses the PCR PID, program descriptors and elementary streams', () => {
    const section = buildSection(
      0x02,
      pmtBody(0x0100, [
        { streamType: 0x1b, pid: 0x0100 },
        { streamType: 0x0f, pid: 0x0101 },
        { streamType: 0x06, pid: 0x0102, descriptors: descriptor(0x59, new Uint8Array([0x6a, 0x70, 0x6e, 0x10, 0x00, 0x01, 0x00, 0x00])) },
      ]),
      { tableIdExtension: 1, version: 5 },
    );

    const pmt = parsePmt(section);
    expect(pmt).not.toBeNull();
    expect(pmt?.programNumber).toBe(1);
    expect(pmt?.version).toBe(5);
    expect(pmt?.pcrPid).toBe(0x0100);
    expect(pmt?.streams.map((stream) => stream.streamType)).toEqual([0x1b, 0x0f, 0x06]);
    expect(pmt?.streams[2]?.descriptors[0]?.name).toBe('Subtitling');
    expect(pmt?.crcValid).toBe(true);
  });
});

describe('SDT', () => {
  it('parses service names and the original network ID', () => {
    const section = buildSection(
      0x42,
      sdtBody(0x2000, [
        { serviceId: 1, name: 'One', provider: 'Net' },
        { serviceId: 2, name: 'Two', descriptors: serviceDescriptor(0x19, 'Net', 'Two HD') },
      ]),
      { tableIdExtension: 0x1234 },
    );

    const sdt = parseSdt(section);
    expect(sdt).not.toBeNull();
    expect(sdt?.transportStreamId).toBe(0x1234);
    expect(sdt?.originalNetworkId).toBe(0x2000);
    expect(sdt?.services).toHaveLength(2);
    expect(sdt?.services[0]?.serviceName).toBe('One');
    expect(sdt?.services[0]?.providerName).toBe('Net');
    expect(sdt?.services[1]?.serviceType).toBe(0x19);
    expect(sdt?.services[1]?.eitSchedule).toBe(true);
    expect(sdt?.services[1]?.eitPresentFollowing).toBe(true);
  });
});

describe('NIT', () => {
  it('parses the network name', () => {
    const body = new Uint8Array(4);
    const networkDescriptor = networkNameDescriptor('TestNet');
    body[0] = 0xf0 | ((networkDescriptor.length >> 8) & 0x0f);
    body[1] = networkDescriptor.length & 0xff;
    body[2] = 0xf0;
    body[3] = 0x00;
    const withDescriptor = new Uint8Array(4 + networkDescriptor.length);
    withDescriptor.set(body.subarray(0, 2));
    withDescriptor.set(networkDescriptor, 2);
    withDescriptor.set(body.subarray(2), 2 + networkDescriptor.length);

    const section = buildSection(0x40, withDescriptor, { tableIdExtension: 0x0555 });
    const nit = parseNit(section);
    expect(nit).not.toBeNull();
    expect(nit?.networkId).toBe(0x0555);
    expect(nit?.networkName).toBe('TestNet');
    expect(nit?.crcValid).toBe(true);
  });

  it('parses the transport stream loop', () => {
    const networkDescriptor = networkNameDescriptor('TestNet');
    const serviceList = descriptor(0x41, Uint8Array.from([0x00, 0x01, 0x01]));
    const transports = concat([
      Uint8Array.from([0x12, 0x34]),
      Uint8Array.from([0x05, 0x55]),
      Uint8Array.from([0xf0 | ((serviceList.length >> 8) & 0x0f), serviceList.length & 0xff]),
      serviceList,
    ]);
    const body = concat([
      Uint8Array.from([0xf0 | ((networkDescriptor.length >> 8) & 0x0f), networkDescriptor.length & 0xff]),
      networkDescriptor,
      Uint8Array.from([0xf0 | ((transports.length >> 8) & 0x0f), transports.length & 0xff]),
      transports,
    ]);

    const section = buildSection(0x40, body, { tableIdExtension: 0x0555 });
    const nit = parseNit(section);
    expect(nit?.transports).toHaveLength(1);
    expect(nit?.transports[0]?.transportStreamId).toBe(0x1234);
    expect(nit?.transports[0]?.originalNetworkId).toBe(0x0555);
    expect(nit?.transports[0]?.descriptors[0]?.tag).toBe(0x41);
  });
});

describe('ATSC RRT', () => {
  it('parses the region name, dimensions and rating values for region 5', () => {
    const name = atscMss('USA');
    const dimension = atscMss('MPAA');
    const abbrev = atscMss('PG-13');
    const value = atscMss('Parents Strongly Cautioned');
    const body = concat([
      Uint8Array.from([0x00, name.length]), // protocol_version 0, name length
      name,
      Uint8Array.from([1, dimension.length]), // dimensions_defined 1
      dimension,
      Uint8Array.from([0xf1]), // reserved, graduated_scale 1, one value
      Uint8Array.from([abbrev.length]),
      abbrev,
      Uint8Array.from([value.length]),
      value,
      Uint8Array.from([0x00, 0x00]), // descriptors_length 0
    ]);

    const section = buildSection(0xca, body, { tableIdExtension: 0xff05 });
    const rrt = parseAtscRrt(section);
    expect(rrt).not.toBeNull();
    expect(rrt?.ratingRegion).toBe(5);
    expect(rrt?.protocolVersion).toBe(0);
    expect(rrt?.name).toBe('USA');
    expect(rrt?.dimensions).toHaveLength(1);
    expect(rrt?.dimensions[0]?.name).toBe('MPAA');
    expect(rrt?.dimensions[0]?.graduatedScale).toBe(true);
    expect(rrt?.dimensions[0]?.values).toEqual([
      { abbrev: 'PG-13', text: 'Parents Strongly Cautioned' },
    ]);
    expect(rrt?.descriptors).toEqual([]);
  });
});
