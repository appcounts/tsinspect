/**
 * Synthetic MHP object carousel sections for tests and manual fixtures.
 *
 *   /                 (directory, module 11, key "001")
 *   /index.html       (file, module 12, key "002")
 *   /css              (directory, module 13, key "003")
 *   /css/site.css     (file, module 14, key "004")
 */

import { deflateSync } from 'node:zlib';
import { buildSection, concat, packetizeSection, patBody, pmtBody } from './helpers.js';

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u64(value: number): number[] {
  return [...u32(Math.floor(value / 0x1_0000_0000)), ...u32(value >>> 0)];
}

/** CORBA/CDR-Lite string: bytes plus a NUL terminator. */
function cdr(text: string): number[] {
  return [...Buffer.from(text, 'latin1'), 0];
}

/** DSM-CC section: long header, dsmccMessageHeader and a message body. */
export function dsmccSection(
  tableId: number,
  messageId: number,
  body: number[],
  transactionId = 1,
): Uint8Array {
  return buildSection(
    tableId,
    Uint8Array.from([
      0x11,
      0x03,
      ...u16(messageId),
      ...u32(transactionId),
      0xff,
      0,
      ...u16(body.length),
      ...body,
    ]),
  );
}

/** BIOP message: 12-byte header, key, kind, objectInfo, contexts and body. */
function biopMessage(key: string, kind: string, info: number[], body: number[]): number[] {
  const keyBytes = cdr(key);
  const kindBytes = cdr(kind);
  const rest = [
    keyBytes.length,
    ...keyBytes,
    ...u32(kindBytes.length),
    ...kindBytes,
    ...u16(info.length),
    ...info,
    0, // serviceContextList_count
    ...u32(body.length),
    ...body,
  ];
  return [0x42, 0x49, 0x4f, 0x50, 1, 0, 0, 0, ...u32(rest.length), ...rest];
}

function fileMessage(key: string, content: Uint8Array, contentType?: string): number[] {
  const info = [...u64(content.length)];
  if (contentType !== undefined) {
    info.push(0x72, contentType.length, ...Buffer.from(contentType, 'latin1'));
  }
  return biopMessage(key, 'fil', info, [...u32(content.length), ...content]);
}

/** BIOP IOR with a BIOPProfileBody (ObjectLocation + ConnBinder). */
function ior(typeId: string, carouselId: number, moduleId: number, key: string): number[] {
  const objectKey = cdr(key);
  const location = [...u32(carouselId), ...u16(moduleId), 1, 0, objectKey.length, ...objectKey];
  const tap = [
    ...u16(0),
    ...u16(0x0016),
    ...u16(0x0001),
    0x0a,
    ...u16(0x0001),
    ...u32(0x80000002),
    ...u32(30_000_000),
  ];
  const profile = [
    0, // byte_order
    2, // lite_component_count
    ...u32(0x49534f50),
    location.length,
    ...location,
    ...u32(0x49534f40),
    1 + tap.length,
    1,
    ...tap,
  ];
  return [
    ...u32(4),
    ...cdr(typeId),
    ...u32(1),
    ...u32(0x49534f06),
    ...u32(profile.length),
    ...profile,
  ];
}

function binding(
  name: string,
  kind: string,
  type: number,
  target: number[],
  contentSize?: number,
): number[] {
  const nameBytes = cdr(name);
  const kindBytes = cdr(kind);
  const info = contentSize !== undefined ? u64(contentSize) : [];
  return [
    1,
    nameBytes.length,
    ...nameBytes,
    kindBytes.length,
    ...kindBytes,
    type,
    ...target,
    ...u16(info.length),
    ...info,
  ];
}

function directoryBody(bindings: number[][]): number[] {
  return [...u16(bindings.length), ...bindings.flat()];
}

/** BIOP::ModuleInfo: timeouts, one BIOP_OBJECT_USE tap and userInfo descriptors. */
function moduleInfo(descriptors: number[]): number[] {
  return [
    ...u32(1_000_000),
    ...u32(1_000_000),
    ...u32(50_000),
    1,
    ...u16(0),
    ...u16(0x0017),
    ...u16(0),
    0,
    descriptors.length,
    ...descriptors,
  ];
}

