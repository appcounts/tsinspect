import { describe, expect, it } from 'vitest';
import {
  Atsc608Decoder,
  Atsc708Decoder,
  type AtscCaptionUnit,
} from '@tsinspect/core';

function unit(ccType: number, data1: number, data2: number): AtscCaptionUnit {
  return { valid: true, ccType, data1, data2 };
}

function textUnits(text: string): AtscCaptionUnit[] {
  const bytes = [...text].map((character) => character.charCodeAt(0));
  const units: AtscCaptionUnit[] = [];
  for (let index = 0; index < bytes.length; index += 2) {
    units.push(unit(0, bytes[index] ?? 0, bytes[index + 1] ?? 0));
  }
  return units;
}

function dtvccPacket(serviceData: number[]): AtscCaptionUnit[] {
  const packetWords = Math.ceil((1 + 1 + serviceData.length) / 2);
  const packet = [
    packetWords & 0x3f,
    0x20 | serviceData.length,
    ...serviceData,
  ];
  while (packet.length < packetWords * 2) packet.push(0);
  const units: AtscCaptionUnit[] = [];
  for (let index = 0; index < packet.length; index += 2) {
    units.push(
      unit(index === 0 ? 3 : 2, packet[index] ?? 0, packet[index + 1] ?? 0),
    );
  }
  return units;
}

describe('ATSC CEA-608 decoder', () => {
  it('decodes a pop-on caption and keeps its row', () => {
    const decoder = new Atsc608Decoder();
    decoder.pushUnits([
      unit(0, 0x14, 0x2c), // EDM
      unit(0, 0x14, 0x20), // RCL
      unit(0, 0x14, 0x2e), // ENM
      unit(0, 0x14, 0x70), // PAC row 15, indent 0
      ...textUnits('HI'),
      unit(0, 0x14, 0x2f), // EOC
    ]);
    const snapshot = decoder.snapshot();
    expect(snapshot?.text).toBe('HI');
    expect(snapshot?.rows[14]?.map((cell) => cell?.char ?? ' ').join('').trim()).toBe('HI');
    expect(snapshot?.mode).toBe('pop-on');
  });

  it('decodes mid-row colour and underline', () => {
    const decoder = new Atsc608Decoder();
    decoder.pushUnits([
      unit(0, 0x14, 0x2c),
      unit(0, 0x14, 0x20),
      unit(0, 0x14, 0x2e),
      unit(0, 0x14, 0x70),
      unit(0, 0x11, 0x23), // mid-row: green + underline
      ...textUnits('GO'),
      unit(0, 0x14, 0x2f),
    ]);
    const snapshot = decoder.snapshot();
    const row = snapshot?.rows[14] ?? [];
    const cells = row.filter((cell) => cell?.char === 'G' || cell?.char === 'O');
    expect(cells.map((cell) => cell?.char)).toEqual(['G', 'O']);
    expect(cells[0]?.pen.color).toBe('green');
    expect(cells[0]?.pen.underline).toBe(true);
  });

  it('rolls up displayed rows on carriage return', () => {
    const decoder = new Atsc608Decoder();
    decoder.pushUnits([
      unit(0, 0x14, 0x2c),
      unit(0, 0x14, 0x25), // RU2
      unit(0, 0x14, 0x70), // PAC row 15
      ...textUnits('ONE'),
      unit(0, 0x14, 0x2d), // CR
      ...textUnits('TWO'),
    ]);
    const snapshot = decoder.snapshot();
    expect(snapshot?.text).toBe('ONE\nTWO');
  });
});

describe('ATSC CEA-708 decoder', () => {
  it('decodes a visible window with text', () => {
    const decoder = new Atsc708Decoder();
    decoder.pushUnits(
      dtvccPacket([
        0x98, // DefineWindow0
        0x38, // visible, row lock, column lock
        85, // anchor vertical
        104, // anchor horizontal
        0x71, // bottom-centre, 2 rows
        31, // 32 columns
        0x09, // window style 1, pen style 1
        0x80, // SetCurrentWindow0
        0x88, 0x01, // ClearWindows window 0
        0x48, 0x45, 0x4c, 0x4c, 0x4f, // HELLO
        0x03, // ETX
        0x89, 0x01, // DisplayWindows window 0
      ]),
    );
    const snapshot = decoder.snapshot();
    expect(snapshot?.service).toBe(1);
    expect(snapshot?.windows).toHaveLength(1);
    expect(snapshot?.windows[0]?.visible).toBe(true);
    expect(snapshot?.windows[0]?.rowCount).toBe(2);
    expect(snapshot?.windows[0]?.columnCount).toBe(32);
    expect(snapshot?.text).toBe('HELLO');
  });

  it('applies pen colours and italics', () => {
    const decoder = new Atsc708Decoder();
    decoder.pushUnits(
      dtvccPacket([
        0x98,
        0x38,
        85,
        104,
        0x71,
        31,
        0x09,
        0x80,
        0x88,
        0x01,
        0x90,
        0x05,
        0x80, // SPA: italics
        0x91,
        0x30,
        0x00,
        0x00, // SPC: red foreground
        0x48,
        0x49, // HI
        0x03,
        0x89,
        0x01,
      ]),
    );
    const snapshot = decoder.snapshot();
    const cell = snapshot?.windows[0]?.rows[0]?.find((entry) => entry?.char === 'H');
    expect(cell?.fg).toBe('#ff0000');
    expect(cell?.italics).toBe(true);
  });

  it('ignores a hidden window', () => {
    const decoder = new Atsc708Decoder();
    decoder.pushUnits(
      dtvccPacket([
        0x98,
        0x18, // hidden, row lock, column lock
        85,
        104,
        0x71,
        31,
        0x09,
        0x80,
        0x88,
        0x01,
        0x48,
        0x49,
      ]),
    );
    expect(decoder.snapshot()).toBeUndefined();
  });
});
