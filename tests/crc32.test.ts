import { describe, expect, it } from 'vitest';
import { crc32Mpeg2, isSectionCrcValid } from '@tsinspect/core';
import { buildSection } from './helpers.js';

describe('CRC-32/MPEG-2', () => {
  it('matches the standard check value', () => {
    const data = new TextEncoder().encode('123456789');
    expect(crc32Mpeg2(data)).toBe(0x0376e6e7);
  });

  it('validates a section with an appended CRC', () => {
    const section = buildSection(0x00, new Uint8Array([0x00, 0x01, 0xe0, 0x10]));
    expect(isSectionCrcValid(section)).toBe(true);
  });

  it('detects a corrupt section', () => {
    const section = buildSection(0x00, new Uint8Array([0x00, 0x01, 0xe0, 0x10]));
    section[8] = (section[8]! ^ 0xff) & 0xff;
    expect(isSectionCrcValid(section)).toBe(false);
  });
});
