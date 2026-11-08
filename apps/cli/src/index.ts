#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { Command, InvalidArgumentError } from 'commander';
import { startServer } from '@tsinspect/server/app';
import { probeBuffer, formatBytes, hex16, type ProbeResult, type ProbeTable } from '@tsinspect/core';
import {
  collectScte35Timeline,
  collectTeletextPages,
  detectPacketLayout,
  extractAribCaptionText,
  indexDvbSubtitlePes,
  indexPesStreams,
  parseTeletextPes,
  type Scte35Timeline,
  type Scte35TimelineEvent,
} from '@tsinspect/core';
import { loadSource, parseByteSize } from './source.js';
import { formatProbeText, formatTableIndexText } from './format/probe.js';
import { formatProbeHtml } from './format/html.js';
import { formatTableIndexHtml } from './format/tables.js';
import { formatPesText } from './format/pes.js';
import { runExtract, type ExtractKind } from './extract.js';
import {
  formatValidationJson,
  formatValidationText,
  summarizeDiagnostics,
} from './format/validate.js';

const VERSION = '0.0.1';
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const OUTPUT_FORMATS = ['text', 'json', 'html'] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

interface ProbeCommandOptions {
  bytes?: number;
  all?: boolean;
  format: OutputFormat;
  out?: string;
  profile?: 'auto' | 'japan' | 'brazil';
}

interface TablesCommandOptions extends ProbeCommandOptions {
  table?: string;
  pid?: number[];
  detail?: boolean;
}

interface ValidateCommandOptions extends ProbeCommandOptions {
  strict?: boolean;
}

interface PesCommandOptions extends ProbeCommandOptions {
  pid?: number[];
  timeline?: boolean;
}

interface ExtractCommandOptions extends ProbeCommandOptions {
  kind: ExtractKind;
  pid?: number[];
  out: string;
}

interface ServeCommandOptions {
  port: number;
  host: string;
  open?: boolean;
}

const program = new Command();

program
  .name('tsinspect')
  .description('MPEG-TS transport stream inspector for DVB, ATSC 1.0 and ISDB-T/Tb')
  .version(VERSION)
  .showHelpAfterError();

