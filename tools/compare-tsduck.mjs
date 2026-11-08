#!/usr/bin/env node
/**
 * Compare tsinspect's PAT/PMT/SDT/VCT view with TSDuck's `tspsi` output.
 *
 * TSDuck publishes `<stream>.psi.txt` next to each test stream. This script
 * downloads nothing: put both files in `.cache/streams/`.
 *
 * Usage:
 *   node tools/compare-tsduck.mjs atsc-473 isdb-nhk dvb-france-uhf33
 *   node tools/compare-tsduck.mjs --json
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const streamDir = join(root, '.cache', 'streams');
const cli = join(root, 'apps', 'cli', 'dist', 'index.js');

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const ids = args.filter((arg) => !arg.startsWith('-'));
if (ids.length === 0) {
  process.stderr.write('usage: node tools/compare-tsduck.mjs <stream-id> [...]\n');
  process.exit(2);
}

if (!existsSync(cli)) {
  process.stderr.write(`missing ${cli}; run "corepack pnpm build" first\n`);
  process.exit(2);
}

let failures = 0;
const reports = [];

for (const id of ids) {
  const tsFile = join(streamDir, `${id}.head.ts`);
  const psiFile = join(streamDir, `${id}.psi.txt`);
  if (!existsSync(tsFile)) {
    fail(`${id}: missing ${tsFile}`);
    continue;
  }
  if (!existsSync(psiFile)) {
    fail(`${id}: missing ${psiFile}`);
    continue;
  }

  const probe = JSON.parse(
    execFileSync(process.execPath, [cli, 'probe', tsFile, '--format', 'json'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    }),
  );
  const expected = parsePsi(readFileSync(psiFile, 'utf8'));
  const report = compare(id, expected, probe);
  reports.push(report);
  if (report.differences.length > 0) failures += 1;
  if (!jsonOutput) printReport(report);
}

if (jsonOutput) process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
process.exit(failures > 0 ? 1 : 0);

function parsePsi(text) {
  const blocks = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\* (.+?), TID (?:0x[0-9A-Fa-f]+ \(\d+\)|\d+ \(0x[0-9A-Fa-f]+\)), PID (?:0x[0-9A-Fa-f]+ \(\d+\)|\d+ \(0x[0-9A-Fa-f]+\))/.exec(line);
    if (header) {
      current = { title: header[1], lines: [] };
      blocks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }

  const result = { tsid: undefined, pat: new Map(), pmts: new Map(), sdt: new Map(), channels: new Map() };

  const pat = findBlock(blocks, 'PAT');
  if (pat) {
    for (const line of pat.lines) {
      const tsid = /^\s*TS id:\s*(\d+)/.exec(line);
      if (tsid) result.tsid = Number(tsid[1]);
      const program =
        /^\s*Program:\s*(?:(\d+)\s*\(0x[0-9A-Fa-f]+\)|0x[0-9A-Fa-f]+\s*\((\d+)\))\s+PID:\s*(?:(\d+)\s*\(0x[0-9A-Fa-f]+\)|0x[0-9A-Fa-f]+\s*\((\d+)\))/.exec(
          line,
        );
      if (program) {
        result.pat.set(
          Number(program[1] ?? program[2]),
          Number(program[3] ?? program[4]),
        );
      }
    }
  }

  for (const block of blocks) {
    if (!block.title.startsWith('PMT')) continue;
    let program;
    let pcrPid;
    const streams = [];
    for (const line of block.lines) {
      const header =
        /^\s*Program:\s*(?:(\d+)\s*\(0x[0-9A-Fa-f]+\)|0x[0-9A-Fa-f]+\s*\((\d+)\)),\s*PCR PID:\s*(?:(\d+)\s*\(0x[0-9A-Fa-f]+\)|0x[0-9A-Fa-f]+\s*\((\d+)\))/.exec(
          line,
        );
      if (header) {
        program = Number(header[1] ?? header[2]);
        pcrPid = Number(header[3] ?? header[4]);
      }
      const stream =
        /^\s*Elementary stream: type 0x([0-9A-Fa-f]+).*?PID:\s*(?:(\d+)\s*\(0x[0-9A-Fa-f]+\)|0x[0-9A-Fa-f]+\s*\((\d+)\))/.exec(
          line,
        );
      if (stream) {
        streams.push({
          streamType: Number.parseInt(stream[1], 16),
          pid: Number(stream[2] ?? stream[3]),
        });
      }
    }
    if (program !== undefined) {
      result.pmts.set(program, { pcrPid, streams, pid: findPid(block.title) });
    }
  }

  for (const block of blocks) {
    if (!block.title.startsWith('SDT')) continue;
    let serviceId;
    for (const line of block.lines) {
      const id =
        /^\s*Service Id:\s*(?:(\d+)\s*\(0x[0-9A-Fa-f]+\)|0x[0-9A-Fa-f]+\s*\((\d+)\))/.exec(
          line,
        );
      if (id) {
        serviceId = Number(id[1] ?? id[2]);
        result.sdt.set(serviceId, {});
        continue;
      }
      if (serviceId === undefined) continue;
      const type = /^\s*Service type:\s*0x([0-9A-Fa-f]+)/.exec(line);
      if (type) result.sdt.get(serviceId).serviceType = Number.parseInt(type[1], 16);
      const name = /^\s*Service:\s*"(.*)",\s*Provider:\s*"(.*)"/.exec(line);
      if (name) {
        result.sdt.get(serviceId).name = name[1];
        result.sdt.get(serviceId).provider = name[2];
      }
    }
  }

  for (const block of blocks) {
    if (!block.title.startsWith('TVCT') && !block.title.startsWith('CVCT')) continue;
    let channel;
    for (const line of block.lines) {
      const header = /^\s*- Channel\s+(\d+)\.(\d+),\s*short name:\s*"(.*)"/.exec(line);
      if (header) {
        channel = { major: Number(header[1]), minor: Number(header[2]), name: header[3] };
        result.channels.set(`${channel.major}.${channel.minor}`, channel);
        continue;
      }
      if (!channel) continue;
      const program = /program number:\s*0x[0-9A-Fa-f]+\s*\((\d+)\)/.exec(line);
      if (program) channel.programNumber = Number(program[1]);
    }
  }

  return result;
}

function findBlock(blocks, prefix) {
  for (const block of blocks) {
    if (
      block.title === prefix ||
      block.title.startsWith(`${prefix} `) ||
      block.title.startsWith(`${prefix},`)
    ) {
      return block;
    }
  }
  return undefined;
}

function findPid(title) {
  const match = /PID (\d+) \(0x[0-9A-Fa-f]+\)/.exec(title);
  return match ? Number(match[1]) : undefined;
}

function compare(id, expected, probe) {
  const differences = [];
  const checks = [];
  const same = (label, actual, wanted) => {
    if (actual === wanted) {
      checks.push({ label, ok: true });
    } else {
      checks.push({ label, ok: false, actual, expected: wanted });
      differences.push(`${label}: expected ${wanted}, got ${actual}`);
    }
  };

  same('transport stream id', probe.transport.tsid, expected.tsid);

  const actualPat = new Map(probe.services.map((service) => [service.programNumber, service.pmtPid]));
  compareMap('PAT program/PID map', expected.pat, actualPat, checks, differences);

  const actualPmts = new Map(
    probe.services.map((service) => [
      service.programNumber,
      {
        pcrPid: service.pcrPid,
        streams: service.streams.map((stream) => ({ streamType: stream.streamType, pid: stream.pid })),
      },
    ]),
  );
  for (const [program, wanted] of expected.pmts) {
    const actual = actualPmts.get(program);
    if (!actual) {
      differences.push(`PMT program ${program}: missing from probe`);
      continue;
    }
    same(`PMT ${program} PCR PID`, actual.pcrPid, wanted.pcrPid);
    const actualStreams = actual.streams
      .map((stream) => `${stream.streamType}:${stream.pid}`)
      .sort()
      .join(',');
    const wantedStreams = wanted.streams
      .map((stream) => `${stream.streamType}:${stream.pid}`)
      .sort()
      .join(',');
    same(`PMT ${program} elementary streams`, actualStreams, wantedStreams);
  }

  if (expected.channels.size > 0) {
    for (const [channel, wanted] of expected.channels) {
      const actual = probe.services.find(
        (service) =>
          `${service.majorChannelNumber}.${service.minorChannelNumber}` === channel,
      );
      if (!actual) {
        differences.push(`VCT channel ${channel}: missing from probe`);
        continue;
      }
      same(`VCT ${channel} program number`, actual.programNumber, wanted.programNumber);
      same(`VCT ${channel} short name`, actual.name?.trim(), wanted.name.trim());
    }
  }

  if (expected.sdt.size > 0) {
    const actual = new Map(probe.services.map((service) => [service.serviceId, service]));
    for (const [serviceId, wanted] of expected.sdt) {
      const found = actual.get(serviceId);
      if (!found) {
        differences.push(`SDT service ${serviceId}: missing from probe`);
        continue;
      }
      same(`SDT ${serviceId} service type`, found.serviceType, wanted.serviceType);
      // TSDuck's text output cannot represent ARIB text; compare ASCII names only.
      if (isAscii(wanted.name) && found.name !== undefined) {
        same(`SDT ${serviceId} name`, found.name.trim(), wanted.name.trim());
      }
    }
  }

  return {
    id,
    standard: probe.standard.detected,
    checks,
    differences,
    ok: differences.length === 0,
  };
}

function compareMap(label, expected, actual, checks, differences) {
  const wanted = [...expected.entries()].sort((a, b) => a[0] - b[0]);
  const got = [...actual.entries()].sort((a, b) => a[0] - b[0]);
  const text = (entries) => entries.map(([key, value]) => `${key}:${value}`).join(',');
  if (text(wanted) === text(got)) {
    checks.push({ label, ok: true });
  } else {
    checks.push({ label, ok: false, actual: text(got), expected: text(wanted) });
    differences.push(`${label}: expected ${text(wanted)}, got ${text(got)}`);
  }
}

function isAscii(value) {
  return value !== undefined && /^[\x20-\x7e]*$/.test(value);
}

function printReport(report) {
  process.stdout.write(`\n${report.id} (${report.standard}): ${report.ok ? 'PASS' : 'FAIL'}\n`);
  for (const check of report.checks) {
    process.stdout.write(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.label}`);
    if (!check.ok) process.stdout.write(` (expected ${check.expected}, got ${check.actual})`);
    process.stdout.write('\n');
  }
  for (const difference of report.differences) {
    process.stdout.write(`  - ${difference}\n`);
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
