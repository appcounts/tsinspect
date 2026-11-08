#!/usr/bin/env node
/**
 * Download test streams listed in streams.json.
 *
 * Usage:
 *   node tools/fetch-streams/fetch.mjs --head 16 atsc-473 isdb-nhk dvb-france-uhf33
 *   node tools/fetch-streams/fetch.mjs --list
 *   node tools/fetch-streams/fetch.mjs --all --head 8
 *
 * --head <MiB>  download only the first N MiB (HTTP Range, default 16)
 * --full        download the whole stream instead
 * --force       overwrite existing files
 */
import { createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const cacheDir = join(root, '.cache', 'streams');
const catalog = JSON.parse(await readFile(join(here, 'streams.json'), 'utf8')).streams;

const args = process.argv.slice(2);
const options = {
  headMiB: 16,
  full: false,
  force: false,
  list: false,
  all: false,
};
const ids = [];

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  switch (arg) {
    case '--head':
      options.headMiB = Number(args[++i]);
      if (!Number.isFinite(options.headMiB) || options.headMiB <= 0) {
        fail('--head expects a positive number of MiB');
      }
      break;
    case '--full':
      options.full = true;
      break;
    case '--force':
      options.force = true;
      break;
    case '--list':
      options.list = true;
      break;
    case '--all':
      options.all = true;
      break;
    case '--help':
    case '-h':
      printHelp();
      process.exit(0);
      break;
    default:
      if (arg.startsWith('-')) fail(`unknown option: ${arg}`);
      ids.push(arg);
      break;
  }
}

if (options.list) {
  for (const [id, stream] of Object.entries(catalog)) {
    process.stdout.write(`${id.padEnd(24)} ${stream.standard.padEnd(10)} ${stream.url}\n`);
  }
  process.exit(0);
}

const selected = options.all ? Object.keys(catalog) : ids;
if (selected.length === 0) {
  printHelp();
  process.exit(1);
}

await mkdir(cacheDir, { recursive: true });

for (const id of selected) {
  const stream = catalog[id];
  if (!stream) fail(`unknown stream: ${id} (use --list)`);
  await fetchStream(id, stream);
  await fetchReferences(id, stream);
}

async function fetchStream(id, stream) {
  const suffix = options.full ? '.ts' : '.head.ts';
  const file = join(cacheDir, id + suffix);

  if (!options.force) {
    try {
      const info = await stat(file);
      if (info.size > 0) {
        process.stdout.write(`skip ${id}: ${file} (${formatBytes(info.size)}) exists\n`);
        return;
      }
    } catch {
      // missing: download
    }
  }

  const limit = options.full ? 0 : Math.floor(options.headMiB * 1024 * 1024);
  process.stdout.write(`fetch ${id}: ${stream.url}${limit ? ` (first ${formatBytes(limit)})` : ''}\n`);

  const headers = { 'User-Agent': 'tsinspect/0.0.1 test fixture fetcher' };
  if (limit > 0) headers.Range = `bytes=0-${limit - 1}`;

  const response = await fetch(stream.url, { headers, redirect: 'follow' });
  if (!response.ok) fail(`HTTP ${response.status} ${response.statusText} for ${stream.url}`);

  const expected = limit > 0 ? limit : Number(response.headers.get('content-length') || 0);
  let written = 0;

  const source = Readable.fromWeb(response.body);
  const sink = createWriteStream(file);
  const limiter =
    limit > 0
      ? async function* (chunks) {
          for await (const chunk of chunks) {
            const take = Math.min(chunk.length, limit - written);
            if (take > 0) {
              written += take;
              yield take < chunk.length ? chunk.subarray(0, take) : chunk;
            }
            if (written >= limit) return;
          }
        }
      : async function* (chunks) {
          for await (const chunk of chunks) {
            written += chunk.length;
            yield chunk;
          }
        };

  try {
    await pipeline(source, limiter, sink);
  } catch (error) {
    fail(`download failed for ${id}: ${error.message}`);
  }

  if (limit > 0 && written < limit && expected > 0) {
    process.stdout.write(`note ${id}: server returned ${formatBytes(written)} (file is smaller than requested)\n`);
  }
  process.stdout.write(`saved ${file} (${formatBytes(written)})\n`);
}

/**
 * TSDuck publishes reference output next to most test streams. Download it
 * when present so `tools/compare-tsduck.mjs` can compare against its own view.
 */
async function fetchReferences(id, stream) {
  const base = stream.url.replace(/\.ts$/, '');
  for (const extension of ['.psi.txt', '.analyze.json']) {
    const file = join(cacheDir, id + extension);
    if (!options.force) {
      try {
        const info = await stat(file);
        if (info.size > 0) {
          process.stdout.write(`skip ${id}${extension}: ${file} exists\n`);
          continue;
        }
      } catch {
        // missing: download
      }
    }

    const url = base + extension;
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'tsinspect/0.0.1 fixture fetcher' },
        redirect: 'follow',
      });
      if (!response.ok) continue;
      const body = Buffer.from(await response.arrayBuffer());
      await writeFile(file, body);
      process.stdout.write(`saved ${file} (${formatBytes(body.length)})\n`);
    } catch {
      // Reference files are optional; a network failure must not fail the fetch.
    }
  }
}

function printHelp() {
  process.stdout.write(`Download TSDuck test streams into .cache/streams.

Usage:
  node tools/fetch-streams/fetch.mjs [options] [stream ...]

Options:
  --head <MiB>  download only the first N MiB (default 16)
  --full        download the whole stream
  --force       overwrite an existing file
  --all         download every stream in streams.json
  --list        list stream ids
  -h, --help    show this help

Examples:
  node tools/fetch-streams/fetch.mjs --head 16 atsc-473 isdb-nhk dvb-france-uhf33
  node tools/fetch-streams/fetch.mjs --all --head 8 --force
`);
}

function fail(message) {
  process.stderr.write(`fetch-streams: ${message}\n`);
  process.exit(1);
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
