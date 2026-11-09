import { describe, expect, it } from 'vitest';
import {
  crc32Mpeg2,
  PesAssembler,
  parseAtscCaptionPayload,
  parseScte35Section,
  parseVbiPes,
  collectTeletextPages,
  extractAribCaptionStyled,
  extractAribCaptionText,
  indexDvbSubtitlePes,
  parseTeletextPes,
  reverse8,
  unham84,
  TeletextCollector,
} from '@tsinspect/core';

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((part) => Number.parseInt(part, 16)),
  );
}

/** Build a synchronized caption PES around one or more data units. */
function aribPayloadWithUnits(
  units: Array<{ parameter: number; data: number[] }>,
): Uint8Array {
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

/** Build a synchronized caption PES around a 0x20 statement body. */
function aribPayload(body: number[]): Uint8Array {
  return aribPayloadWithUnits([{ parameter: 0x20, data: body }]);
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

describe('PES assembly', () => {
  it('assembles a PES packet split over two pushes', () => {
    const payload = new TextEncoder().encode('hello PES');
    const headerLength = 5;
    const pes = new Uint8Array(4 + 2 + 3 + headerLength + payload.length);
    pes.set([0x00, 0x00, 0x01, 0xbd], 0);
    const packetLength = 3 + headerLength + payload.length;
    pes[4] = (packetLength >> 8) & 0xff;
    pes[5] = packetLength & 0xff;
    pes[6] = 0x80;
    pes[7] = 0x80;
    pes[8] = headerLength;
    pes.set(ptsBytes(90_000), 9);
    pes.set(payload, 14);

    const assembler = new PesAssembler(0x100);
    const first = assembler.push(pes.subarray(0, 10), true, 1, 0);
    expect(first).toHaveLength(0);
    const second = assembler.push(pes.subarray(10), false, 2, 188);
    expect(second).toHaveLength(1);
    expect(second[0]?.streamId).toBe(0xbd);
    expect(second[0]?.pts).toBe(90_000);
    expect(second[0]?.ptsSeconds).toBe(1);
    expect(second[0]?.payload).toEqual(payload);
  });
});

describe('Teletext', () => {
  function hamming(nibble: number): number {
    for (let value = 0; value < 256; value += 1) {
      if (unham84(reverse8(value)) === nibble) return value;
    }
    throw new Error('no Hamming code');
  }

  function oddParity(character: number): number {
    let value = character & 0x7f;
    let ones = 0;
    for (let i = 0; i < 7; i += 1) ones += (value >> i) & 1;
    if (ones % 2 === 0) value |= 0x80;
    return reverse8(value);
  }

  function unit(
    row: number,
    magazine: number,
    page: number,
    text: string,
    options: {
      subset?: number;
      subtitle?: boolean;
      erase?: boolean;
      inhibit?: boolean;
      serial?: boolean;
      unitId?: number;
      /** Raw G0 bytes (before odd-parity coding) for row text. */
      data?: number[];
    } = {},
  ): number[] {
    const address = (row << 3) | (magazine & 0x07);
    const data = new Array<number>(40).fill(0x20);
    if (row === 0) {
      const subset = options.subset ?? 0;
      data[0] = hamming(page & 0x0f);
      data[1] = hamming((page >> 4) & 0x0f);
      data[3] = hamming(options.erase ? 0x08 : 0);
      data[5] = hamming(options.subtitle ? 0x08 : 0);
      data[6] = hamming(options.inhibit ? 0x08 : 0);
      data[7] = hamming((subset << 1) | (options.serial ? 1 : 0));
    } else if (options.data !== undefined) {
      for (let i = 0; i < Math.min(40, options.data.length); i += 1) {
        data[i] = oddParity(options.data[i] as number);
      }
    } else {
      for (let i = 0; i < Math.min(40, text.length); i += 1) {
        data[i] = oddParity(text.charCodeAt(i));
      }
    }
    const packet = new Array<number>(44).fill(0);
    packet[0] = 0;
    packet[1] = reverse8(0xe4);
    packet[2] = hamming(address & 0x0f);
    packet[3] = hamming((address >> 4) & 0x0f);
    packet.splice(4, 40, ...data);
    return [options.unitId ?? 0x03, 44, ...packet];
  }

  it('parses a subtitle page and its text rows', () => {
    const payload = Uint8Array.from([
      0x10,
      ...unit(0, 1, 0x00, '', { subtitle: true }),
      ...unit(1, 1, 0x00, 'HELLO'),
    ]);
    const pes = parseTeletextPes(payload);
    expect(pes?.subtitlePackets).toBe(1);
    const pages = collectTeletextPages(pes!);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.label).toBe('1:00');
    expect(pages[0]?.subtitle).toBe(true);
    expect(pages[0]?.text).toBe('HELLO');
  });

  it('classifies subtitle pages by C6, not by the data unit id', () => {
    const payload = Uint8Array.from([
      0x10,
      // Page 1:99 is carried in a subtitle data unit but has C6 clear.
      ...unit(0, 1, 0x99, '', { unitId: 0x03 }),
      ...unit(1, 1, 0x99, 'CREW'),
      // Page 1:88 has C6 set even in a normal data unit.
      ...unit(0, 1, 0x88, '', { subtitle: true, unitId: 0x02 }),
      ...unit(1, 1, 0x88, 'SUBTITLE'),
    ]);
    const pages = collectTeletextPages(parseTeletextPes(payload)!);
    expect(pages.find((page) => page.label === '1:99')?.subtitle).toBe(false);
    expect(pages.find((page) => page.label === '1:88')?.subtitle).toBe(true);
  });

  it('re-decodes rows with the final national option subset', () => {
    const payload = Uint8Array.from([
      0x10,
      ...unit(0, 1, 0x78, '', { subtitle: true, subset: 0 }),
      ...unit(1, 1, 0x78, '', { data: [0x43, 0x69, 0x74, 0x74, 0xfb] }),
      ...unit(0, 1, 0x78, '', { subtitle: true, subset: 6 }),
    ]);
    const page = collectTeletextPages(parseTeletextPes(payload)!).find(
      (entry) => entry.label === '1:78',
    );
    expect(page?.subset).toBe(6);
    expect(page?.text).toContain('Città');
  });

  it('decodes page header control bits C4 to C14', () => {
    const payload = Uint8Array.from([
      0x10,
      ...unit(0, 1, 0x01, '', {
        erase: true,
        inhibit: true,
        serial: true,
        subset: 5,
      }),
    ]);
    const packet = parseTeletextPes(payload)?.packets[0];
    expect(packet?.control).toEqual({
      erasePage: true,
      newsflash: false,
      subtitle: false,
      suppressHeader: false,
      updateIndicator: false,
      interruptedSequence: false,
      inhibitDisplay: true,
      magazineSerial: true,
      nationalSubset: 5,
    });
  });

  it('keeps short subtitle lines', () => {
    const payload = Uint8Array.from([
      0x10,
      ...unit(0, 8, 0x88, '', { subtitle: true }),
      ...unit(1, 8, 0x88, 'Ja, in 2012'),
      ...unit(2, 8, 0x88, 'was mijn eerste marathon.'),
    ]);
    const pages = collectTeletextPages(parseTeletextPes(payload)!);
    expect(pages[0]?.subtitle).toBe(true);
    expect(pages[0]?.rows).toEqual(['Ja, in 2012', 'was mijn eerste marathon.']);
  });

  it('ignores mosaic graphics when rendering text rows', () => {
    const payload = Uint8Array.from([
      0x10,
      ...unit(0, 1, 0x01, ''),
      // Row 1 is a mosaic graphic: 0x10 selects mosaics, then graphic bytes.
      ...unit(1, 1, 0x01, '', { data: [0x10, 0x23, 0x24, 0x7f, 0x3f] }),
      // Row 2 switches back to alpha with 0x07 before real text.
      ...unit(2, 1, 0x01, '', { data: [0x10, 0x23, 0x07, 0x54, 0x45, 0x58, 0x54] }),
    ]);
    const pages = collectTeletextPages(parseTeletextPes(payload)!);
    expect(pages[0]?.rows).toEqual(['   TEXT']);
    expect(pages[0]?.text).toBe('TEXT');
  });

  it('merges repeated headers while C4 is clear', () => {
    const first = Uint8Array.from([
      0x10,
      ...unit(0, 1, 0x01, ''),
      ...unit(1, 1, 0x01, 'ONE'),
    ]);
    const second = Uint8Array.from([
      0x10,
      ...unit(2, 1, 0x01, 'TWO'),
      ...unit(0, 1, 0x01, ''),
      ...unit(3, 1, 0x01, 'THREE'),
    ]);
    const third = Uint8Array.from([
      0x10,
      ...unit(0, 1, 0x02, ''),
      ...unit(1, 1, 0x02, 'NEXT'),
    ]);

    const collector = new TeletextCollector();
    collector.push(parseTeletextPes(first)!, 1);
    expect(collector.push(parseTeletextPes(second)!, 2)).toHaveLength(0);

    const completed = collector.push(parseTeletextPes(third)!, 3);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.label).toBe('1:01');
    expect(completed[0]?.rows).toEqual(['ONE', 'TWO', 'THREE']);
    expect(completed[0]?.startTime).toBe(1);

    const flushed = collector.flush();
    expect(flushed[0]?.label).toBe('1:02');
    expect(flushed[0]?.text).toBe('NEXT');
  });

  it('starts a fresh page when C4 erase is set', () => {
    const first = Uint8Array.from([
      0x10,
      ...unit(0, 1, 0x01, ''),
      ...unit(1, 1, 0x01, 'ONE'),
    ]);
    const second = Uint8Array.from([
      0x10,
      ...unit(0, 1, 0x01, '', { erase: true }),
      ...unit(1, 1, 0x01, 'TWO'),
    ]);

    const collector = new TeletextCollector();
    collector.push(parseTeletextPes(first)!, 1);
    const completed = collector.push(parseTeletextPes(second)!, 2);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.rows).toEqual(['ONE']);

    const flushed = collector.flush();
    expect(flushed[0]?.rows).toEqual(['TWO']);
  });

  it('collects a page spread across PES packets', () => {
    const first = Uint8Array.from([
      0x10,
      ...unit(0, 1, 0x01, ''),
      ...unit(1, 1, 0x01, 'LINE ONE'),
    ]);
    const second = Uint8Array.from([
      0x10,
      ...unit(2, 1, 0x01, 'LINE TWO'),
      ...unit(0, 1, 0x02, ''),
      ...unit(1, 1, 0x02, 'SECOND PAGE'),
    ]);
    const collector = new TeletextCollector();
    expect(collector.push(parseTeletextPes(first)!, 1)).toHaveLength(0);
    const completed = collector.push(parseTeletextPes(second)!, 2);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.label).toBe('1:01');
    expect(completed[0]?.text).toContain('LINE ONE');
    expect(completed[0]?.text).toContain('LINE TWO');
    expect(completed[0]?.startTime).toBe(1);

    const flushed = collector.flush();
    expect(flushed[0]?.label).toBe('1:02');
    expect(flushed[0]?.text).toBe('SECOND PAGE');
  });

  it('applies Latin national option subsets', () => {
    const payload = Uint8Array.from([
      0x10,
      ...unit(0, 1, 0x00, '', { subset: 4 }),
      ...unit(1, 1, 0x00, 'H\x7bllo'),
    ]);
    const pages = collectTeletextPages(parseTeletextPes(payload)!);
    expect(pages[0]?.text).toBe('Hällo');
  });

  it('parses Teletext units carried in a VBI PES', () => {
    const payload = Uint8Array.from([
      0x10,
      0x06,
      0x03,
      0xa1,
      0xb2,
      0xc3,
      ...unit(0, 1, 0x00, ''),
      ...unit(1, 1, 0x00, 'VBI TEXT'),
    ]);
    const vbi = parseVbiPes(payload);
    expect(vbi?.units.map((unit) => unit.id)).toEqual([0x06, 0x03, 0x03]);

    const teletext = parseTeletextPes(payload);
    const pages = collectTeletextPages(teletext!);
    expect(pages[0]?.text).toBe('VBI TEXT');
  });
});

