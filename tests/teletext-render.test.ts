import { describe, expect, it } from 'vitest';
import { buildTeletextLayer, type TeletextPage } from '@tsinspect/core';

function ttxRow(values: number[]): Uint8Array {
  const row = new Uint8Array(40);
  row.fill(0x20);
  row.set(values);
  return row;
}

function pageWith(
  rowNumbers: number[],
  rowData: Uint8Array[],
  extra: Partial<TeletextPage> = {},
): TeletextPage {
  return {
    magazine: 1,
    page: 0x88,
    label: '1:88',
    subtitle: true,
    rows: [],
    rowNumbers,
    rowData,
    subset: 0,
    text: '',
    startTime: 1,
    ...extra,
  };
}

describe('Teletext layer', () => {
  it('decodes colours, background, double height and mosaics', () => {
    const page = pageWith(
      [1, 2],
      [
        ttxRow([0x07, 0x41, 0x42, 0x1c, 0x43]),
        ttxRow([0x0d, 0x44, 0x10, 0x3f]),
      ],
    );
    const layer = buildTeletextLayer(page);
    expect(layer.kind).toBe('teletext');
    expect(layer.columns).toBe(40);
    expect(layer.rows).toBe(25);
    expect(layer.lines.map((line) => line.row)).toEqual([1, 2]);

    const first = layer.lines[0]!.cells;
    expect(first[1]?.char).toBe('A');
    expect(first[1]?.fg).toBe(7);
    expect(first[4]?.char).toBe('C');
    expect(first[4]?.bg).toBe(0);

    const second = layer.lines[1]!.cells;
    expect(second[1]?.char).toBe('D');
    expect(second[1]?.doubleHeight).toBe(true);
    expect(second[3]?.mosaic).toBe(true);
    expect(second[3]?.mosaicBits).toBe(0x3f);
    expect(second[3]?.fg).toBe(0);
  });

  it('skips the page header row for subtitle pages', () => {
    const page = pageWith(
      [0, 1],
      [ttxRow([0x41]), ttxRow([0x42])],
    );
    const layer = buildTeletextLayer(page);
    expect(layer.lines.map((line) => line.row)).toEqual([1]);
    expect(layer.lines[0]!.cells[0]?.char).toBe('B');
  });

  it('decodes G2 supplementary characters after the escape code', () => {
    const page = pageWith([1], [ttxRow([0x41, 0x1b, 0x60, 0x42])]);
    const cells = buildTeletextLayer(page).lines[0]!.cells;

    expect(cells[0]?.char).toBe('A');
    expect(cells[1]?.char).toBe('\u03a9');
    expect(cells[2]?.char).toBe('B');
  });
});
