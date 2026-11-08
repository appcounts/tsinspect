import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { probeBuffer, type ProbeResult } from '@tsinspect/core';

interface Options {
  file: string;
  bytes: number;
  repeat: number;
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { file: '', bytes: 0, repeat: 1, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--bytes') {
      options.bytes = parseSize(argv[++i] as string);
    } else if (arg === '--repeat') {
      options.repeat = Math.max(1, Number.parseInt(argv[++i] as string, 10) || 1);
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (options.file.length === 0) {
      options.file = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (options.file.length === 0) {
    printUsage();
    throw new Error('a transport stream path is required');
  }
  return options;
}

function parseSize(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/i.exec(value.trim());
  if (!match) throw new Error(`invalid byte size: ${value}`);
  const unit = (match[2] ?? 'b').toLowerCase();
  const multiplier =
    unit === 'gb' || unit === 'gib'
      ? 1024 ** 3
      : unit === 'mb' || unit === 'mib'
        ? 1024 ** 2
        : unit === 'kb' || unit === 'kib'
          ? 1024
          : 1;
  return Math.floor(Number(match[1]) * multiplier);
}

async function readPrefix(path: string, maxBytes: number): Promise<Uint8Array> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`not a regular file: ${path}`);
  const length = maxBytes > 0 ? Math.min(maxBytes, info.size) : info.size;
  const buffer = Buffer.alloc(length);
  const handle = await open(path, 'r');
  try {
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return new Uint8Array(buffer.buffer, buffer.byteOffset, offset);
  } finally {
    await handle.close();
  }
}

function repeatBytes(data: Uint8Array, count: number): Uint8Array {
  if (count <= 1) return data;
  const output = new Uint8Array(data.length * count);
  for (let i = 0; i < count; i += 1) output.set(data, i * data.length);
  return output;
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function printUsage(): void {
  process.stdout.write(
    'usage: tsx tools/benchmark.ts <stream.ts> [--bytes <size>] [--repeat <n>] [--json]\n' +
      '\n' +
      'Measures probeBuffer wall time, peak RSS and result counts. --repeat multiplies\n' +
      'the sampled buffer in memory, useful for stress testing without a huge file.\n',
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const base = await readPrefix(options.file, options.bytes);
  const data = repeatBytes(base, options.repeat);
  const before = process.memoryUsage();
  const started = performance.now();
  const result: ProbeResult = probeBuffer(data, {
    name: basename(options.file),
    kind: 'file',
    size: data.length,
    full: true,
    toolVersion: 'benchmark',
    textProfile: 'auto',
  });
  const elapsedMs = performance.now() - started;
  const after = process.memoryUsage();
  const maxRss = process.resourceUsage().maxRSS * 1024;
  const report = {
    file: options.file,
    inputBytes: data.length,
    repeat: options.repeat,
    elapsedMs,
    packetsPerSecond:
      result.transport.packetCount > 0
        ? Math.round(result.transport.packetCount / (elapsedMs / 1000))
        : 0,
    packetSize: result.packet.size,
    packets: result.transport.packetCount,
    services: result.services.length,
    pids: result.pids.length,
    tables: result.tables.length,
    events: result.events.length,
    diagnostics: result.diagnostics.length,
    rssBytes: after.rss,
    peakRssBytes: maxRss > 0 ? maxRss : after.rss,
    heapUsedBytes: after.heapUsed,
    rssDeltaBytes: after.rss - before.rss,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      `file            ${report.file}`,
      `input           ${mib(report.inputBytes)}${options.repeat > 1 ? ` (${options.repeat}x)` : ''}`,
      `time            ${(elapsedMs / 1000).toFixed(3)} s (${report.packetsPerSecond.toLocaleString()} packets/s)`,
      `peak RSS        ${mib(report.peakRssBytes)}`,
      `RSS after       ${mib(report.rssBytes)} (${mib(report.rssDeltaBytes)} growth)`,
      `heap used       ${mib(report.heapUsedBytes)}`,
      `packets         ${report.packets.toLocaleString()} x ${report.packetSize} bytes`,
      `result          ${report.services} service(s), ${report.pids} PID(s), ${report.tables} table(s), ${report.events} event(s), ${report.diagnostics} diagnostic(s)`,
      '',
      'targets         150 MB in < 10 s and peak RSS < 512 MiB',
    ].join('\n') + '\n',
  );
}

await main();
