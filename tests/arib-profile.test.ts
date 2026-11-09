import { describe, expect, it } from 'vitest';
import { resolveAribProfile } from '@tsinspect/core';

describe('resolveAribProfile', () => {
  it('uses Brazil for 188-byte ISDB streams from non-Japan countries', () => {
    expect(resolveAribProfile({ packet: { size: 188 }, transport: { country: 'PHL' } })).toBe(
      'brazil',
    );
  });

  it('keeps Japan for streams signalled as JPN', () => {
    expect(resolveAribProfile({ packet: { size: 188 }, transport: { country: 'JPN' } })).toBe(
      'japan',
    );
  });

  it('falls back to packet size when no country is signalled', () => {
    expect(resolveAribProfile({ packet: { size: 188 }, transport: {} })).toBe('japan');
    expect(resolveAribProfile({ packet: { size: 204 }, transport: {} })).toBe('brazil');
  });

  it('honours an explicit profile over stream evidence', () => {
    expect(
      resolveAribProfile(
        { packet: { size: 204 }, transport: { country: 'PHL' } },
        'japan',
      ),
    ).toBe('japan');
    expect(
      resolveAribProfile(
        { packet: { size: 188 }, transport: { country: 'JPN' } },
        'brazil',
      ),
    ).toBe('brazil');
  });
});
