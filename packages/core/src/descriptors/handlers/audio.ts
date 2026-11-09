import { hex, readU8 } from '../../util/bytes.js';
import { ascii } from '../dvb-string.js';
import {
  EXTENSION_NAMES,
  atscBsmodName,
  iso639AudioTypeName,
  supplementaryAudioName,
} from '../names.js';
import type { DescriptorFields, DescriptorHandler } from '../registry.js';

/** DVB DTS descriptor sample_rate_code table (EN 300 468 Table G.2). */
const DTS_DESCRIPTOR_SAMPLE_RATES: Array<number | undefined> = [
  undefined, 8000, 16000, 32000, 64000, 128000, 11025, 22050, 44100, 88200, 176400,
  12000, 24000, 48000, 96000, 192000,
];
/** DVB DTS descriptor bit_rate_code table (EN 300 468 Table G.3), in b/s. */
const DTS_DESCRIPTOR_BITRATES: Array<number | undefined> = [
  undefined, undefined, undefined, undefined, undefined,
  128000, 192000, 224000, 256000, 320000, 384000, 448000, 512000, 576000, 640000, 768000,
  960000, 1024000, 1152000, 1280000, 1344000, 1408000, 1411200, 1472000, 1536000, 1920000,
  2048000, 3072000, 3840000,
];
/** DVB DTS descriptor surround_mode table (EN 300 468 Table G.4). */
const DTS_DESCRIPTOR_CHANNELS: Array<number | undefined> = [
  1, undefined, 2, 2, 2, 3, 3, 4, 4, 5,
];

/** Trailing 3-byte ISO 639 language codes in an AC-3 descriptor. */
function trailingLanguageCodes(data: Uint8Array): string[] {
  const codes: string[] = [];
  let end = data.length;
  while (codes.length < 2 && end >= 3) {
    const code = ascii(data.subarray(end - 3, end));
    if (!/^[a-z]{3}$/.test(code)) break;
    codes.unshift(code);
    end -= 3;
  }
  return codes;
}

const iso639Language: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  const count = Math.max(1, Math.floor(d.length / 4));
  const languages: string[] = [];
  const audioTypes: string[] = [];
  let audioDescription = false;
  let hearingImpaired = false;
  for (let i = 0; i < count; i += 1) {
    const base = i * 4;
    if (base + 3 > d.length) break;
    const language = ascii(d.subarray(base, base + 3));
    const type = readU8(d, base + 3);
    languages.push(language);
    audioTypes.push(iso639AudioTypeName(type));
    if (type === 0x03) audioDescription = true;
    if (type === 0x02) hearingImpaired = true;
  }
  if (languages.length > 0) fields.languages = languages.join(', ');
  if (audioTypes.length > 0) fields.audioTypes = audioTypes.join(', ');
  if (audioDescription) fields.audioDescription = true;
  if (hearingImpaired) fields.hearingImpaired = true;
  return fields;
};

const ac3: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  if (d.length >= 1) fields.componentType = readU8(d, 0);
  if (d.length >= 2) fields.bsid = readU8(d, 1);
  if (d.length >= 3) fields.mainId = readU8(d, 2);
  if (d.length >= 4) fields.asvc = readU8(d, 3);
  return fields;
};