describe('ISDB-Tb captions and DVB subtitles', () => {
  it('extracts a Brazilian ARIB caption statement', () => {
    const payload = bytes(
      '80 FF F0 04 00 00 00 37 3F 00 00 33 1F 20 00 00 2E 0C 87 89 50 49 41 43 41 4E 4A 55 42 41 2E 20 0D 3E 3E 5B 45 56 45 52 41 4C 44 4F 20 4D 41 52 51 55 45 53 5D 3A 20 41 51 55 49 2C 20 41 20 65',
    );
    const caption = extractAribCaptionText(payload, 'brazil');
    expect(caption?.text).toContain('PIACANJUBA');
    expect(caption?.text).toContain('EVERALDO MARQUES');
  });

  it('extracts EUC-JP Japanese superimpose text', () => {
    const payload = bytes(
      '80 FF F0 04 00 00 00 18 3F 00 00 14 1F 20 00 00 0F 0C 87 8A A5 B3 A5 E1 A5 F3 A5 C8 A4 B7 A1 A2 34 3A',
    );
    const caption = extractAribCaptionText(payload, 'japan');
    expect(caption?.text).toBe('コメントし、');
  });

  it('decodes ARIB foreground colour and character size', () => {
    // CS, CNF (cyan), MSZ (medium width), コ
    const payload = aribPayload([0x0c, 0x86, 0x89, 0xa5, 0xb3]);
    const caption = extractAribCaptionStyled(payload, 'japan');
    expect(caption?.text).toBe('コ');
    expect(caption?.styled).toBe(true);
    const run = caption?.lines[0]?.runs[0];
    expect(run?.style.color).toBe('#00ffff');
    expect(run?.style.size).toBe('medium');
    expect(run?.style.widthScale).toBe(0.5);
  });

  it('decodes ARIB cell and CSI positions', () => {
    // CS, APS row 2 / column 3, コ
    const aps = extractAribCaptionStyled(
      aribPayload([0x0c, 0x87, 0x8a, 0x1c, 0x42, 0x43, 0xa5, 0xb3]),
      'japan',
    );
    expect(aps?.lines[0]?.row).toBe(2);
    expect(aps?.lines[0]?.column).toBe(3);

    // CS, WHF, NSZ, ACPS 100;200a, コ
    const acps = extractAribCaptionStyled(
      aribPayload([
        0x0c, 0x87, 0x8a, 0x9b, 0x31, 0x30, 0x30, 0x3b, 0x32, 0x30, 0x30, 0x61, 0xa5, 0xb3,
      ]),
      'japan',
    );
    expect(acps?.lines[0]?.x).toBe(100);
    expect(acps?.lines[0]?.y).toBe(200);
    expect(acps?.text).toBe('コ');
  });

  it('decodes the SWF vertical writing format and cell metrics', () => {
    // SWF 10 (720x480 vertical), SSM 16;16, SHS 2, SVS 8, SDF 48;144,
    // SDP 300;300, then two Latin lines.
    const payload = aribPayload([
      0x0c,
      0x9b, 0x31, 0x30, 0x53,
      0x9b, 0x31, 0x36, 0x3b, 0x31, 0x36, 0x57,
      0x9b, 0x32, 0x58,
      0x9b, 0x38, 0x59,
      0x9b, 0x34, 0x38, 0x3b, 0x31, 0x34, 0x34, 0x56,
      0x9b, 0x33, 0x30, 0x30, 0x3b, 0x33, 0x30, 0x30, 0x5f,
      0x74, 0x65, 0x73, 0x74, 0x0a,
      0x56, 0x65, 0x72, 0x74, 0x69, 0x63, 0x61, 0x6c,
    ]);
    const caption = extractAribCaptionStyled(payload, 'brazil');
    expect(caption?.display).toMatchObject({
      format: 10,
      vertical: true,
      planeWidth: 720,
      planeHeight: 480,
      width: 48,
      height: 144,
      x: 300,
      y: 300,
      fontWidth: 16,
      fontHeight: 16,
      horizontalSpacing: 2,
      verticalSpacing: 8,
    });
    expect(caption?.metrics).toMatchObject({
      planeWidth: 720,
      planeHeight: 480,
      fontWidth: 16,
      fontHeight: 16,
      horizontalSpacing: 2,
      verticalSpacing: 8,
      charWidth: 18,
      charHeight: 24,
    });
    expect(caption?.lines.map((line) => line.runs[0]?.text)).toEqual([
      'test',
      'Vertical',
    ]);
  });

  it('decodes ARIB underline, ornament and font style', () => {
    // CS, STL underline, CSI 1 d (bold), CSI 2;7 c (shadow, white), コ
    const payload = aribPayload([
      0x0c, 0x9a, 0x9b, 0x31, 0x64, 0x9b, 0x32, 0x3b, 0x37, 0x63, 0xa5, 0xb3,
    ]);
    const caption = extractAribCaptionStyled(payload, 'japan');
    const style = caption?.lines[0]?.runs[0]?.style;
    expect(style?.underline).toBe(true);
    expect(style?.bold).toBe(true);
    expect(style?.ornament).toBe('shadow');
    expect(style?.ornamentColor).toBe('#ffffff');
  });

  it('decodes DRCS glyphs and C-profile font metrics', () => {
    // ARIB STD-B24 Annex D example: DRCS-1 code 0x21, 16x18 pixels, depth 0.
    const drcs = bytes(
      '01 41 21 01 00 00 10 12 00 00 0E 08 13 0C 31 9C 31 98 03 18 06 10 0C 10 18 30 10 20 10 20 00 00 00 00 20 40 70 E0 20 40 00 00 00 00',
    );
    // CS, WHF, NSZ, 心の声 お別れ, DRCS 0x21.
    const statement = bytes('0C 87 8A BF B4 A4 CE C0 BC 20 A4 AA CA CC A4 EC 21');
    const payload = aribPayloadWithUnits([
      { parameter: 0x30, data: [...drcs] },
      { parameter: 0x20, data: [...statement] },
    ]);
    const caption = extractAribCaptionStyled(payload, 'japan', {
      displayWidth: 320,
      displayHeight: 180,
    });
    expect(caption?.text).toContain('心の声 お別れ');
    expect(caption?.text.endsWith('\u3013')).toBe(true);
    expect(caption?.drcs).toHaveLength(1);
    const glyph = caption?.drcs?.[0];
    expect(glyph?.set).toBe(1);
    expect(glyph?.code).toBe(0x21);
    expect(glyph?.width).toBe(16);
    expect(glyph?.height).toBe(18);
    expect(glyph?.pixels).toHaveLength(16 * 18);
    expect(glyph?.pixels.some((value) => value > 0)).toBe(true);
    expect(caption?.metrics).toMatchObject({
      profile: 'C',
      planeWidth: 320,
      planeHeight: 180,
      fontWidth: 18,
      fontHeight: 18,
      charWidth: 20,
      charHeight: 30,
    });
    // The PUA character stays in the styled run for the renderer.
    const runs = caption?.lines[0]?.runs ?? [];
    expect(runs[runs.length - 1]?.text.endsWith(glyph?.char ?? '')).toBe(true);
  });

  it('infers A-profile font metrics for full-service video', () => {
    const payload = aribPayload([0x0c, 0x87, 0x8a, 0xa5, 0xb3]);
    const caption = extractAribCaptionStyled(payload, 'japan', {
      displayWidth: 1920,
      displayHeight: 1080,
    });
    expect(caption?.metrics).toMatchObject({
      profile: 'A',
      planeWidth: 960,
      planeHeight: 540,
      fontWidth: 36,
      fontHeight: 36,
      charWidth: 40,
      charHeight: 60,
      display: { x: 170, y: 30, width: 620, height: 480 },
    });
  });

  it('replaces a DRCS-only C-profile statement', () => {
    const drcs = bytes(
      '01 41 21 01 00 00 10 12 00 00 0E 08 13 0C 31 9C 31 98 03 18 06 10 0C 10 18 30 10 20 10 20 00 00 00 00 20 40 70 E0 20 40 00 00 00 00',
    );
    const payload = aribPayloadWithUnits([
      { parameter: 0x30, data: [...drcs] },
      { parameter: 0x20, data: [0x0c, 0x87, 0x8a, 0x21] },
    ]);
    const caption = extractAribCaptionStyled(payload, 'japan', {
      displayWidth: 320,
      displayHeight: 180,
    });
    expect(caption?.text).toBe('\u3013');
    expect(caption?.drcs).toHaveLength(1);
  });

  it('indexes DVB subtitle segments', () => {
    const payload = bytes(
      '20 00 0F 14 00 01 00 05 00 07 7F 04 37 0F 10 00 01 00 02 0A D0 0F 80 00 01 00 00 FF',
    );
    const index = indexDvbSubtitlePes(payload);
    expect(index?.subtitleStreamId).toBe(0);
    expect(index?.segments.map((segment) => segment.type)).toEqual([0x14, 0x10, 0x80]);
    expect(index?.segments[0]?.typeName).toBe('display-definition');
    expect(index?.segments[1]?.typeName).toBe('page-composition');
    expect(index?.segments.every((segment) => segment.pageId === 1)).toBe(true);
    expect(index?.segments[0]?.fields).toMatchObject({
      version: 0,
      displayWindowFlag: false,
      displayWidth: 1919,
      displayHeight: 1079,
    });
    expect(index?.segments[1]?.fields).toMatchObject({
      pageTimeOut: 10,
      version: 13,
      state: 0,
    });
    expect(index?.segments[2]?.fields).toBeUndefined();
  });

  it('parses DVB subtitle region, object and CLUT fields', () => {
    const payload = bytes(
      '20 00 ' +
        '0F 11 00 01 00 0A 01 50 07 80 04 38 28 01 FF FF ' +
        '0F 13 00 01 00 07 00 01 00 00 03 00 02 ' +
        '0F 12 00 01 00 08 01 20 00 00 00 00 00 00',
    );
    const index = indexDvbSubtitlePes(payload);
    expect(index?.segments[0]?.fields).toMatchObject({
      regionId: 1,
      version: 5,
      fill: false,
      width: 1920,
      height: 1080,
      levelOfCompatibility: 1,
      depth: 2,
      clutId: 1,
      pixel8: 255,
      pixel4: 15,
      pixel2: 3,
    });
    expect(index?.segments[1]?.fields).toMatchObject({
      objectId: 1,
      codingMethod: 0,
      nonModifyingColor: false,
      topFieldLength: 3,
      bottomFieldLength: 2,
    });
    expect(index?.segments[2]?.fields).toMatchObject({
      clutId: 1,
      version: 2,
      entryBytes: 6,
    });
  });
});

