import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatTeletextHtml } from './format/teletext.js';
import type {
  PacketLayout,
  PesPacket,
  ProbeResult,
  ProbeService,
  ProbeStream,
} from '@tsinspect/core';
import {
  collectPesPackets,
  createAribDrcsContext,
  extractAribCaptionText,
  indexDvbSubtitlePes,
  parseAtscCaptionPayload,
  parseTeletextPes,
  parseVbiPes,
  TeletextCollector,
  type TeletextPage,
} from '@tsinspect/core';

export type ExtractKind =
  | 'teletext'
  | 'dvb-subtitle'
  | 'arib-caption'
  | 'atsc-caption'
  | 'vbi'
  | 'all';

export interface ExtractOptions {
  kind: ExtractKind;
  pids?: number[];
  outDir: string;
  profile: 'japan' | 'brazil';
}

export interface ExtractResult {
  lines: string[];
  files: string[];
}

type TargetKind = 'teletext' | 'dvb-subtitle' | 'arib-caption' | 'atsc-caption' | 'vbi';

interface TargetStream {
  pid: number;
  kind: TargetKind;
}

function hasDescriptor(stream: ProbeStream, tag: number): boolean {
  return stream.descriptors.some((descriptor) => descriptor.tag === tag);
}

function isAribCaption(stream: ProbeStream): boolean {
  return stream.descriptors.some((descriptor) => {
    if (descriptor.tag !== 0xfd) return false;
    const id = descriptor.fields?.dataComponentId;
    return id === 0x0008 || id === 0x0012;
  });
}

function classifyStream(
  stream: ProbeStream,
  service: ProbeService,
  kind: ExtractKind,
): TargetKind | undefined {
  if (kind === 'teletext' || kind === 'all') {
    if (hasDescriptor(stream, 0x56)) return 'teletext';
  }
  if (kind === 'dvb-subtitle' || kind === 'all') {
    if (hasDescriptor(stream, 0x59)) return 'dvb-subtitle';
  }
  if (kind === 'arib-caption' || kind === 'all') {
    if (isAribCaption(stream)) return 'arib-caption';
  }
  if (kind === 'vbi' || kind === 'all') {
    if (hasDescriptor(stream, 0x45) || hasDescriptor(stream, 0x46)) return 'vbi';
  }
  if (kind === 'atsc-caption' || kind === 'all') {
    const video = [0x01, 0x02, 0x1b, 0x24, 0xea].includes(stream.streamType);
    const captionSignalled =
      hasDescriptor(stream, 0x86) ||
      service.descriptors.some((descriptor) => descriptor.tag === 0x86);
    if (video && captionSignalled) return 'atsc-caption';
  }
  return undefined;
}

function hasConditionalAccess(stream: ProbeStream, result: ProbeResult): boolean {
  if (stream.descriptors.some((descriptor) => descriptor.tag === 0x09 || descriptor.tag === 0xf6)) {
    return true;
  }
  const service = result.services.find((entry) =>
    entry.streams.some((candidate) => candidate.pid === stream.pid),
  );
  return service?.descriptors.some(
    (descriptor) => descriptor.tag === 0x09 || descriptor.tag === 0xf6,
  ) ?? false;
}

function resolveTargets(result: ProbeResult, options: ExtractOptions): TargetStream[] {
  const targets = new Map<number, TargetStream>();
  const explicitlyRequested = options.pids !== undefined;
  for (const service of result.services) {
    for (const stream of service.streams) {
      if (!explicitlyRequested) {
        const pidInfo = result.pids.find((pid) => pid.pid === stream.pid);
        if (pidInfo && pidInfo.packets > 0 && pidInfo.scrambled >= pidInfo.packets * 0.5) {
          continue;
        }
        if (hasConditionalAccess(stream, result)) continue;
      }
      const kind = classifyStream(stream, service, options.kind);
      if (kind) targets.set(stream.pid, { pid: stream.pid, kind });
    }
  }

  if (options.pids !== undefined) {
    const wanted = new Set(options.pids);
    for (const pid of [...targets.keys()]) {
      if (!wanted.has(pid)) targets.delete(pid);
    }
    for (const pid of options.pids) {
      if (targets.has(pid) || options.kind === 'all') continue;
      targets.set(pid, { pid, kind: options.kind });
    }
  }

  return [...targets.values()].sort((a, b) => a.pid - b.pid);
}