const atscAc3: DescriptorHandler = (_raw, d, context) => {
  const fields: DescriptorFields = {};
  if (d.length < 3) {
    fields.flags = readU8(d, 0);
    return fields;
  }
  const sampleRateCode = context.readBits(d, 0, 3);
  const bsid = context.readBits(d, 3, 5);
  const bitRateCode = context.readBits(d, 8, 6);
  const surroundMode = context.readBits(d, 14, 2);
  const bsmod = context.readBits(d, 16, 3);
  const numChannels = context.readBits(d, 19, 4);
  const fullService = context.readBits(d, 23, 1) !== 0;
  fields.sampleRateCode = sampleRateCode;
  fields.bsid = bsid;
  fields.bitRateCode = bitRateCode;
  fields.surroundMode = surroundMode;
  fields.audioServiceType = bsmod;
  fields.audioServiceTypeName = atscBsmodName(bsmod);
  fields.numChannels = numChannels;
  fields.fullService = fullService;
  if (bsmod === 2) fields.audioDescription = true;
  if (bsmod === 3) fields.hearingImpaired = true;
  if (d.length >= 4) {
    const langcod = readU8(d, 3);
    if (langcod !== 0xff) fields.langcod = langcod;
  }
  if (d.length >= 5) {
    fields.mainId = readU8(d, 4) >> 5;
    fields.priority = (readU8(d, 4) >> 3) & 0x03;
  }
  if (d.length >= 9) {
    const languages = trailingLanguageCodes(d);
    if (languages[0]) fields.language = languages[0];
    if (languages[1]) fields.language2 = languages[1];
  }
  return fields;
};

const eac3: DescriptorHandler = (_raw, d) => {
  return {
    flags: readU8(d, 0),
    flags2: readU8(d, 1),
  };
};

const dts: DescriptorHandler = (_raw, d, context) => {
  const fields: DescriptorFields = {};
  if (d.length >= 5) {
    const sampleRateCode = context.readBits(d, 0, 4);
    const bitRateCode = context.readBits(d, 4, 6);
    const nblks = context.readBits(d, 10, 7);
    const fsize = context.readBits(d, 17, 14);
    const surroundMode = context.readBits(d, 31, 6);
    const lfe = context.readBits(d, 37, 1);
    const extendedSurround = context.readBits(d, 38, 2);
    fields.sampleRateCode = sampleRateCode;
    const sampleRate = DTS_DESCRIPTOR_SAMPLE_RATES[sampleRateCode];
    if (sampleRate !== undefined && sampleRate > 0) fields.sampleRate = sampleRate;
    fields.bitRateCode = bitRateCode;
    const bitRate = DTS_DESCRIPTOR_BITRATES[bitRateCode & 0x1f];
    if (bitRate !== undefined && bitRate > 0) fields.bitRate = bitRate;
    fields.nblks = nblks;
    fields.frameSize = fsize;
    fields.surroundMode = surroundMode;
    const channels = DTS_DESCRIPTOR_CHANNELS[surroundMode];
    if (channels !== undefined) fields.channels = channels + (lfe ? 1 : 0);
    fields.lfe = lfe !== 0;
    fields.extendedSurround = extendedSurround;
  }
  return fields;
};

const aac: DescriptorHandler = (_raw, d) => {
  return {
    profile: readU8(d, 0),
    level: readU8(d, 1),
  };
};

