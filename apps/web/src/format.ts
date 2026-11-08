import type { ProbeResult, ProbeService } from '@tsinspect/core';
import type { UiKey, Vars } from './i18n';

const CAPABILITY_LABELS: Record<string, string> = {
  teletext: 'Teletext',
  dvbSubtitles: 'DVB subtitles',
  atscCaptions: 'ATSC captions',
  aribCaptions: 'ARIB captions',
  vbi: 'VBI',
  scte35: 'SCTE-35',
  scrambled: 'Scrambled',
};

export function capabilityNames(result: ProbeResult): string[] {
  const caps = Object.entries(result.capabilities ?? {})
    .filter(([key, value]) => key !== 'caSystems' && value === true)
    .map(([key]) => CAPABILITY_LABELS[key] ?? key);
  if (result.capabilities?.caSystems?.length) {
    caps.push(`CA ${result.capabilities.caSystems.map((id) => hex16(id)).join('/')}`);
  }
  return caps;
}

const ISO639_NAMES: Record<string, string> = {
  eng: 'English',
  fra: 'French',
  fre: 'French',
  deu: 'German',
  ger: 'German',
  spa: 'Spanish',
  ita: 'Italian',
  nld: 'Dutch',
  dut: 'Dutch',
  jpn: 'Japanese',
  por: 'Portuguese',
  swe: 'Swedish',
  nor: 'Norwegian',
  dan: 'Danish',
  fin: 'Finnish',
  pol: 'Polish',
  ces: 'Czech',
  cze: 'Czech',
  slk: 'Slovak',
  slo: 'Slovak',
  hun: 'Hungarian',
  ron: 'Romanian',
  rum: 'Romanian',
  rus: 'Russian',
  ukr: 'Ukrainian',
  ara: 'Arabic',
  heb: 'Hebrew',
  tur: 'Turkish',
  zho: 'Chinese',
  chi: 'Chinese',
  kor: 'Korean',
  tha: 'Thai',
  vie: 'Vietnamese',
  ind: 'Indonesian',
  msa: 'Malay',
  may: 'Malay',
  ell: 'Greek',
  gre: 'Greek',
  bul: 'Bulgarian',
  hrv: 'Croatian',
  srp: 'Serbian',
  slv: 'Slovenian',
  est: 'Estonian',
  lav: 'Latvian',
  lit: 'Lithuanian',
  cat: 'Catalan',
  eus: 'Basque',
  baq: 'Basque',
  glg: 'Galician',
  isl: 'Icelandic',
  ice: 'Icelandic',
  gle: 'Irish',
  cym: 'Welsh',
  wel: 'Welsh',
  afr: 'Afrikaans',
  swa: 'Swahili',
  hin: 'Hindi',
  ben: 'Bengali',
  tam: 'Tamil',
  tel: 'Telugu',
  mar: 'Marathi',
  kan: 'Kannada',
  mal: 'Malayalam',
  urd: 'Urdu',
  fas: 'Persian',
  per: 'Persian',
  qad: 'Audio description',
  und: 'Undetermined',
};

export function humanizeField(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (character) => character.toUpperCase());
}

export function readableLanguages(value: string): string {
  return value
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      const match = /^([a-z]{3})(.*)$/i.exec(trimmed);
      if (!match) return trimmed;
      const code = (match[1] as string).toLowerCase();
      const name = ISO639_NAMES[code];
      return name ? `${name} (${code})${match[2]}` : trimmed;
    })
    .join(', ');
}

export function hex16(value: number | undefined): string {
  return `0x${Number(value ?? 0).toString(16).padStart(4, '0').toUpperCase()}`;
}

export function formatBytes(value: number | undefined): string {
  const bytes = Number(value ?? 0);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export function formatBitrate(value: number | undefined): string {
  const bps = Number(value ?? 0);
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} Mb/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} kb/s`;
  return `${bps} b/s`;
}

export function formatDuration(value: number | undefined): string {
  const sec = Number(value ?? 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h > 0 ? `${h}:` : ''}${String(m).padStart(h > 0 ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatCueTime(value: number): string {
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return `${h > 0 ? `${h}:` : ''}${String(m).padStart(2, '0')}:${s
    .toFixed(3)
    .padStart(6, '0')}`;
}

export function formatIsoMinute(value: string | undefined): string {
  if (!value) return '-';
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  return match ? `${match[1]} ${match[2]}` : value;
}

export function formatIsoClock(value: string | undefined): string {
  if (!value) return '-';
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(value);
  return match ? `${match[1]} ${match[2]}` : value;
}

export function formatClockRange(start: string, end: string): string {
  const from = formatIsoClock(start);
  const to = formatIsoClock(end);
  if (from.slice(0, 10) === to.slice(0, 10)) return `${from} — ${to.slice(11)}`;
  return `${from} — ${to}`;
}

export function formatOffset(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+';
  const absolute = Math.abs(seconds);
  const hours = Math.floor(absolute / 3600);
  const minutes = Math.floor((absolute % 3600) / 60);
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function languageLabel(code: string): string {
  const name = ISO639_NAMES[code.toLowerCase()];
  return name ? `${name} (${code})` : code;
}

export function esText(
  stream: ProbeService['streams'][number],
  t: (key: UiKey, vars?: Vars) => string,
): string {
  const es = stream.es;
  if (!es) return '';
  const parts: string[] = [];
  if (es.kind === 'audio' && es.codec && /private data/i.test(stream.description)) {
    parts.push(es.codec);
  }
  if (es.width && es.height) parts.push(`${es.width}x${es.height}`);
  if (es.frameRate) parts.push(`${Number(es.frameRate.toFixed(2))}fps`);
  if (es.interlaced) parts.push(t('es.interlaced'));
  if (es.aspectRatio) parts.push(es.aspectRatio);
  if (es.sampleRate) parts.push(`${(es.sampleRate / 1000).toFixed(1)}kHz`);
  if (es.channels) parts.push(`${es.channels}ch`);
  if (es.bitrateBps) parts.push(formatBitrate(es.bitrateBps));
  if (es.profile || es.level) parts.push([es.profile, es.level].filter(Boolean).join('/'));
  const ac3 = stream.descriptors.find((descriptor) => descriptor.tag === 0x81)?.fields;
  if (typeof ac3?.audioServiceTypeName === 'string') {
    parts.push(ac3.audioServiceTypeName);
  }
  if (typeof ac3?.bsid === 'number') parts.push(`bsid ${ac3.bsid}`);
  return parts.join(' ');
}

export function streamTitle(
  stream: ProbeService['streams'][number],
): string {
  if (/^(PES )?private data$/i.test(stream.description) && stream.es?.codec) {
    const kind =
      stream.es.kind === 'audio' ? 'audio' : stream.es.kind === 'video' ? 'video' : '';
    return `${stream.es.codec}${kind ? ` ${kind}` : ''}`;
  }
  return stream.description;
}
