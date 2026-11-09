export const NAMES: Record<number, string> = {
  0x02: 'Video stream',
  0x03: 'Audio stream',
  0x05: 'Registration',
  0x09: 'CA',
  0x0a: 'ISO 639 language',
  0x0b: 'System clock',
  0x0c: 'Multiplex buffer utilization',
  0x0d: 'Copyright',
  0x0e: 'Maximum bitrate',
  0x0f: 'Private data specifier',
  0x10: 'Smoothing buffer',
  0x11: 'STD',
  0x12: 'IBP',
  0x13: 'Carousel identifier',
  0x14: 'Association tag',
  0x1b: 'MPEG-4 video',
  0x1c: 'MPEG-4 audio',
  0x1d: 'IOD',
  0x1e: 'SL',
  0x1f: 'FMC',
  0x20: 'MHD',
  0x28: 'AVC video',
  0x29: 'AVC video (SVC)',
  0x2a: 'AVC video (MVC)',
  0x2b: 'HEVC video',
  0x2c: 'VVC video',
  0x2d: 'AVS3 video',
  0x38: 'HEVC timing and HRD',
  0x40: 'Network name',
  0x41: 'Service list',
  0x42: 'Stuffing',
  0x43: 'Satellite delivery',
  0x44: 'Cable delivery',
  0x45: 'VBI data',
  0x46: 'VBI teletext',
  0x47: 'Bouquet name',
  0x48: 'Service',
  0x49: 'Country availability',
  0x4a: 'Linkage',
  0x4b: 'NVOD reference',
  0x4c: 'Time shifted service',
  0x4d: 'Short event',
  0x4e: 'Extended event',
  0x4f: 'Time shifted event',
  0x50: 'Component',
  0x51: 'Mosaic',
  0x52: 'Stream identifier',
  0x53: 'CA identifier',
  0x54: 'Content',
  0x55: 'Parental rating',
  0x56: 'Teletext',
  0x57: 'Telephone',
  0x58: 'Local time offset',
  0x59: 'Subtitling',
  0x5a: 'Terrestrial delivery',
  0x5b: 'Multilingual network name',
  0x5c: 'Multilingual bouquet name',
  0x5d: 'Multilingual service name',
  0x5e: 'Multilingual component',
  0x5f: 'Private data specifier',
  0x60: 'Service move',
  0x61: 'Short smoothing buffer',
  0x62: 'Frequency list',
  0x63: 'Partial transport stream',
  0x64: 'Data broadcast',
  0x65: 'CA system',
  0x66: 'Data broadcast id',
  0x67: 'Transport stream',
  0x68: 'DSNG',
  0x69: 'PDC',
  0x6a: 'AC-3',
  0x6b: 'Ancillary data',
  0x6c: 'Cell list',
  0x6d: 'Cell frequency link',
  0x6e: 'Announcer',
  0x6f: 'Application signalling',
  0x70: 'Adaptation',
  0x71: 'Service identifier',
  0x72: 'Service availability',
  0x73: 'Default authority',
  0x74: 'Related content',
  0x75: 'TVA id',
  0x76: 'Content identifier',
  0x77: 'Time slice FEC identifier',
  0x78: 'ECM repetition rate',
  0x79: 'S2',
  0x7a: 'Enhanced AC-3',
  0x7b: 'DTS',
  0x7c: 'AAC',
  0x7d: 'Extension',
  0x7e: 'Extension (reserved)',
  0x7f: 'Extension',
  0x80: 'Stuffing',
  0x81: 'ATSC AC-3',
  0x82: 'ATSC program identifier',
  0x83: 'ATSC service location',
  0x84: 'ATSC time shifted service',
  0x85: 'ATSC component name',
  0x86: 'ATSC caption service',
  0x87: 'ATSC content advisory',
  0x88: 'ATSC private',
  0xa0: 'ATSC extended channel name',
  0xa1: 'ATSC service location',
  0xa2: 'ATSC time shifted service',
  0xa3: 'ATSC component name',
  0xa4: 'ATSC private',
  0xa5: 'ATSC private',
  0xc1: 'ISDB digital copy control',
  0xc2: 'ISDB maximum bitrate',
  0xc3: 'ISDB TS information',
  0xc4: 'ISDB extended event',
  0xc5: 'ISDB local time offset',
  0xc6: 'ISDB partial reception',
  0xc7: 'ISDB hierarchy',
  0xc8: 'ISDB video decode control',
  0xc9: 'ISDB data content',
  0xca: 'ISDB video encode control',
  0xcb: 'ISDB still picture',
  0xcc: 'ISDB external application',
  0xd0: 'ISDB private',
  0xf6: 'ISDB access control',
  0xfc: 'ISDB emergency information',
  0xfd: 'ISDB data component',
};

