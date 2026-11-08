import { describe, expect, it } from 'vitest';
import { decodeAribString } from '@tsinspect/core';

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((part) => Number.parseInt(part, 16)),
  );
}

describe('ARIB STD-B24 text', () => {
  it('decodes two-byte Kanji from the default G0 set', () => {
    expect(decodeAribString(bytes('41 6D 39 67'))).toBe('総合');
  });

  it('decodes the real ISDB service name from the sample descriptor', () => {
    // LS1 "NHK", LS0 総合, LS1 "1", GR Hiragana 0x7E (・), LS0 秋田.
    const name = bytes('0E 4E 48 4B 0F 41 6D 39 67 0E 31 FE 0F 3D 29 45 44');
    expect(decodeAribString(name)).toBe('NHK総合1・秋田');
  });

  it('decodes Hiragana from the default G2 right-hand set', () => {
    // 0xA2..0xA6 -> あいう (GR, G2 Hiragana).
    expect(decodeAribString(bytes('A2 A4 A6'))).toBe('あいう');
  });

  it('decodes the extended Hiragana punctuation positions 0x77-0x7E', () => {
    // GR bytes 0xF7..0xFE select G2 Hiragana positions 0x77..0x7E.
    expect(decodeAribString(bytes('F7 F8 F9 FA FB FC FD FE'))).toBe('ゝゞー。「」、・');
  });

  it('decodes Katakana with SS3 and the extended Katakana punctuation', () => {
    // SS3 ニ, SS3 ュ, GR ー, SS3 ス.
    expect(decodeAribString(bytes('1D 4B 1D 65 F9 1D 39'))).toBe('ニュース');
    // ESC 7C (LS3R) makes G3 Katakana the right-hand set.
    expect(decodeAribString(bytes('1B 7C F7 F8 F9 FA FB FC FD FE'))).toBe('ヽヾー。「」、・');
  });

  it('decodes single-byte Katakana and resets on line breaks', () => {
    expect(decodeAribString(bytes('1D 21 1D 22 1D 23'))).toBe('ァアィ');
    expect(decodeAribString(bytes('41 6D 0D 0A 41 6D'))).toBe('総\n総');
  });

  it('decodes additional symbols used as EPG attribute icons', () => {
    // ESC $ ; designates additional symbols into G0; 7A5A/7A56 are the
    // squared 二 (bilingual) and 字 (subtitles) icons.
    expect(decodeAribString(bytes('1B 24 3B 7A 5A 7A 56'))).toBe('\u{1f214}\u{1f211}');
  });

  it('decodes ISDB-Tb Latin text with the SBTVD profile', () => {
    // "TV INTEGRA" + C7 C3 + "O HD" in ABNT NBR 15606-1 Latin extension.
    const name = bytes('54 56 20 49 4E 54 45 47 52 41 C7 C3 4F 20 48 44');
    expect(decodeAribString(name, { profile: 'brazil' })).toBe('TV INTEGRAÇÃO HD');
  });
});
