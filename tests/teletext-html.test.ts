import { describe, expect, it } from 'vitest';
import type { ProbeResult, TeletextPage } from '@tsinspect/core';
import { formatTeletextHtml } from '../apps/cli/src/format/teletext.js';

const result = {
  source: { name: 'test.ts' },
  tool: { version: '0.0.0' },
} as unknown as ProbeResult;

const page: TeletextPage = {
  magazine: 1,
  page: 1,
  label: '1:01',
  subtitle: false,
  subset: 0,
  rows: ['RED'],
  rowNumbers: [1],
  rowData: [Uint8Array.from([0x01, 0x52, 0x45, 0x44])],
  text: 'RED',
};

describe('Teletext HTML', () => {
  it('renders coloured rows and header metadata', () => {
    const html = formatTeletextHtml(result, 0x100, [page]);
    expect(html).toContain('fg-red');
    expect(html).toContain('RED');
    expect(html).toContain('0x0100');
    expect(html).toContain('1 page(s)');
  });
});