export function descriptorName(tag: number): string {
  return NAMES[tag] ?? `Private (0x${tag.toString(16).padStart(2, '0').toUpperCase()})`;
}

const CONTENT_LEVEL1_NAMES = [
  'undefined',
  'movie/drama',
  'news/current affairs',
  'show/game show',
  'sports',
  "children's/youth programmes",
  'music/ballet/dance',
  'arts/culture',
  'social/political issues/economics',
  'education/science/factual topics',
  'leisure/hobbies',
  'reserved',
  'reserved',
  'reserved',
  'reserved',
  'user defined',
];

const CONTENT_LEVEL2_NAMES: Record<number, string[]> = {
  0x1: [
    'movie/drama (general)',
    'detective/thriller',
    'adventure/western',
    'science fiction/fantasy/horror',
    'comedy',
    'soap/melodrama/folklore',
    'romance',
    'historical/period',
    'biography',
    'musical/opera',
    'adult',
  ],
  0x2: [
    'news/current affairs (general)',
    'news/weather report',
    'news magazine',
    'documentary',
    'discussion/interview/debate',
  ],
  0x3: ['show/game show (general)', 'game show/quiz/contest', 'variety show', 'talk show'],
  0x4: [
    'sports (general)',
    'special events',
    'sports magazines',
    'football/soccer',
    'tennis/squash',
    'team sports',
    'motor sport',
    'water sport',
    'winter sports',
    'equestrian',
    'martial arts',
    'cycling',
  ],
  0x5: ["children's/youth (general)", 'pre-school', 'entertainment', 'cartoon'],
  0x6: [
    'music/ballet/dance (general)',
    'rock/pop',
    'classical music',
    'folk/traditional music',
    'jazz',
    'musical/opera',
    'ballet',
  ],
  0x7: [
    'arts/culture (general)',
    'performing arts',
    'fine arts',
    'religion',
    'popular culture/traditional arts',
    'literature',
    'film/cinema',
  ],
  0x8: [
    'social/political issues/economics (general)',
    'magazines/reports',
    'economics/social advisory',
    'remarkable people',
  ],
  0x9: [
    'education/science/factual topics (general)',
    'nature/animals/environment',
    'technology/natural sciences',
    'medicine/physiology/psychology',
    'foreign countries/expeditions',
    'social/spiritual sciences',
    'further education',
    'languages',
  ],
  0xa: [
    'leisure/hobbies (general)',
    'gardening',
    'travel',
    'handicraft',
    'motoring',
    'fitness/health',
    'cooking',
    'shopping',
  ],
};

export function contentGenreName(level1: number, level2: number): string {
  if (level1 === 0) return 'unclassified';
  const first = CONTENT_LEVEL1_NAMES[level1] ?? `content 0x${level1.toString(16)}`;
  const second = CONTENT_LEVEL2_NAMES[level1]?.[level2];
  return second ?? first;
}

const ISO639_AUDIO_TYPES: Record<number, string> = {
  0x00: 'undefined',
  0x01: 'clean effects',
  0x02: 'hearing impaired',
  0x03: 'visual impaired commentary',
  0x80: 'primary',
  0x81: 'native',
  0x82: 'emergency',
  0x83: 'primary commentary',
  0x84: 'alternate commentary',
};

