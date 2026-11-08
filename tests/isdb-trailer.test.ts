import { describe, expect, it } from 'vitest';
import { parseIsdbTrailer } from '@tsinspect/core';

describe('ISDB-T packet trailer', () => {
  it('decodes the ARIB STD-B31 fields', () => {
    const trailer = parseIsdbTrailer(
      Uint8Array.from([0xa9, 0x2f, 0xe7, 0xd4, 0xff, 0xff, 0xff, 0xff]),
    );
    expect(trailer).not.toBeNull();
    expect(trailer?.tmccIdentifier).toBe(2);
    expect(trailer?.emergencyControlFlag).toBe(true);
    expect(trailer?.bufferResetControl).toBe(false);
    expect(trailer?.frameIndicator).toBe(true);
    expect(trailer?.initializationTimingHead).toBe(false);
    expect(trailer?.frameHead).toBe(false);
    expect(trailer?.layerIndicator).toBe(2);
    expect(trailer?.countDownIndex).toBe(15);
    expect(trailer?.tspCounter).toBe(2004);
    expect(trailer?.acDataInvalid).toBe(true);
    expect(trailer?.iip).toBe(false);
  });

  it('marks layer 8 as the IIP', () => {
    const trailer = parseIsdbTrailer(
      Uint8Array.from([0x81, 0x80, 0x80, 0x00, 0xff, 0xff, 0xff, 0xff]),
    );
    expect(trailer?.layerIndicator).toBe(8);
    expect(trailer?.iip).toBe(true);
  });
});
