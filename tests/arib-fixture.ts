import {
  buildPacket,
  buildSection,
  concat,
  descriptor,
  packetizeSection,
  patBody,
  pmtBody,
} from './helpers.js';

function aribPayloadWithUnits(units: Array<{ parameter: number; data: number[] }>): Uint8Array {
  const unitBytes: number[] = [];
  for (const unit of units) {
    unitBytes.push(
      0x1f,
      unit.parameter,
      (unit.data.length >> 16) & 0xff,
      (unit.data.length >> 8) & 0xff,
      unit.data.length & 0xff,
      ...unit.data,
    );
  }
  const loopLength = unitBytes.length;
  const groupSize = loopLength + 4;
  return Uint8Array.from([
    0x80,
    0xff,
    0xf0,
    0x04,
    0x00,
    0x00,
    (groupSize >> 8) & 0xff,
    groupSize & 0xff,
    0x3f,
    (loopLength >> 16) & 0xff,
    (loopLength >> 8) & 0xff,
    loopLength & 0xff,
    ...unitBytes,
  ]);
}

function ptsBytes(value: number): Uint8Array {
  return Uint8Array.from([
    0x21 | (((value / 0x40000000) & 0x07) << 1),
    (value >> 22) & 0xff,
    (((value >> 15) & 0x7f) << 1) | 1,
    (value >> 7) & 0xff,
    ((value & 0x7f) << 1) | 1,
  ]);
}

function packetizePes(pid: number, pes: Uint8Array, ccStart = 0): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let offset = 0;
  let cc = ccStart;
  let first = true;
  while (offset < pes.length) {
    const take = Math.min(184, pes.length - offset);
    const payload = new Uint8Array(184);
    payload.fill(0xff);
    payload.set(pes.subarray(offset, offset + take), 0);
    packets.push(buildPacket(pid, payload, { pusi: first, cc }));
    offset += take;
    first = false;
    cc = (cc + 1) & 0x0f;
  }
  return packets;
}

/**
 * Minimal ISDB-T fixture with one ARIB caption PES: a DRCS-1 glyph (the
 * Annex D example `⁈`) followed by `心の声 お別れ` and the DRCS reference.
 */
export function buildAribDrcsFixture(): Uint8Array {
  const drcs = [
    0x01, 0x41, 0x21, 0x01, 0x00, 0x00, 0x10, 0x12,
    0x00, 0x00, 0x0e, 0x08, 0x13, 0x0c, 0x31, 0x9c,
    0x31, 0x98, 0x03, 0x18, 0x06, 0x10, 0x0c, 0x10,
    0x18, 0x30, 0x10, 0x20, 0x10, 0x20, 0x00, 0x00,
    0x00, 0x00, 0x20, 0x40, 0x70, 0xe0, 0x20, 0x40,
    0x00, 0x00, 0x00, 0x00,
  ];
  const statement = [
    0x0c, 0x87, 0x8a, 0xbf, 0xb4, 0xa4, 0xce, 0xc0,
    0xbc, 0x20, 0xa4, 0xaa, 0xca, 0xcc, 0xa4, 0xec,
    0x21,
  ];
  const payload = aribPayloadWithUnits([
    { parameter: 0x30, data: drcs },
    { parameter: 0x20, data: statement },
  ]);

  const pts = 90000;
  const pes = concat([
    Uint8Array.from([
      0x00,
      0x00,
      0x01,
      0xbd,
      ((payload.length + 8) >> 8) & 0xff,
      (payload.length + 8) & 0xff,
      0x80,
      0x80,
      0x05,
    ]),
    ptsBytes(pts),
    payload,
  ]);

  const pat = buildSection(0x00, patBody([{ programNumber: 1, pid: 0x100 }]), {
    tableIdExtension: 1,
  });
  const pmt = buildSection(
    0x02,
    pmtBody(0x102, [
      {
        streamType: 0x06,
        pid: 0x102,
        descriptors: descriptor(0xfd, Uint8Array.from([0x00, 0x08])),
      },
    ]),
    { tableIdExtension: 1 },
  );

  const packets: Uint8Array[] = [];
  for (let i = 0; i < 3; i += 1) {
    packets.push(...packetizeSection(0x00, pat, i));
    packets.push(...packetizeSection(0x100, pmt, i));
  }
  packets.push(...packetizePes(0x102, pes));
  return concat(packets);
}