function pidName(pid: number): string {
  return pid.toString(16).padStart(4, '0');
}

function srtTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

interface Cue {
  start: number;
  end: number;
  text: string;
  /** Subtitle-friendly text: rows trimmed, leading/trailing blanks removed. */
  srtText?: string;
  label?: string;
  subtitle?: boolean;
}

function cuesToSrt(cues: Cue[]): string {
  return cues
    .map(
      (cue, index) =>
        `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.srtText ?? cue.text}\n`,
    )
    .join('\n');
}

function collapseSameTimeCues(cues: Cue[]): Cue[] {
  // Teletext can emit several snapshots for the same page transmission (for
  // example a partial page followed by an added row, or a scrolling newsflash
  // line). They share the page start time; keep the most complete/latest one.
  const byTransmission = new Map<string, Cue>();
  for (const cue of cues) {
    byTransmission.set(`${cue.label ?? ''}|${cue.start.toFixed(3)}`, cue);
  }
  return [...byTransmission.values()];
}

function finishCues(cues: Cue[]): Cue[] {
  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i] as Cue;
    let next = cue.start + 5;
    for (let j = i + 1; j < cues.length; j += 1) {
      const candidate = cues[j] as Cue;
      if (cue.label === undefined || candidate.label === cue.label) {
        next = candidate.start;
        break;
      }
    }
    cue.end = Math.max(cue.start + 0.5, next);
  }
  return cues;
}