const extension: DescriptorHandler = (_raw, d, context) => {
  const fields: DescriptorFields = {};
  const extensionTag = readU8(d, 0);
  fields.extensionTag = extensionTag;
  const extensionName = EXTENSION_NAMES[extensionTag];
  if (extensionName) fields.extensionName = extensionName;
  if (extensionTag === 0x06 && d.length >= 2) {
    // ETSI EN 300 468 supplementary_audio_descriptor.
    const flags = readU8(d, 1);
    const mixType = (flags & 0x80) !== 0;
    const editorialClassification = (flags >> 2) & 0x1f;
    const languageCodePresent = (flags & 0x01) !== 0;
    fields.mixType = mixType ? 'independent' : 'dependent';
    fields.editorialClassification = editorialClassification;
    fields.editorialClassificationName = supplementaryAudioName(editorialClassification);
    if (editorialClassification === 0x01) fields.audioDescription = true;
    if (editorialClassification === 0x02) fields.hearingImpaired = true;
    if (editorialClassification === 0x03) fields.spokenSubtitles = true;
    let pos = 2;
    if (languageCodePresent && pos + 3 <= d.length) {
      fields.language = ascii(d.subarray(pos, pos + 3));
      pos += 3;
    }
    if (pos < d.length) fields.privateData = hex(d, pos);
  } else if (extensionTag === 0x19 && d.length >= 2) {
    // ETSI EN 300 468 audio_preselection_descriptor.
    let pos = 1;
    const count = readU8(d, pos) >> 3;
    pos += 1;
    let parsed = 0;
    let audioDescription = false;
    let spokenSubtitles = false;
    let dialogueEnhancement = false;
    let interactivityEnabled = false;
    let rendering: number | undefined;
    let language: string | undefined;
    for (let i = 0; i < count && pos + 2 <= d.length; i += 1) {
      const first = readU8(d, pos);
      const flags = readU8(d, pos + 1);
      pos += 2;
      if (rendering === undefined) rendering = first & 0x07;
      if ((flags & 0x80) !== 0) audioDescription = true;
      if ((flags & 0x40) !== 0) spokenSubtitles = true;
      if ((flags & 0x20) !== 0) dialogueEnhancement = true;
      if ((flags & 0x10) !== 0) interactivityEnabled = true;
      const languageCodePresent = (flags & 0x08) !== 0;
      const textLabelPresent = (flags & 0x04) !== 0;
      const multiStreamInfoPresent = (flags & 0x02) !== 0;
      const futureExtension = (flags & 0x01) !== 0;
      if (languageCodePresent && pos + 3 <= d.length) {
        if (language === undefined) language = ascii(d.subarray(pos, pos + 3));
        pos += 3;
      }
      if (textLabelPresent) pos += 1;
      if (multiStreamInfoPresent && pos < d.length) {
        const auxCount = readU8(d, pos) >> 5;
        pos += 1 + auxCount;
      }
      if (futureExtension && pos < d.length) {
        const extensionLength = readU8(d, pos) & 0x1f;
        pos += 1 + extensionLength;
      }
      parsed += 1;
    }
    fields.preselectionCount = parsed;
    if (audioDescription) fields.audioDescription = true;
    if (spokenSubtitles) fields.spokenSubtitles = true;
    if (dialogueEnhancement) fields.dialogueEnhancement = true;
    if (interactivityEnabled) fields.interactivityEnabled = true;
    if (rendering !== undefined) {
      fields.audioRenderingIndication = rendering;
      fields.audioRenderingIndicationName =
        ['no preference', 'stereo', 'two-dimensional', 'three-dimensional', 'headphones'][
          rendering
        ] ?? 'reserved';
    }
    if (language !== undefined) fields.language = language;
  } else if (extensionTag === 0x15 && d.length >= 2) {
    const flags = readU8(d, 1);
    const configFlag = (flags & 0x80) !== 0;
    const tocFlag = (flags & 0x40) !== 0;
    fields.ac4ConfigFlag = configFlag;
    fields.ac4TocFlag = tocFlag;
    let pos = 2;
    if (configFlag && pos < d.length) {
      const config = readU8(d, pos);
      pos += 1;
      fields.dialogEnhancementEnabled = (config & 0x80) !== 0;
      const channelMode = (config >> 5) & 0x03;
      fields.channelMode = channelMode;
      fields.channelModeName =
        ['Mono', 'Stereo', 'Multichannel', 'Reserved'][channelMode] ?? 'Reserved';
    }
    if (tocFlag && pos < d.length) {
      const tocLength = readU8(d, pos);
      pos += 1;
      fields.tocLength = tocLength;
      if (tocLength > 0 && pos + tocLength <= d.length) {
        fields.toc = hex(d, pos, pos + tocLength);
      }
      pos += tocLength;
    }
    if (pos < d.length) fields.additionalInfo = hex(d, pos);
  } else if (d.length > 1) {
    fields.extensionData = hex(d, 1);
  }
  return fields;
};

export const audioHandlers: Record<number, DescriptorHandler> = {
  0x0a: iso639Language,
  0x6a: ac3,
  0x7a: eac3,
  0x7b: dts,
  0x7c: aac,
  0x7f: extension,
  0x81: atscAc3,
};