describe('VBI, SCTE-35 and ATSC captions', () => {
  it('indexes VBI data units', () => {
    const vbi = parseVbiPes(bytes('10 06 03 A1 B2 C3'));
    expect(vbi?.units).toHaveLength(1);
    expect(vbi?.units[0]?.id).toBe(0x06);
    expect(vbi?.units[0]?.name).toBe('Closed caption');
    expect(vbi?.units[0]?.raw).toBe('A1 B2 C3');
  });

  it('parses a SCTE-35 splice_null section', () => {
    const body = bytes(
      '00 00 00 00 00 00 00 00 FF F0 00 00 00 00',
    );
    const section = new Uint8Array(3 + body.length + 4);
    section[0] = 0xfc;
    section[1] = 0x30 | (((body.length + 4) >> 8) & 0x0f);
    section[2] = (body.length + 4) & 0xff;
    section.set(body, 3);
    const crc = crc32Mpeg2(section.subarray(0, section.length - 4));
    const at = section.length - 4;
    section[at] = (crc >>> 24) & 0xff;
    section[at + 1] = (crc >>> 16) & 0xff;
    section[at + 2] = (crc >>> 8) & 0xff;
    section[at + 3] = crc & 0xff;

    const parsed = parseScte35Section(section);
    expect(parsed?.commandType).toBe(0x00);
    expect(parsed?.commandName).toBe('splice_null');
    expect(parsed?.crcValid).toBe(true);
  });

  it('parses a real time_signal with a segmentation descriptor', () => {
    const section = bytes(
      'fc 30 2c 00 00 00 00 00 00 00 ff f0 05 06 fe 00 06 0a e0 00 16 02 14 ' +
        '43 55 45 49 00 00 05 39 7f ff 00 00 1b 77 40 00 00 22 00 00 7e 3b f0 a1',
    );
    const parsed = parseScte35Section(section);
    expect(parsed?.commandName).toBe('time_signal');
    expect(parsed?.spliceTime).toBe(396_000);
    expect(parsed?.crcValid).toBe(true);
    expect(parsed?.segmentation?.identifier).toBe('CUEI');
    expect(parsed?.segmentation?.eventId).toBe(1337);
    expect(parsed?.segmentation?.typeId).toBe(0x22);
    expect(parsed?.segmentation?.typeName).toBe('Break start');
    expect(parsed?.segmentation?.duration).toBe(1_800_000);
    expect(parsed?.segmentation?.segmentNum).toBe(0);
    expect(parsed?.segmentation?.segmentsExpected).toBe(0);
  });

  it('parses a real splice_insert with auto return', () => {
    const section = bytes(
      'fc 30 25 00 00 00 00 00 00 00 ff f0 14 05 00 00 00 7b 7f ef fe 00 31 58 ' +
        'd0 fe 00 0d bb a0 00 01 00 00 00 00 63 27 90 9a',
    );
    const parsed = parseScte35Section(section);
    expect(parsed?.commandName).toBe('splice_insert');
    expect(parsed?.eventId).toBe(123);
    expect(parsed?.eventCancel).toBe(false);
    expect(parsed?.outOfNetwork).toBe(true);
    expect(parsed?.spliceImmediate).toBe(false);
    expect(parsed?.spliceTime).toBe(3_234_000);
    expect(parsed?.breakDuration).toBe(900_000);
    expect(parsed?.autoReturn).toBe(true);
    expect(parsed?.uniqueProgramId).toBe(1);
    expect(parsed?.availNum).toBe(0);
    expect(parsed?.availsExpected).toBe(0);
    expect(parsed?.crcValid).toBe(true);
  });

  it('parses a private_command identifier and payload', () => {
    const body = bytes(
      '00 00 00 00 00 00 00 ff f0 07 ff 43 55 45 49 01 02 03 00 00',
    );
    const section = new Uint8Array(3 + body.length + 4);
    section[0] = 0xfc;
    section[1] = 0x30 | (((body.length + 4) >> 8) & 0x0f);
    section[2] = (body.length + 4) & 0xff;
    section.set(body, 3);
    const crc = crc32Mpeg2(section.subarray(0, section.length - 4));
    const at = section.length - 4;
    section[at] = (crc >>> 24) & 0xff;
    section[at + 1] = (crc >>> 16) & 0xff;
    section[at + 2] = (crc >>> 8) & 0xff;
    section[at + 3] = crc & 0xff;

    const parsed = parseScte35Section(section);
    expect(parsed?.commandName).toBe('private_command');
    expect(parsed?.privateIdentifier).toBe('43 55 45 49');
    expect(parsed?.privateData).toBe('01 02 03');
    expect(parsed?.crcValid).toBe(true);
  });

  it('decodes CEA-608 text from GA94 cc_data', () => {
    const payload = bytes('47 41 39 34 03 84 00 FC 48 49 FC 14 2C FF');
    const caption = parseAtscCaptionPayload(payload);
    expect(caption?.lines).toEqual(['HI']);
    expect(caption?.units).toHaveLength(2);
    expect(caption?.units[0]?.ccType).toBe(0);
  });

  it('decodes CEA-708 service text from GA94 cc_data', () => {
    const payload = bytes('47 41 39 34 03 86 FF FF 83 22 FE 48 49 FE 00 00 FF');
    const caption = parseAtscCaptionPayload(payload);
    expect(caption?.dtvccText).toBe('HI');
  });
});