async function processTeletext(
  target: TargetStream,
  packets: PesPacket[],
  options: ExtractOptions,
  files: string[],
  result: ProbeResult,
): Promise<string> {
  const cues: Cue[] = [];
  const lastText = new Map<string, string>();
  // Keep only the latest snapshot per page for the human-readable text dump
  // and the HTML view; JSON cues retain every timed transmission.
  const renderedPages = new Map<string, TeletextPage>();
  const collector = new TeletextCollector();
  let pesCount = 0;
  let lastTime = 0;

  const addPage = (page: TeletextPage, fallbackTime: number): void => {
    // C10: rows 1-24 of an inhibited page are not displayed; such pages are
    // often hidden crew/status sheets and must not become subtitles.
    if (page.control?.inhibitDisplay) return;
    if (page.text.length === 0) return;
    if (lastText.get(page.label) === page.text) return;
    lastText.set(page.label, page.text);
    renderedPages.set(page.label, page);
    const start = page.startTime ?? fallbackTime;
    const srtText = page.text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n');
    cues.push({
      start,
      end: start + 5,
      text: page.text,
      ...(srtText !== page.text ? { srtText } : {}),
      label: page.label,
      subtitle: page.subtitle,
    });
  };

  for (const pes of packets) {
    const teletext = parseTeletextPes(pes.payload);
    if (!teletext) continue;
    pesCount += 1;
    const start = pes.ptsSeconds ?? 0;
    lastTime = start;
    for (const page of collector.push(teletext, start)) addPage(page, start);
  }
  for (const page of collector.flush()) addPage(page, lastTime);
  const finalCues = finishCues(collapseSameTimeCues(cues));

  const base = join(options.outDir, `teletext-pid-${pidName(target.pid)}`);
  const pageList = [...renderedPages.values()].sort(
    (a, b) => (a.startTime ?? 0) - (b.startTime ?? 0) || a.label.localeCompare(b.label),
  );
  await writeFile(
    `${base}.json`,
    `${JSON.stringify({ pid: target.pid, kind: 'teletext', cues: finalCues }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    `${base}.txt`,
    pageList
      .map((page) => `[${page.label}] ${(page.startTime ?? lastTime).toFixed(3)}s\n${page.text}\n`)
      .join('\n'),
    'utf8',
  );
  await writeFile(`${base}.srt`, cuesToSrt(finalCues.filter((cue) => cue.subtitle)), 'utf8');
  await writeFile(`${base}.html`, formatTeletextHtml(result, target.pid, pageList), 'utf8');
  files.push(`${base}.json`, `${base}.txt`, `${base}.srt`, `${base}.html`);
  return `PID 0x${pidName(target.pid)} teletext: ${pesCount} PES, ${finalCues.length} page cue(s)`;
}

async function processAribCaption(
  target: TargetStream,
  packets: PesPacket[],
  options: ExtractOptions,
  files: string[],
): Promise<string> {
  const cues: Cue[] = [];
  const drcs = createAribDrcsContext();
  let pesCount = 0;
  for (const pes of packets) {
    const caption = extractAribCaptionText(pes.payload, options.profile, { drcs });
    if (!caption) continue;
    pesCount += 1;
    cues.push({
      start: pes.ptsSeconds ?? 0,
      end: (pes.ptsSeconds ?? 0) + 5,
      text: caption.text,
    });
  }
  finishCues(cues);

  const base = join(options.outDir, `arib-caption-pid-${pidName(target.pid)}`);
  await writeFile(`${base}.srt`, cuesToSrt(cues), 'utf8');
  await writeFile(
    `${base}.json`,
    `${JSON.stringify({ pid: target.pid, kind: 'arib-caption', profile: options.profile, cues }, null, 2)}\n`,
    'utf8',
  );
  files.push(`${base}.srt`, `${base}.json`);
  return `PID 0x${pidName(target.pid)} ARIB caption: ${pesCount} PES, ${cues.length} cue(s)`;
}

async function processDvbSubtitle(
  target: TargetStream,
  packets: PesPacket[],
  options: ExtractOptions,
  files: string[],
): Promise<string> {
  const entries: unknown[] = [];
  for (const pes of packets) {
    const index = indexDvbSubtitlePes(pes.payload);
    if (!index) continue;
    entries.push({ pts: pes.ptsSeconds, ...index });
  }

  const base = join(options.outDir, `dvb-subtitle-pid-${pidName(target.pid)}`);
  await writeFile(
    `${base}.json`,
    `${JSON.stringify({ pid: target.pid, kind: 'dvb-subtitle', entries }, null, 2)}\n`,
    'utf8',
  );
  files.push(`${base}.json`);
  return `PID 0x${pidName(target.pid)} DVB subtitle: ${entries.length} PES with segments indexed (bitmap, no text)`;
}

async function processAtscCaption(
  target: TargetStream,
  packets: PesPacket[],
  options: ExtractOptions,
  files: string[],
): Promise<string> {
  const ordered = [...packets].sort(
    (a, b) => (a.ptsSeconds ?? 0) - (b.ptsSeconds ?? 0),
  );
  const cues608: Cue[] = [];
  const cues708: Cue[] = [];
  let pending608 = '';
  let pending708 = '';
  let start608: number | undefined;
  let start708: number | undefined;
  let pesCount = 0;
  let dtvccBytes = 0;

  for (const pes of ordered) {
    const caption = parseAtscCaptionPayload(pes.payload);
    if (!caption) continue;
    pesCount += 1;
    dtvccBytes += caption.dtvccBytes;

    if (caption.characters.length > 0) {
      if (start608 === undefined) start608 = pes.ptsSeconds ?? 0;
      pending608 += caption.characters;
    }
    if (caption.dtvccText.length > 0) {
      if (start708 === undefined) start708 = pes.ptsSeconds ?? 0;
      pending708 += caption.dtvccText;
    }
    if (caption.flushed) {
      const text = pending608.replace(/\s+/g, ' ').trim();
      if (text.length > 0) {
        cues608.push({
          start: start608 ?? pes.ptsSeconds ?? 0,
          end: (start608 ?? pes.ptsSeconds ?? 0) + 5,
          text,
        });
      }
      pending608 = '';
      start608 = undefined;
    }
    if (caption.dtvccFlushed) {
      const text = pending708.replace(/\s+/g, ' ').trim();
      if (text.length > 0) {
        cues708.push({
          start: start708 ?? pes.ptsSeconds ?? 0,
          end: (start708 ?? pes.ptsSeconds ?? 0) + 5,
          text,
        });
      }
      pending708 = '';
      start708 = undefined;
    }
  }

  if (pending608.trim().length > 0) {
    cues608.push({
      start: start608 ?? 0,
      end: (start608 ?? 0) + 5,
      text: pending608.replace(/\s+/g, ' ').trim(),
    });
  }
  if (pending708.trim().length > 0) {
    cues708.push({
      start: start708 ?? 0,
      end: (start708 ?? 0) + 5,
      text: pending708.replace(/\s+/g, ' ').trim(),
    });
  }

  const cues = (cues708.length > 0 ? cues708 : cues608).filter(
    (cue) => cue.text.length > 0,
  );
  finishCues(cues);

  const base = join(options.outDir, `atsc-caption-pid-${pidName(target.pid)}`);
  await writeFile(`${base}.srt`, cuesToSrt(cues), 'utf8');
  await writeFile(
    `${base}.json`,
    `${JSON.stringify({ pid: target.pid, kind: 'atsc-caption', dtvccBytes, cues }, null, 2)}\n`,
    'utf8',
  );
  files.push(`${base}.srt`, `${base}.json`);
  return `PID 0x${pidName(target.pid)} ATSC caption: ${pesCount} PES, ${cues608.length} 608 cue(s), ${cues708.length} 708 cue(s), ${dtvccBytes} 708 byte(s)`;
}

async function processVbi(
  target: TargetStream,
  packets: PesPacket[],
  options: ExtractOptions,
  files: string[],
): Promise<string> {
  const entries: unknown[] = [];
  const collector = new TeletextCollector();
  const pages: TeletextPage[] = [];
  for (const pes of packets) {
    const vbi = parseVbiPes(pes.payload);
    if (!vbi) continue;
    entries.push({ pts: pes.ptsSeconds, ...vbi });
    if (vbi.units.some((unit) => unit.id === 0x02 || unit.id === 0x03)) {
      const teletext = parseTeletextPes(pes.payload);
      if (teletext) pages.push(...collector.push(teletext, pes.ptsSeconds ?? 0));
    }
  }
  pages.push(...collector.flush());

  const base = join(options.outDir, `vbi-pid-${pidName(target.pid)}`);
  await writeFile(
    `${base}.json`,
    `${JSON.stringify({ pid: target.pid, kind: 'vbi', entries, pages }, null, 2)}\n`,
    'utf8',
  );
  files.push(`${base}.json`);
  if (pages.length > 0) {
    await writeFile(
      `${base}.txt`,
      pages
        .map((page) => `[${page.label}] ${(page.startTime ?? 0).toFixed(3)}s\n${page.text}\n`)
        .join('\n'),
      'utf8',
    );
    await writeFile(
      `${base}.srt`,
      cuesToSrt(
        pages
          .filter((page) => page.subtitle && !page.control?.inhibitDisplay)
          .map((page) => ({
            start: page.startTime ?? 0,
            end: (page.startTime ?? 0) + 5,
            text: page.text,
            srtText: page.text
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .join('\n'),
          })),
      ),
      'utf8',
    );
    files.push(`${base}.txt`, `${base}.srt`);
  }
  return `PID 0x${pidName(target.pid)} VBI: ${entries.length} PES indexed, ${pages.length} Teletext page(s)`;
}

export async function runExtract(
  data: Uint8Array,
  layout: PacketLayout,
  result: ProbeResult,
  options: ExtractOptions,
): Promise<ExtractResult> {
  const targets = resolveTargets(result, options);
  if (targets.length === 0) {
    return { lines: ['No matching elementary streams found.'], files: [] };
  }

  const pids = new Set(targets.map((target) => target.pid));
  const allPackets = collectPesPackets(data, layout, pids);
  const byPid = new Map<number, PesPacket[]>();
  for (const packet of allPackets) {
    const list = byPid.get(packet.pid) ?? [];
    list.push(packet);
    byPid.set(packet.pid, list);
  }

  await mkdir(options.outDir, { recursive: true });
  const files: string[] = [];
  const lines: string[] = [];

  for (const target of targets) {
    const packets = byPid.get(target.pid) ?? [];
    if (packets.length === 0) {
      lines.push(`PID 0x${pidName(target.pid)} ${target.kind}: no PES packets found`);
      continue;
    }
    const line =
      target.kind === 'teletext'
        ? await processTeletext(target, packets, options, files, result)
        : target.kind === 'arib-caption'
          ? await processAribCaption(target, packets, options, files)
          : target.kind === 'dvb-subtitle'
            ? await processDvbSubtitle(target, packets, options, files)
            : target.kind === 'atsc-caption'
              ? await processAtscCaption(target, packets, options, files)
              : await processVbi(target, packets, options, files);
    lines.push(line);
  }

  return { lines, files };
}
