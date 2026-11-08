import { describe, expect, it } from 'vitest';
import { decodeDvbString, describeDescriptor, iso6937G2 } from '@tsinspect/core';

function rawDescriptor(tag: number, body: number[]): {
  tag: number;
  length: number;
  data: Uint8Array;
} {
  return { tag, length: body.length, data: Uint8Array.from(body) };
}

describe('descriptors', () => {
  it('parses carousel identifier and association tag descriptors', () => {
    const carousel = describeDescriptor(
      rawDescriptor(0x13, [0x00, 0x00, 0x12, 0x34, 0x00, 0xab, 0xcd]),
    );
    expect(carousel.name).toBe('Carousel identifier');
    expect(carousel.fields?.carouselId).toBe(0x1234);
    expect(carousel.fields?.carouselIdHex).toBe('0x00001234');
    expect(carousel.fields?.formatId).toBe(0);
    expect(carousel.fields?.formatSpecifier).toBe('AB CD');

    const association = describeDescriptor(rawDescriptor(0x14, [0x00, 0x2a, 0x55]));
    expect(association.name).toBe('Association tag');
    expect(association.fields?.associationTag).toBe(0x2a);
    expect(association.fields?.associationTagHex).toBe('0x002A');
    expect(association.fields?.additionalData).toBe('55');
  });

  it('parses the ISDB extended event descriptor with ARIB text', () => {
    const textBytes = new TextEncoder().encode('ISDB detail');
    const body = [
      0x00, // descriptor number 0, last 0
      0x6a, 0x70, 0x6e, // "jpn"
      0x00, // no items
      textBytes.length + 3,
      0x1b, 0x28, 0x4a, // designate G0 as ARIB alphanumeric
      ...textBytes,
    ];
    const extended = describeDescriptor(rawDescriptor(0xc4, body), 'arib');
    expect(extended.name).toBe('ISDB extended event');
    expect(extended.fields?.descriptorNumber).toBe(0);
    expect(extended.fields?.language).toBe('jpn');
    expect(extended.fields?.text).toBe('ISDB detail');
  });

  it('parses content and parental rating descriptors', () => {
    const content = describeDescriptor(rawDescriptor(0x54, [0x21, 0x30]));
    expect(content.fields?.content).toBe('2/1/3/0');
    expect(content.fields?.contentName).toBe('news/weather report (user 3/0)');

    const rating = describeDescriptor(rawDescriptor(0x55, [0x46, 0x52, 0x41, 0x04]));
    expect(rating.fields?.countryCode).toBe('FRA');
    expect(rating.fields?.rating).toBe(4);
    expect(rating.fields?.minimumAge).toBe(7);
    expect(rating.fields?.ratings).toBe('FRA: 4');
    expect(rating.fields?.ratingSummary).toBe('FRA: rating 4');
  });

  it('decodes Brazilian parental ratings', () => {
    const rating = describeDescriptor(rawDescriptor(0x55, [0x42, 0x52, 0x41, 0x01]));
    expect(rating.fields?.countryCode).toBe('BRA');
    expect(rating.fields?.rating).toBe(1);
    expect(rating.fields?.ratingSummary).toBe('BRA: rating 1');
  });

  it('decodes ATSC content advisory dimensions and values', () => {
    const advisory = describeDescriptor(
      rawDescriptor(0x87, [0x05, 0x02, 0x00, 0x30, 0x01, 0x20]),
    );
    expect(advisory.fields?.ratingRegion).toBe(5);
    expect(advisory.fields?.dimensions).toBe(2);
    expect(advisory.fields?.ratings).toBe('0/3, 1/2');
  });

  it('decodes ISO 639 audio types and accessibility flags', () => {
    const descriptor = describeDescriptor(
      rawDescriptor(0x0a, [
        0x65, 0x6e, 0x67, 0x02, // eng, hearing impaired
        0x66, 0x72, 0x61, 0x03, // fra, visual impaired commentary
      ]),
    );
    expect(descriptor.fields?.languages).toBe('eng, fra');
    expect(descriptor.fields?.audioTypes).toBe(
      'hearing impaired, visual impaired commentary',
    );
    expect(descriptor.fields?.audioDescription).toBe(true);
    expect(descriptor.fields?.hearingImpaired).toBe(true);
  });

  it('decodes the supplementary audio descriptor', () => {
    const descriptor = describeDescriptor(
      rawDescriptor(0x7f, [0x06, 0x85, 0x66, 0x72, 0x61]),
    );
    expect(descriptor.name).toBe('Supplementary audio');
    expect(descriptor.fields?.mixType).toBe('independent');
    expect(descriptor.fields?.editorialClassification).toBe(1);
    expect(descriptor.fields?.editorialClassificationName).toBe('audio description');
    expect(descriptor.fields?.audioDescription).toBe(true);
    expect(descriptor.fields?.language).toBe('fra');

    const hearing = describeDescriptor(
      rawDescriptor(0x7f, [0x06, 0x8b, 0x65, 0x6e, 0x67]),
    );
    expect(hearing.fields?.editorialClassificationName).toBe(
      'clean audio for the hearing impaired',
    );
    expect(hearing.fields?.hearingImpaired).toBe(true);

    const spoken = describeDescriptor(
      rawDescriptor(0x7f, [0x06, 0x8f, 0x65, 0x6e, 0x67]),
    );
    expect(spoken.fields?.editorialClassificationName).toBe('spoken subtitles');
    expect(spoken.fields?.spokenSubtitles).toBe(true);
  });

  it('flags hearing-impaired subtitles in subtitling and teletext descriptors', () => {
    const subtitling = describeDescriptor(
      rawDescriptor(0x59, [0x66, 0x72, 0x61, 0x11, 0x00, 0x01, 0x00, 0x01]),
    );
    expect(subtitling.fields?.hearingImpaired).toBe(true);
    expect(subtitling.fields?.pages).toBe('fra type=17 page=1/1');
    expect(subtitling.fields?.subtitleTypes).toBe(
      'fra DVB subtitles (hearing impaired)',
    );
    expect(subtitling.fields?.languages).toBe('fra');

    const teletext = describeDescriptor(
      rawDescriptor(0x56, [0x65, 0x6e, 0x67, 0x2b, 0x88]),
    );
    expect(teletext.fields?.hearingImpaired).toBe(true);
    expect(teletext.fields?.pages).toBe('eng type=5 3:88');
    expect(teletext.fields?.teletextTypes).toBe(
      'eng hearing impaired subtitle page',
    );
  });

  it('decodes ATSC caption service types and flags', () => {
    const descriptor = describeDescriptor(
      rawDescriptor(0x86, [
        0xe3,
        0x65, 0x6e, 0x67, 0x7e, 0x3f, 0xff,
        0x65, 0x6e, 0x67, 0x7f, 0xff, 0xff,
        0x65, 0x6e, 0x67, 0xc1, 0xff, 0xff,
      ]),
    );
    expect(descriptor.fields?.languages).toBe('eng');
    expect(descriptor.fields?.services).toBe(
      'eng 608 line21=0 4:3, eng 608 line21=1 easy-reader 16:9, eng 708 service=1 easy-reader 16:9',
    );
    expect(descriptor.fields?.easyReader).toBe(true);
    expect(descriptor.fields?.wideAspectRatio).toBe(true);
  });

  it('decodes the audio preselection descriptor', () => {
    const descriptor = describeDescriptor(
      rawDescriptor(0x7f, [0x19, 0x08, 0x01, 0xc8, 0x64, 0x65, 0x75]),
    );
    expect(descriptor.name).toBe('Audio preselection');
    expect(descriptor.fields?.preselectionCount).toBe(1);
    expect(descriptor.fields?.audioRenderingIndicationName).toBe('stereo');
    expect(descriptor.fields?.audioDescription).toBe(true);
    expect(descriptor.fields?.spokenSubtitles).toBe(true);
    expect(descriptor.fields?.language).toBe('deu');
  });

  it('names ISDB data components including captions', () => {
    const caption = describeDescriptor(rawDescriptor(0xfd, [0x00, 0x08, 0x3d]));
    expect(caption.fields?.dataComponentId).toBe(8);
    expect(caption.fields?.dataComponentName).toBe('ARIB caption');
    const superimpose = describeDescriptor(rawDescriptor(0xfd, [0x00, 0x12]));
    expect(superimpose.fields?.dataComponentName).toBe('ARIB superimpose');
  });

  it('decodes ISO 6937 diacritics, symbols and the G2 set', () => {
    // 0xC8 is a non-spacing diaeresis and combines with the following byte.
    expect(decodeDvbString(Uint8Array.from([0xc8, 0x65]))).toBe('ë');
    expect(decodeDvbString(Uint8Array.from([0x41, 0xa4, 0xd0, 0x42]))).toBe('A$\u2014B');
    // A diacritic followed by a space becomes a spacing accent.
    expect(decodeDvbString(Uint8Array.from([0xc2, 0x20]))).toBe('\u00b4');

    expect(iso6937G2(0x60)).toBe('\u03a9');
    expect(iso6937G2(0x30)).toBe('0');
    expect(iso6937G2(0x7f)).toBeUndefined();
  });

  it('drops embedded NUL padding in DVB strings', () => {
    expect(decodeDvbString(Uint8Array.from([0x41, 0x42, 0x00, 0x00]))).toBe('AB');
    expect(decodeDvbString(Uint8Array.from([0x41, 0x00, 0x42]))).toBe('AB');
  });

  it('honours the 0x1F encoding header', () => {
    const text = new TextEncoder().encode('日本語');
    const withHeader = Uint8Array.from([0x1f, 0x02, text.length, ...text]);
    expect(decodeDvbString(withHeader)).toBe('日本語');
  });

  it('decodes ATSC AC-3 audio service type and language', () => {
    const descriptor = describeDescriptor(
      rawDescriptor(0x81, [0x08, 0x38, 0x05, 0xff, 0x0f, 0x01, 0xbf, 0x65, 0x6e, 0x67]),
    );
    expect(descriptor.name).toBe('ATSC AC-3');
    expect(descriptor.fields?.sampleRateCode).toBe(0);
    expect(descriptor.fields?.bsid).toBe(8);
    expect(descriptor.fields?.bitRateCode).toBe(14);
    expect(descriptor.fields?.audioServiceType).toBe(0);
    expect(descriptor.fields?.audioServiceTypeName).toBe('complete main');
    expect(descriptor.fields?.numChannels).toBe(2);
    expect(descriptor.fields?.fullService).toBe(true);
    expect(descriptor.fields?.language).toBe('eng');
    expect(descriptor.fields?.audioDescription).toBeUndefined();
    expect(descriptor.fields?.hearingImpaired).toBeUndefined();

    const hearingImpaired = describeDescriptor(
      rawDescriptor(0x81, [0x08, 0x38, 0x6b, 0xff, 0x0f, 0x01, 0xbf, 0x65, 0x6e, 0x67]),
    );
    expect(hearingImpaired.fields?.audioServiceType).toBe(3);
    expect(hearingImpaired.fields?.audioServiceTypeName).toBe('hearing impaired');
    expect(hearingImpaired.fields?.hearingImpaired).toBe(true);

    const visuallyImpaired = describeDescriptor(
      rawDescriptor(0x81, [0x08, 0x38, 0x4b, 0xff, 0x0f, 0x01, 0xbf, 0x65, 0x6e, 0x67]),
    );
    expect(visuallyImpaired.fields?.audioServiceType).toBe(2);
    expect(visuallyImpaired.fields?.audioDescription).toBe(true);
  });
});
