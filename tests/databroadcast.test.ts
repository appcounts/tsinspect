import { describe, expect, it } from 'vitest';
import { DataBroadcastAccumulator, type AitSection } from '@tsinspect/core';

function section(tableId: number, body: number[], header = 0xb0): Uint8Array {
  const sectionLength = body.length + 4;
  return Uint8Array.from([
    tableId,
    header | ((sectionLength >> 8) & 0x0f),
    sectionLength & 0xff,
    ...body,
    0,
    0,
    0,
    0,
  ]);
}

/** Long section header plus dsmccMessageHeader (ISO/IEC 13818-6, 7.2). */
function dsmccHeader(messageId: number, transactionId: number, messageLength: number): number[] {
  return [
    0, 0, // table_id_extension
    0x01, // version 0, current_next 1
    0, 0, // section number, last section number
    0x11, 0x03, // protocolDiscriminator, dsmccType
    (messageId >> 8) & 0xff,
    messageId & 0xff,
    (transactionId >> 24) & 0xff,
    (transactionId >> 16) & 0xff,
    (transactionId >> 8) & 0xff,
    transactionId & 0xff,
    0, // reserved
    0, // adaptationLength
    (messageLength >> 8) & 0xff,
    messageLength & 0xff,
  ];
}

function mpeSection(): Uint8Array {
  const ipv4 = [
    0x45, 0x00, 0x00, 0x14,
    0x00, 0x00, 0x00, 0x00,
    0x40, 0x11, 0x00, 0x00,
    10, 0, 0, 1,
    239, 1, 2, 3,
  ];
  return section(0x3e, [
    0, 0, 0, 0, 0, 1, // MAC
    0x03, // LLC/SNAP flag + current_next_indicator
    0, 0, // section number / last
    0xaa, 0xaa, 0x03, 0x00, 0x00, 0x00, 0x08, 0x00, // LLC/SNAP
    ...ipv4,
  ]);
}

function diiSection(): Uint8Array {
  const body = [
    0, 0, 0, 1, // downloadId
    0x04, 0x00, // blockSize
    1, 0, // windowSize, ackPeriod
    0, 0, 0, 0, // tCDownloadWindow
    0, 0, 0, 0, // tCDownloadScenario
    0, 1, // numberOfModules
    0x00, 0x10, // moduleId
    0, 0, 0x03, 0xe8, // moduleSize 1000
    1, 0, // version, moduleInfoLength
  ];
  return section(0x3b, [
    ...dsmccHeader(0x1002, 1, body.length),
    ...body,
  ]);
}

function ddbSection(): Uint8Array {
  const magic = [0x42, 0x49, 0x4f, 0x50]; // BIOP
  const key = [...Buffer.from('logo.png')];
  const messageSize = 11 + 3 + 1 + key.length + 4 + 0;
  const message = [
    ...magic,
    1, 0, // version, reserved
    (messageSize >> 24) & 0xff,
    (messageSize >> 16) & 0xff,
    (messageSize >> 8) & 0xff,
    messageSize & 0xff,
    3, 0x66, 0x69, 0x6c, // objectKind 'fil'
    key.length,
    ...key,
    0, 0, 0, 0, // objectInfoLength
  ];
  const body = [
    0x00, 0x10, // moduleId
    1, // moduleVersion
    0, // reserved
    0, 0, // blockNumber
    ...message,
  ];
  return section(0x3c, [...dsmccHeader(0x1003, 1, body.length), ...body]);
}

function fecSection(): Uint8Array {
  const body = [4, 0, ...new Array<number>(190).fill(0)];
  return section(0x78, body, 0x70);
}

describe('data broadcast accumulator', () => {
  it('parses MPE datagrams and IPv4 payloads', () => {
    const accumulator = new DataBroadcastAccumulator();
    const summary = accumulator.pushSection(0x0100, mpeSection());
    expect(summary?.fields.macAddress).toBe('00:00:00:00:00:01');
    const data = accumulator.finish();
    expect(data?.mpe).toHaveLength(1);
    expect(data?.mpe[0]?.datagrams).toBe(1);
    expect(data?.mpe[0]?.ipv4?.destination).toBe('239.1.2.3');
    expect(data?.mpe[0]?.ipv4?.multicast).toBe(true);
  });

  it('parses MPE-FEC sections', () => {
    const accumulator = new DataBroadcastAccumulator();
    accumulator.pushSection(0x0200, fecSection());
    const data = accumulator.finish();
    expect(data?.mpeFec[0]?.paddingColumns).toBe(4);
    expect(data?.mpeFec[0]?.frames).toBe(1);
  });

  it('parses DSM-CC DII modules and DDB BIOP objects', () => {
    const accumulator = new DataBroadcastAccumulator();
    accumulator.pushSection(0x0300, diiSection());
    accumulator.pushSection(0x0300, ddbSection());
    const data = accumulator.finish();
    const carousel = data?.carousels[0];
    expect(carousel?.downloadInfos).toBe(1);
    expect(carousel?.dataBlocks).toBe(1);
    expect(carousel?.modules).toEqual([{ id: 0x10, size: 1000, version: 1 }]);
    expect(carousel?.objects[0]?.name).toBe('logo.png');
    expect(carousel?.objects[0]?.kind).toBe('file');
  });

  it('detects MHP and HbbTV applications from AIT', () => {
    const name = Buffer.from('News');
    const url = Buffer.from('http://example.com/app');
    const ait: AitSection = {
      applicationType: 0x0010,
      version: 2,
      currentNext: true,
      sectionNumber: 0,
      lastSectionNumber: 0,
      commonDescriptors: [],
      applications: [
        {
          organizationId: 1,
          applicationId: 7,
          controlCode: 1,
          descriptors: [
            {
              tag: 0x01,
              tagHex: '0x01',
              length: name.length + 1,
              name: 'application_name_descriptor',
              raw: Buffer.from([name.length, ...name]).toString('hex').toUpperCase(),
            },
            {
              tag: 0x02,
              tagHex: '0x02',
              length: url.length + 1,
              name: 'transport_protocol_descriptor',
              raw: Buffer.from([url.length, ...url]).toString('hex').toUpperCase(),
            },
          ],
        },
      ],
      crcValid: true,
    };
    const accumulator = new DataBroadcastAccumulator();
    accumulator.addAit(0x001e, ait);
    const data = accumulator.finish();
    expect(data?.hbbtv).toBe(true);
    expect(data?.mhp).toBe(false);
    expect(data?.applications[0]?.name).toBe('News');
    expect(data?.applications[0]?.urls).toEqual(['http://example.com/app']);
  });
});