export function iso639AudioTypeName(value: number): string {
  const known = ISO639_AUDIO_TYPES[value];
  if (known) return known;
  if (value >= 0x04 && value <= 0x7f) return `user private (0x${value.toString(16).padStart(2, '0')})`;
  return `reserved (0x${value.toString(16).padStart(2, '0')})`;
}

const ATSC_BSMOD_NAMES = [
  'complete main',
  'music and effects',
  'visually impaired',
  'hearing impaired',
  'dialogue',
  'commentary',
  'emergency',
  'voice over',
];

export function atscBsmodName(value: number): string {
  return ATSC_BSMOD_NAMES[value] ?? `reserved (${value})`;
}

const SUPPLEMENTARY_AUDIO_NAMES: Record<number, string> = {
  0x00: 'main audio',
  0x01: 'audio description',
  0x02: 'clean audio for the hearing impaired',
  0x03: 'spoken subtitles',
  0x04: 'dependent parametric data',
  0x17: 'general audience supplementary audio',
};

export function supplementaryAudioName(value: number): string {
  const known = SUPPLEMENTARY_AUDIO_NAMES[value];
  if (known) return known;
  if (value >= 0x18 && value <= 0x1f) return 'user defined';
  return 'reserved';
}

const SUBTITLE_TYPE_NAMES: Record<number, string> = {
  0x10: 'DVB subtitles (normal)',
  0x11: 'DVB subtitles (hearing impaired)',
  0x12: 'DVB subtitles (normal, 4:3)',
  0x13: 'DVB subtitles (hearing impaired, 4:3)',
  0x14: 'DVB subtitles (normal, 16:9)',
  0x15: 'DVB subtitles (hearing impaired, 16:9)',
  0x20: 'Teletext subtitles (normal)',
  0x21: 'Teletext subtitles (hearing impaired)',
  0x22: 'Teletext subtitles (normal, 4:3)',
  0x23: 'Teletext subtitles (hearing impaired, 4:3)',
  0x24: 'Teletext subtitles (normal, 16:9)',
  0x25: 'Teletext subtitles (hearing impaired, 16:9)',
  0x30: 'Open subtitles',
};

export function subtitleTypeName(value: number): string {
  return SUBTITLE_TYPE_NAMES[value] ?? `reserved (0x${value.toString(16).padStart(2, '0')})`;
}

const TELETEXT_TYPE_NAMES: Record<number, string> = {
  0x01: 'initial page',
  0x02: 'subtitle page',
  0x03: 'additional information',
  0x04: 'programme schedule',
  0x05: 'hearing impaired subtitle page',
};

export function teletextTypeName(value: number): string {
  return TELETEXT_TYPE_NAMES[value] ?? `reserved (${value})`;
}

export function dataComponentName(value: number): string {
  switch (value) {
    case 0x0008:
      return 'ARIB caption';
    case 0x0012:
      return 'ARIB superimpose';
    case 0x0009:
    case 0x000c:
    case 0x000d:
      return 'ARIB data';
    default:
      return `data component (0x${value.toString(16).padStart(4, '0').toUpperCase()})`;
  }
}

export const LINKAGE_TYPE_NAMES: Record<number, string> = {
  0x01: 'information service',
  0x02: 'EPG service',
  0x03: 'CA replacement service',
  0x04: 'TS containing complete network/bouquet SI',
  0x05: 'service replacement service',
  0x06: 'data broadcast service',
  0x07: 'RCS map',
  0x08: 'mobile hand-over',
  0x09: 'system software update service',
  0x0a: 'TS containing SSU BAT or NIT',
  0x0b: 'IP/MAC notification service',
  0x0c: 'event linkage',
  0x0d: 'extended event linkage',
};

export const EXTENSION_NAMES: Record<number, string> = {
  0x06: 'Supplementary audio',
  0x15: 'AC-4',
  0x19: 'Audio preselection',
};
