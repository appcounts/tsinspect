import { type AitSection, DataBroadcastAccumulator, scanCarousels } from '@tsinspect/core';
import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { carouselFixture } from './carousel-fixture.js';
import { concat, packetizeSection } from './helpers.js';

/** Section whose payload starts directly after table_id/section_length (MPE). */
function rawSection(tableId: number, body: number[], header = 0xb0): Uint8Array {
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

function mpeSection(): Uint8Array {
  const ipv4 = [
    0x45, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x00, 0x40, 0x11, 0x00, 0x00, 10, 0, 0, 1, 239, 1, 2,
    3,
  ];
  return rawSection(0x3e, [
    0,
    0,
    0,
    0,
    0,
    1, // MAC
    0x03, // LLC/SNAP flag + current_next_indicator
    0,
    0, // section number / last
    0xaa,
    0xaa,
    0x03,
    0x00,
    0x00,
    0x00,
    0x08,
    0x00, // LLC/SNAP
    ...ipv4,
  ]);
}

function fecSection(): Uint8Array {
  return rawSection(0x78, [4, 0, ...new Array<number>(190).fill(0)], 0x70);
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

  it('rebuilds the object carousel directory tree', () => {
    const fixture = carouselFixture();
    const accumulator = new DataBroadcastAccumulator();
    for (const section of fixture.sections) accumulator.pushSection(0x0300, section);
    const data = accumulator.finish();
    const carousel = data?.carousels[0];
    expect(carousel?.root).toBe('/');
    expect(carousel?.modules.map((module) => module.id)).toEqual([10, 11, 12, 13, 14]);
    expect(carousel?.entries.map((entry) => [entry.path, entry.kind, entry.complete])).toEqual([
      ['/', 'directory', true],
      ['/index.html', 'file', true],
      ['/css', 'directory', true],
      ['/css/site.css', 'file', true],
    ]);
    expect(carousel?.entries[1]?.size).toBe(fixture.content.get('/index.html')?.length);
    expect(carousel?.entries[1]?.contentType).toBe('text/html');
    expect(carousel?.entries[1]?.moduleId).toBe(12);
    expect(carousel?.completeModules).toBe(5);
    expect(carousel?.pendingModules).toBe(0);
    expect(carousel?.danglingBindings).toBe(0);
    expect(carousel?.unreachableObjects).toBe(0);
  });

  it('exports file content with scanCarousels', () => {
    const fixture = carouselFixture({ blockSize: 16 });
    const packets = fixture.sections.flatMap((section, index) =>
      packetizeSection(0x0300, section, index % 16),
    );
    const result = scanCarousels(concat(packets));
    expect(result.carousels).toHaveLength(1);
    const files = result.files.filter((file) => file.complete);
    expect(files.map((file) => file.path).sort()).toEqual(['/css/site.css', '/index.html']);
    for (const file of files) {
      const expected = fixture.content.get(file.path);
      expect(expected).toBeDefined();
      expect(Array.from(file.data ?? [])).toEqual(Array.from(expected ?? []));
    }
  });

  it('keeps announced entries when a module is missing', () => {
    const fixture = carouselFixture({ omit: new Set([14]) });
    const accumulator = new DataBroadcastAccumulator();
    for (const section of fixture.sections) accumulator.pushSection(0x0300, section);
    const carousel = accumulator.finish()?.carousels[0];
    const css = carousel?.entries.find((entry) => entry.path === '/css/site.css');
    expect(css?.complete).toBe(false);
    expect(css?.size).toBe(fixture.content.get('/css/site.css')?.length);
    expect(carousel?.danglingBindings).toBe(1);
    expect(carousel?.pendingModules).toBe(0);
  });

  it('inflates modules flagged with the compressed_module_descriptor', () => {
    const fixture = carouselFixture({ compress: new Set([12, 14]) });
    const plain = new DataBroadcastAccumulator();
    for (const section of fixture.sections) plain.pushSection(0x0300, section);
    const compressed = plain.finish()?.carousels[0];
    expect(compressed?.compressedModules).toBe(2);
    expect(compressed?.pendingModules).toBe(2);
    expect(compressed?.entries.find((entry) => entry.path === '/index.html')?.complete).toBe(false);

    const inflating = new DataBroadcastAccumulator({
      inflate: (payload) => new Uint8Array(inflateSync(payload)),
    });
    for (const section of fixture.sections) inflating.pushSection(0x0300, section);
    const inflated = inflating.finish()?.carousels[0];
    expect(inflated?.compressedModules).toBe(2);
    expect(inflated?.pendingModules).toBe(0);
    expect(
      inflated?.entries
        .filter((entry) => entry.kind === 'file')
        .map((entry) => [entry.path, entry.complete]),
    ).toEqual([
      ['/index.html', true],
      ['/css/site.css', true],
    ]);
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
              raw: Buffer.from([name.length, ...name])
                .toString('hex')
                .toUpperCase(),
            },
            {
              tag: 0x02,
              tagHex: '0x02',
              length: url.length + 1,
              name: 'transport_protocol_descriptor',
              raw: Buffer.from([url.length, ...url])
                .toString('hex')
                .toUpperCase(),
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
