import { readU8, readU16 } from '../../util/bytes.js';
import { ascii } from '../dvb-string.js';
import { subtitleTypeName, teletextTypeName } from '../names.js';
import type { DescriptorFields, DescriptorHandler } from '../registry.js';

const teletext: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  const pages: string[] = [];
  const types: string[] = [];
  const languages = new Set<string>();
  for (let i = 0; i + 5 <= d.length; i += 5) {
    const language = ascii(d.subarray(i, i + 3));
    const type = (readU8(d, i + 3) >> 3) & 0x1f;
    const magazine = readU8(d, i + 3) & 0x07;
    const page = readU8(d, i + 4);
    languages.add(language);
    types.push(`${language} ${teletextTypeName(type)}`);
    if (type === 0x05) fields.hearingImpaired = true;
    pages.push(`${language} type=${type} ${magazine}:${page.toString(16).padStart(2, '0')}`);
  }
  fields.pages = pages.join(', ');
  if (types.length > 0) fields.teletextTypes = types.join(', ');
  if (languages.size > 0) fields.languages = [...languages].join(', ');
  return fields;
};

const subtitling: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  const pages: string[] = [];
  const types: string[] = [];
  const languages = new Set<string>();
  for (let i = 0; i + 8 <= d.length; i += 8) {
    const language = ascii(d.subarray(i, i + 3));
    const type = readU8(d, i + 3);
    languages.add(language);
    types.push(`${language} ${subtitleTypeName(type)}`);
    if ([0x11, 0x13, 0x15, 0x21, 0x23, 0x25].includes(type)) {
      fields.hearingImpaired = true;
    }
    const composition = readU16(d, i + 4);
    const ancillary = readU16(d, i + 6);
    pages.push(`${language} type=${type} page=${composition}/${ancillary}`);
  }
  fields.pages = pages.join(', ');
  if (types.length > 0) fields.subtitleTypes = types.join(', ');
  if (languages.size > 0) fields.languages = [...languages].join(', ');
  return fields;
};

/**
 * ATSC A/65 caption_service_descriptor.
 */
const captionService: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  const count = readU8(d, 0) & 0x1f;
  const services: string[] = [];
  const languages = new Set<string>();
  let easyReader = false;
  let wideAspectRatio = false;
  for (let i = 1; i + 5 < d.length && services.length < count; i += 6) {
    const language = ascii(d.subarray(i, i + 3));
    const flags = readU8(d, i + 3);
    const tail = readU8(d, i + 4);
    const digitalCc = (flags & 0x80) !== 0;
    const easy = (tail & 0x80) !== 0;
    const wide = (tail & 0x40) !== 0;
    if (easy) easyReader = true;
    if (wide) wideAspectRatio = true;
    languages.add(language);
    if (digitalCc) {
      const serviceNumber = flags & 0x3f;
      services.push(
        `${language} 708 service=${serviceNumber}${easy ? ' easy-reader' : ''}${
          wide ? ' 16:9' : ' 4:3'
        }`,
      );
    } else {
      const line21 = (flags & 0x01) !== 0;
      services.push(
        `${language} 608 line21=${line21 ? 1 : 0}${easy ? ' easy-reader' : ''}${
          wide ? ' 16:9' : ' 4:3'
        }`,
      );
    }
  }
  fields.services = services.join(', ');
  if (languages.size > 0) fields.languages = [...languages].join(', ');
  if (easyReader) fields.easyReader = true;
  if (wideAspectRatio) fields.wideAspectRatio = true;
  return fields;
};

export const subtitleHandlers: Record<number, DescriptorHandler> = {
  0x56: teletext,
  0x59: subtitling,
  0x86: captionService,
};