program
  .command('probe')
  .description('analyse a local file or HTTP(S) transport stream')
  .argument('<source>', 'path to a .ts/.m2ts/.trp file or an HTTP(S) URL')
  .option(
    '-b, --bytes <size>',
    'read at most this many bytes (default 64 MiB; 0 reads everything)',
    parseSizeArgument,
  )
  .option('-a, --all', 'show every PID, raw descriptor bytes and full evidence')
  .option(
    '--profile <profile>',
    'text profile: auto (default), japan or brazil',
    parseProfileArgument,
    'auto',
  )
  .option(
    '-f, --format <format>',
    `output format: ${OUTPUT_FORMATS.join(', ')}`,
    parseFormatArgument,
    'text',
  )
  .option('-o, --out <file>', 'write the report to a file instead of stdout')
  .action(async (source: string, options: ProbeCommandOptions) => {
    try {
      const result = await runProbe(source, options);
      const output = render(result, options.format, options.all ?? false);

      if (options.out) {
        await writeFile(options.out, `${output}\n`, 'utf8');
        process.stderr.write(
          `tsinspect: wrote ${options.format} report to ${options.out} (${result.services.length} service(s), ${result.pids.length} PID(s))\n`,
        );
      } else {
        process.stdout.write(`${output}\n`);
      }

      if (result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
        process.exitCode = 2;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`tsinspect: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('tables')
  .description('list PSI/SI tables in a local file or HTTP(S) transport stream')
  .argument('<source>', 'path to a .ts/.m2ts/.trp file or an HTTP(S) URL')
  .option(
    '-b, --bytes <size>',
    'read at most this many bytes (default 64 MiB; 0 reads everything)',
    parseSizeArgument,
  )
  .option('-t, --table <names>', 'only tables matching names or ids (comma separated)')
  .option('-p, --pid <pids>', 'only tables on these PIDs (comma separated)', parsePidListArgument)
  .option('-d, --detail', 'show parsed table summaries (BAT, RST, AIT, ...)')
  .option('-a, --all', 'include private/unknown table ids')
  .option(
    '--profile <profile>',
    'text profile: auto (default), japan or brazil',
    parseProfileArgument,
    'auto',
  )
  .option(
    '-f, --format <format>',
    `output format: ${OUTPUT_FORMATS.join(', ')}`,
    parseFormatArgument,
    'text',
  )
  .option('-o, --out <file>', 'write the table index to a file instead of stdout')
  .action(async (source: string, options: TablesCommandOptions) => {
    try {
      const result = await runProbe(source, options);
      const tableFilters = options.table ? parseTableFilterList(options.table) : [];
      let tables = result.tables;
      if (tableFilters.length > 0) {
        tables = tables.filter((table) => tableMatches(table, tableFilters));
      }
      if (options.pid && options.pid.length > 0) {
        const pids = new Set(options.pid);
        tables = tables.filter((table) => pids.has(table.pid));
      }
      const filtered: ProbeResult = { ...result, tables };
      const output = renderTables(filtered, options.format, options.all ?? false, options.detail ?? false);

      if (options.out) {
        await writeFile(options.out, `${output}\n`, 'utf8');
        process.stderr.write(
          `tsinspect: wrote ${options.format} table index to ${options.out} (${filtered.tables.length} table(s))\n`,
        );
      } else {
        process.stdout.write(`${output}\n`);
      }

      if (result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
        process.exitCode = 2;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`tsinspect: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('validate')
  .description('check a transport stream for transport, PSI and PSIP errors')
  .argument('<source>', 'path to a .ts/.m2ts/.trp file or an HTTP(S) URL')
  .option(
    '-b, --bytes <size>',
    'read at most this many bytes (default 64 MiB; 0 reads everything)',
    parseSizeArgument,
  )
  .option('--strict', 'treat warnings as validation failures')
  .option(
    '--profile <profile>',
    'text profile: auto (default), japan or brazil',
    parseProfileArgument,
    'auto',
  )
  .option(
    '-f, --format <format>',
    `output format: ${OUTPUT_FORMATS.join(', ')}`,
    parseFormatArgument,
    'text',
  )
  .option('-o, --out <file>', 'write the validation report to a file instead of stdout')
  .action(async (source: string, options: ValidateCommandOptions) => {
    try {
      const result = await runProbe(source, options);
      const summary = summarizeDiagnostics(result.diagnostics, {
        strict: options.strict ?? false,
      });
      const output =
        options.format === 'json'
          ? formatValidationJson(result, { strict: options.strict ?? false })
          : options.format === 'html'
            ? formatProbeHtml(result)
            : formatValidationText(result, { strict: options.strict ?? false });

      if (options.out) {
        await writeFile(options.out, `${output}\n`, 'utf8');
        process.stderr.write(
          `tsinspect: wrote ${options.format} validation report to ${options.out}\n`,
        );
      } else {
        process.stdout.write(`${output}\n`);
      }

      if (summary.errors > 0) {
        process.exitCode = 4;
      } else if (summary.warnings > 0) {
        process.exitCode = options.strict ? 4 : 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`tsinspect: ${message}\n`);
      process.exitCode = 2;
    }
  });

program
  .command('pes')
  .description('list PES streams and PTS ranges in a transport stream')
  .argument('<source>', 'path to a .ts/.m2ts/.trp file or an HTTP(S) URL')
  .option(
    '-b, --bytes <size>',
    'read at most this many bytes (default 64 MiB; 0 reads everything)',
    parseSizeArgument,
  )
  .option('-p, --pid <pids>', 'only these PIDs (comma separated)', parsePidListArgument)
  .option(
    '--profile <profile>',
    'text profile: auto (default), japan or brazil',
    parseProfileArgument,
    'auto',
  )
  .option(
    '-f, --format <format>',
    'output format: text, json',
    parseTextJsonFormatArgument,
    'text',
  )
  .option('-o, --out <file>', 'write the PES index to a file instead of stdout')
  .action(async (source: string, options: PesCommandOptions) => {
    try {
      const { data, result } = await loadSourceAndProbe(source, options);
      const layout = detectPacketLayout(data);
      if (!layout) throw new Error('No MPEG-TS sync pattern found in the sampled data.');
      const streams = indexPesStreams(
        data,
        layout,
        options.pid !== undefined ? new Set(options.pid) : undefined,
      );
      const output =
        options.format === 'json'
          ? JSON.stringify(
              {
                schemaVersion: result.schemaVersion,
                tool: result.tool,
                source: result.source,
                standard: result.standard,
                streams,
              },
              null,
              2,
            )
          : formatPesText(result, streams);

      if (options.out) {
        await writeFile(options.out, `${output}\n`, 'utf8');
        process.stderr.write(`tsinspect: wrote PES index to ${options.out}\n`);
      } else {
        process.stdout.write(`${output}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`tsinspect: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('extract')
  .description('extract Teletext, DVB subtitle, ARIB/ATSC caption or VBI data')
  .argument('<source>', 'path to a .ts/.m2ts/.trp file or an HTTP(S) URL')
  .option(
    '-b, --bytes <size>',
    'read at most this many bytes (default 64 MiB; 0 reads everything)',
    parseSizeArgument,
  )
  .option(
    '-k, --kind <kind>',
    'teletext, dvb-subtitle, arib-caption, atsc-caption, vbi or all',
    parseExtractKindArgument,
    'all',
  )
  .option('-p, --pid <pids>', 'only these PIDs (comma separated)', parsePidListArgument)
  .option('-o, --out <dir>', 'output directory', 'extract')
  .option(
    '--profile <profile>',
    'text profile: auto (default), japan or brazil',
    parseProfileArgument,
    'auto',
  )
  .action(async (source: string, options: ExtractCommandOptions) => {
    try {
      const { data, result } = await loadSourceAndProbe(source, options);
      const layout = detectPacketLayout(data);
      if (!layout) throw new Error('No MPEG-TS sync pattern found in the sampled data.');
      const profile =
        options.profile === 'brazil' ||
        (options.profile !== 'japan' && result.packet.size === 204)
          ? 'brazil'
          : 'japan';
      const extracted = await runExtract(data, layout, result, {
        kind: options.kind,
        ...(options.pid !== undefined ? { pids: options.pid } : {}),
        outDir: options.out,
        profile,
      });
      process.stdout.write(`tsinspect: extracted ${extracted.files.length} file(s) to ${options.out}\n`);
      for (const line of extracted.lines) process.stdout.write(`  ${line}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`tsinspect: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('scte35')
  .description('list SCTE-35 splice information sections')
  .argument('<source>', 'path to a .ts/.m2ts/.trp file or an HTTP(S) URL')
  .option(
    '-b, --bytes <size>',
    'read at most this many bytes (default 64 MiB; 0 reads everything)',
    parseSizeArgument,
  )
  .option('-p, --pid <pids>', 'only these PIDs (comma separated)', parsePidListArgument)
  .option(
    '-t, --timeline',
    'include estimated event times and derived break intervals',
    false,
  )
  .option(
    '-f, --format <format>',
    'output format: text, json',
    parseTextJsonFormatArgument,
    'text',
  )
  .option('-o, --out <file>', 'write the SCTE-35 index to a file instead of stdout')
  .action(async (source: string, options: PesCommandOptions) => {
    try {
      const { data, result } = await loadSourceAndProbe(source, options);
      const layout = detectPacketLayout(data);
      if (!layout) throw new Error('No MPEG-TS sync pattern found in the sampled data.');
      const pids = options.pid
        ? new Set(options.pid)
        : new Set(
            result.services.flatMap((service) =>
              service.streams
                .filter(
                  (stream) =>
                    stream.streamType === 0x86 ||
                    stream.descriptors.some(
                      (descriptor) =>
                        descriptor.tag === 0x05 &&
                        descriptor.fields?.formatIdentifier === 'CUEI',
                    ),
                )
                .map((stream) => stream.pid),
            ),
          );

      const timeline = collectScte35Timeline(data, layout, {
        pids,
        ...(result.transport.bitrateBps !== undefined
          ? { bitrateBps: result.transport.bitrateBps }
          : {}),
        ...(result.transport.durationSec !== undefined
          ? { durationSec: result.transport.durationSec }
          : {}),
      });

      const output =
        options.format === 'json'
          ? JSON.stringify(
              {
                schemaVersion: result.schemaVersion,
                tool: result.tool,
                source: result.source,
                standard: result.standard,
                events: timeline.events,
                breaks: timeline.breaks,
                pids: timeline.pids,
                count: timeline.count,
                truncated: timeline.truncated,
              },
              null,
              2,
            )
          : formatScte35Text(result, timeline, options.timeline === true);

      if (options.out) {
        await writeFile(options.out, `${output}\n`, 'utf8');
        process.stderr.write(`tsinspect: wrote SCTE-35 index to ${options.out}\n`);
      } else {
        process.stdout.write(`${output}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`tsinspect: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('version')
  .description('print the version')
  .action(() => {
    process.stdout.write(`${VERSION}\n`);
  });

async function runProbe(source: string, options: ProbeCommandOptions): Promise<ProbeResult> {
  return (await loadSourceAndProbe(source, options)).result;
}

async function loadSourceAndProbe(
  source: string,
  options: ProbeCommandOptions,
): Promise<{ data: Uint8Array; result: ProbeResult }> {
  const maxBytes = options.bytes ?? DEFAULT_MAX_BYTES;
  const loaded = await loadSource(source, { maxBytes });
  if (
    options.bytes === undefined &&
    loaded.size !== undefined &&
    loaded.data.length < loaded.size
  ) {
    process.stderr.write(
      `tsinspect: ${loaded.name}: analysed first ${formatBytes(loaded.data.length)} of ${formatBytes(
        loaded.size,
      )} (default cap); use --bytes 0 for the whole source\n`,
    );
  }
  const result = probeBuffer(loaded.data, {
    name: loaded.name,
    kind: loaded.kind,
    ...(loaded.size !== undefined ? { size: loaded.size } : {}),
    full: loaded.size === undefined ? maxBytes === 0 : loaded.data.length >= loaded.size,
    toolVersion: VERSION,
    textProfile: options.profile ?? 'auto',
  });
  return { data: loaded.data, result };
}

function render(result: ProbeResult, format: OutputFormat, all: boolean): string {
  switch (format) {
    case 'json':
      return JSON.stringify(result, null, 2);
    case 'html':
      return formatProbeHtml(result, { all });
    case 'text':
      return formatProbeText(result, { all });
  }
}

function renderTables(
  result: ProbeResult,
  format: OutputFormat,
  all: boolean,
  detail = false,
): string {
  switch (format) {
    case 'json':
      return JSON.stringify(
        {
          schemaVersion: result.schemaVersion,
          tool: result.tool,
          source: result.source,
          standard: result.standard,
          tables: result.tables,
        },
        null,
        2,
      );
    case 'html':
      return formatTableIndexHtml(result, { all });
    case 'text':
      return formatTableIndexText(result, { all, detail });
  }
}

function formatScte35Text(
  result: ProbeResult,
  timeline: Scte35Timeline,
  withBreaks: boolean,
): string {
  const lines: string[] = [];
  lines.push(`tsinspect ${result.tool.version} - SCTE-35 splice information`);
  lines.push('');
  lines.push(`Source       ${result.source.name}`);
  lines.push(`Standard     ${result.standard.detected}`);
  if (timeline.pids.length > 0) {
    lines.push(`PIDs         ${timeline.pids.map((pid) => hex16(pid)).join(', ')}`);
  }
  lines.push('');
  lines.push(`SCTE-35 (${timeline.count}${timeline.truncated ? '+ (truncated)' : ''})`);
  lines.push('---------');
  if (timeline.events.length === 0) {
    lines.push('  None.');
    return lines.join('\n');
  }
  for (const event of timeline.events) {
    lines.push(`  ${formatEventTime(event)}${formatScte35Event(event)}`);
  }
  if (withBreaks) {
    lines.push('');
    lines.push(`Breaks (${timeline.breaks.length})`);
    lines.push('---------');
    if (timeline.breaks.length === 0) {
      lines.push('  None.');
    } else {
      for (const entry of timeline.breaks) {
        const position =
          entry.startSec !== undefined && entry.endSec !== undefined
            ? `${entry.startSec.toFixed(3)}s - ${entry.endSec.toFixed(3)}s`
            : `packet ${entry.startPacket}`;
        lines.push(
          `  ${position} (${entry.durationSec.toFixed(3)}s) PID ${entry.pidHex} ${entry.commandName}` +
            `${entry.eventId !== undefined ? ` event=${entry.eventId}` : ''}` +
            `${entry.segmentationEventId !== undefined ? ` segEvent=${entry.segmentationEventId}` : ''}` +
            `${entry.segmentationTypeName !== undefined ? ` seg=${entry.segmentationTypeName}` : ''}` +
            `${entry.outOfNetwork ? ' out' : ''}` +
            `${entry.autoReturn ? ' auto' : ''}` +
            `${entry.availNum !== undefined ? ` avail=${entry.availNum}/${entry.availsExpected ?? '-'}` : ''}`,
        );
      }
    }
  }
  return lines.join('\n');
}

function formatEventTime(event: Scte35TimelineEvent): string {
  return `${(event.timeSec !== undefined ? `${event.timeSec.toFixed(3)}s` : '-').padStart(9)} `;
}

function formatScte35Event(event: Scte35TimelineEvent): string {
  const pts =
    event.splicePts !== undefined ? `${(event.splicePts / 90_000).toFixed(3)}s` : '-';
  const duration =
    event.breakDuration !== undefined
      ? `${(event.breakDuration / 90_000).toFixed(3)}s${event.autoReturn ? ' auto' : ''}`
      : '-';
  return (
    `PID ${event.pidHex} packet ${event.packet}: ${event.commandName}` +
    `${event.eventId !== undefined ? ` event=${event.eventId}` : ''}` +
    `${event.outOfNetwork ? ' out' : ''}` +
    `${event.spliceImmediate ? ' immediate' : ''}` +
    `${event.uniqueProgramId !== undefined ? ` program=${event.uniqueProgramId}` : ''}` +
    ` pts=${pts} duration=${duration}` +
    `${event.segmentationTypeName !== undefined ? ` seg=${event.segmentationTypeName}` : ''}` +
    `${event.segmentationDuration !== undefined ? ` segdur=${(event.segmentationDuration / 90_000).toFixed(3)}s` : ''}` +
    `${event.segmentationEventId !== undefined ? ` segEvent=${event.segmentationEventId}` : ''}` +
    `${event.repeats !== undefined ? ` x${event.repeats}` : ''}` +
    `${event.availNum !== undefined ? ` avail=${event.availNum}/${event.availsExpected ?? '-'}` : ''}` +
    `${event.source === 'pes' ? ' (PES)' : ''}` +
    `${event.crcValid ? '' : ' CRC=BAD'}`
  );
}

function parsePidListArgument(value: string): number[] {
  const parts = value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new InvalidArgumentError('expected at least one PID');
  return parts.map((part) => {
    const pid = part.startsWith('0x') ? Number.parseInt(part.slice(2), 16) : Number.parseInt(part, 10);
    if (!Number.isInteger(pid) || pid < 0 || pid > 0x1fff) {
      throw new InvalidArgumentError(`invalid PID: ${part}`);
    }
    return pid;
  });
}

function parseTableFilterList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

function tableMatches(table: ProbeTable, filters: string[]): boolean {
  const name = table.name.toLowerCase();
  const idHex = table.tableIdHex.toLowerCase();
  const idDec = String(table.tableId);
  return filters.some((filter) => {
    if (name === filter || name.includes(filter) || idHex === filter || idDec === filter) {
      return true;
    }
    return filter.startsWith('0x') && Number.parseInt(filter.slice(2), 16) === table.tableId;
  });
}

function parseSizeArgument(value: string): number {
  try {
    const size = parseByteSize(value);
    if (size < 0) throw new Error('size must not be negative');
    return size;
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function parseFormatArgument(value: string): OutputFormat {
  const normalized = value.toLowerCase();
  if ((OUTPUT_FORMATS as readonly string[]).includes(normalized)) {
    return normalized as OutputFormat;
  }
  throw new InvalidArgumentError(`expected one of: ${OUTPUT_FORMATS.join(', ')}`);
}

function parseTextJsonFormatArgument(value: string): OutputFormat {
  const normalized = value.toLowerCase();
  if (normalized === 'text' || normalized === 'json') return normalized;
  throw new InvalidArgumentError('expected one of: text, json');
}

function parseProfileArgument(value: string): 'auto' | 'japan' | 'brazil' {
  const normalized = value.toLowerCase();
  if (normalized === 'auto' || normalized === 'japan' || normalized === 'brazil') {
    return normalized;
  }
  throw new InvalidArgumentError('expected one of: auto, japan, brazil');
}

function parseExtractKindArgument(value: string): ExtractKind {
  const normalized = value.toLowerCase();
  if (
    normalized === 'teletext' ||
    normalized === 'dvb-subtitle' ||
    normalized === 'arib-caption' ||
    normalized === 'atsc-caption' ||
    normalized === 'vbi' ||
    normalized === 'all'
  ) {
    return normalized;
  }
  throw new InvalidArgumentError(
    'expected one of: teletext, dvb-subtitle, arib-caption, atsc-caption, vbi, all',
  );
}

function parsePortArgument(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError('expected a port between 1 and 65535');
  }
  return port;
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // Opening the browser is a convenience; the URL is printed either way.
  }
}

program
  .command('serve')
  .description('start the local web UI')
  .option(
    '-p, --port <port>',
    'preferred port; the next free port is used when occupied (default 5173)',
    parsePortArgument,
    5173,
  )
  .option('--host <host>', 'listen address', '127.0.0.1')
  .option('--open', 'open the web UI in the default browser', false)
  .action(async (options: ServeCommandOptions) => {
    try {
      const { url } = await startServer({
        port: options.port,
        host: options.host,
        findFreePort: true,
      });
      process.stdout.write(`tsinspect web UI: ${url}\n`);
      process.stdout.write('Press Ctrl+C to stop.\n');
      if (options.open) openBrowser(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`tsinspect: ${message}\n`);
      process.exitCode = 1;
    }
  });

// `tsinspect <source>` is a friendly alias for `tsinspect probe <source>`.
// Without arguments (for example a double-clicked executable) the web UI starts.
const argv = process.argv.slice(2);
const KNOWN_COMMANDS = new Set([
  'probe',
  'tables',
  'validate',
  'pes',
  'extract',
  'scte35',
  'serve',
  'version',
  'help',
]);
if (argv.length === 0) {
  argv.push('serve', '--open');
} else if (!argv[0]!.startsWith('-') && !KNOWN_COMMANDS.has(argv[0]!)) {
  argv.unshift('probe');
}

void program.parseAsync(argv, { from: 'user' });