export interface CarouselFixtureOptions {
  downloadId?: number;
  blockSize?: number;
  /** Leave out the modules of these ids to simulate an incomplete carousel. */
  omit?: Set<number>;
  /** zlib-compress these modules and signal compressed_module_descriptor. */
  compress?: Set<number>;
}

export interface CarouselFixture {
  sections: Uint8Array[];
  content: Map<string, Uint8Array>;
}

export function carouselFixture(options: CarouselFixtureOptions = {}): CarouselFixture {
  const downloadId = options.downloadId ?? 7;
  const blockSize = options.blockSize ?? 64;
  const index = new TextEncoder().encode('<html>hello carousel</html>');
  const site = new TextEncoder().encode('body { color: #123456 }');
  const content = new Map<string, Uint8Array>([
    ['/index.html', index],
    ['/css/site.css', site],
  ]);

  const rootIor = ior('dir', downloadId, 11, '001');
  const cssIor = ior('dir', downloadId, 13, '003');
  const indexIor = ior('fil', downloadId, 12, '002');
  const siteIor = ior('fil', downloadId, 14, '004');
  const gatewayIor = ior('srg', downloadId, 10, 'SGW');

  const gateway = biopMessage(
    'SGW',
    'srg',
    [],
    directoryBody([binding('root', 'dir', 2, rootIor)]),
  );
  const root = biopMessage(
    '001',
    'dir',
    [],
    directoryBody([
      binding('index.html', 'fil', 1, indexIor, index.length),
      binding('css', 'dir', 2, cssIor),
    ]),
  );
  const css = biopMessage(
    '003',
    'dir',
    [],
    directoryBody([binding('site.css', 'fil', 1, siteIor, site.length)]),
  );

  const modules = new Map<number, number[]>([
    [10, gateway],
    [11, root],
    [12, fileMessage('002', index, 'text/html')],
    [13, css],
    [14, fileMessage('004', site, 'text/css')],
  ]);

  const dsiBody = [
    ...new Array<number>(20).fill(0xff),
    ...u16(0),
    ...u16(gatewayIor.length),
    ...gatewayIor,
  ];
  const sections: Uint8Array[] = [dsmccSection(0x3b, 0x1006, dsiBody)];

  const declared = [...modules.entries()].filter(([id]) => !options.omit?.has(id));
  const wire = declared.map(([id, data]) => {
    if (!options.compress?.has(id))
      return { id, data, compressed: false, originalSize: data.length };
    const compressed = [...deflateSync(Uint8Array.from(data))];
    return { id, data: compressed, compressed: true, originalSize: data.length };
  });
  const dii = [
    ...u32(downloadId),
    ...u16(blockSize),
    0,
    0,
    ...u32(0),
    ...u32(0),
    ...u16(0), // compatibilityDescriptorLength
    ...u16(wire.length),
  ];
  for (const module of wire) {
    const descriptors = module.compressed ? [0x09, 0x04, ...u32(module.originalSize)] : [];
    const info = moduleInfo(descriptors);
    dii.push(...u16(module.id), ...u32(module.data.length), 0, info.length, ...info);
  }
  sections.push(dsmccSection(0x3b, 0x1002, dii));

  for (const module of wire) {
    for (let block = 0; block * blockSize < module.data.length; block += 1) {
      const slice = module.data.slice(block * blockSize, (block + 1) * blockSize);
      sections.push(dsmccSection(0x3c, 0x1003, [...u16(module.id), 0, 0, ...u16(block), ...slice]));
    }
  }

  return { sections, content };
}

/** Wrap the fixture in a small transport stream with PAT, PMT and a data PID. */
export function carouselTransportStream(options: CarouselFixtureOptions = {}): Uint8Array {
  const fixture = carouselFixture(options);
  const pat = buildSection(0x00, patBody([{ programNumber: 1, pid: 0x1000 }]), {
    tableIdExtension: 1,
  });
  const pmt = buildSection(0x02, pmtBody(0x0300, [{ streamType: 0x0c, pid: 0x0300 }]), {
    tableIdExtension: 1,
  });
  return concat([
    ...packetizeSection(0x0000, pat),
    ...packetizeSection(0x1000, pmt),
    ...fixture.sections.flatMap((section, index) => packetizeSection(0x0300, section, index % 16)),
  ]);
}
