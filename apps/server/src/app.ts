import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import sea from 'node:sea';
import Fastify from 'fastify';
import {
  collectPesPackets,
  collectScte35Timeline,
  collectSubtitleReport,
  detectPacketLayout,
  hex,
  renderDvbSubtitleFrame,
  type Scte35Timeline,
  type SubtitleReport,
} from '@tsinspect/core';
import { abortError, isAbortError } from './abort.js';
import { resolveSampleBytes } from './config.js';
import { pickFile } from './file-dialog.js';
import { runProbeJob } from './probe-runner.js';
import {
  acquireSession,
  addSession,
  deleteSession,
  getSession,
  listSessions,
  releaseSession,
  type Session,
  type TimelineData,
  type TimelineBucket,
  type TimelinePid,
  type TimelineSubtitleCue,
} from './sessions.js';
import { loadSource } from './source.js';

interface AnalyzeProgress {
  phase: 'loading' | 'probing';
  receivedBytes?: number;
  totalBytes?: number;
  percent?: number;
  pass?: number;
  packets?: number;
  totalPackets?: number;
  cancelable?: boolean;
}

interface AnalyzeHooks {
  signal?: AbortSignal;
  onProgress?: (progress: AnalyzeProgress) => void;
}

/**
 * Load the source and run the probe, forwarding progress. The probe runs in a
 * worker thread so the HTTP server keeps serving requests and an abort can
 * terminate the parsing immediately (releasing the transferred buffer).
 */
async function analyzeSource(
  input: string,
  requestedBytes: unknown,
  hooks: AnalyzeHooks,
): Promise<Session> {
  const maxBytes = resolveSampleBytes(requestedBytes);
  let lastLoadingEmit = 0;
  const loaded = await loadSource(input, maxBytes, {
    ...(hooks.signal ? { signal: hooks.signal } : {}),
    onProgress: ({ receivedBytes, totalBytes }) => {
      const now = Date.now();
      if (
        totalBytes !== undefined &&
        receivedBytes > 0 &&
        receivedBytes < totalBytes &&
        now - lastLoadingEmit < 150
      ) {
        return;
      }
      lastLoadingEmit = now;
      hooks.onProgress?.({
        phase: 'loading',
        receivedBytes,
        ...(totalBytes !== undefined ? { totalBytes } : {}),
        ...(totalBytes !== undefined && totalBytes > 0
          ? { percent: Math.min(100, (receivedBytes / totalBytes) * 100) }
          : {}),
      });
    },
  });
  let lastProbeEmit = 0;
  const job = await runProbeJob(
    loaded.data,
    {
      name: loaded.name,
      kind: loaded.kind,
      ...(loaded.size !== undefined ? { size: loaded.size } : {}),
      full: !loaded.truncated,
      toolVersion: '0.0.1',
      textProfile: 'auto',
    },
    {
      ...(hooks.signal ? { signal: hooks.signal } : {}),
      onProgress: (progress) => {
        const now = Date.now();
        if (progress.packets < progress.totalPackets && now - lastProbeEmit < 100) return;
        lastProbeEmit = now;
        hooks.onProgress?.({
          phase: 'probing',
          pass: progress.pass,
          packets: progress.packets,
          totalPackets: progress.totalPackets,
          receivedBytes: progress.bytes,
          totalBytes: progress.totalBytes,
          percent:
            progress.totalPackets > 0
              ? Math.min(100, (progress.packets / progress.totalPackets) * 100)
              : undefined,
          cancelable: progress.cancelable,
        });
      },
    },
  );
  if (hooks.signal?.aborted) throw abortError();
  const id = randomUUID().slice(0, 8);
  const session: Session = { id, result: job.result, data: job.data, createdAt: Date.now() };
  addSession(session);
  return session;
}

const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

// A request that names a session pins it so idle/budget eviction cannot pull
// the data out from under the handler. The pin is released on response or
// client abort.
const pinned = new WeakMap<object, string>();

app.addHook('onRequest', async (request) => {
  const match = /^\/api\/sessions\/([^/?#]+)/.exec(request.url);
  if (!match) return;
  const id = decodeURIComponent(match[1] as string);
  if (acquireSession(id)) pinned.set(request, id);
});

function releasePin(request: object): void {
  const id = pinned.get(request);
  if (id === undefined) return;
  pinned.delete(request);
  releaseSession(id);
}

app.addHook('onResponse', async (request) => releasePin(request));
app.addHook('onRequestAbort', async (request) => releasePin(request));

/** Directory that holds the built web UI, or undefined when it is embedded in the executable. */
function resolveWebRoot(): string | undefined {
  const candidates = [
    process.env.TSINSPECT_WEB_ROOT,
    join(process.cwd(), 'apps/web/dist'),
    join(process.cwd(), 'web/dist'),
    join(process.cwd(), 'dist'),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return undefined;
}

const webRoot = resolveWebRoot();

function summary(session: Session): Record<string, unknown> {
  const result = session.result;
  return {
    id: session.id,
    source: result.source,
    packet: result.packet,
    standard: result.standard,
    transport: result.transport,
    capabilities: result.capabilities,
    services: result.services.length,
    pids: result.pids.length,
    tables: result.tables.length,
    events: result.events.length,
    diagnostics: result.diagnostics,
    isdb: result.isdb,
    truncated: !result.source.full,
  };
}

function sessionOr404(id: string, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): Session | undefined {
  const session = getSession(id);
  if (!session) {
    reply.code(404).send({ error: 'session not found' });
    return undefined;
  }
  return session;
}

function sessionScte35(session: Session): Scte35Timeline | undefined {
  if (session.scte35) return session.scte35;
  if (!session.result.capabilities.scte35) {
    session.scte35 = { events: [], breaks: [], pids: [], count: 0, truncated: false };
    return session.scte35;
  }
  const layout = detectPacketLayout(session.data);
  if (!layout) return undefined;
  const pids = new Set(
    session.result.services.flatMap((service) =>
      service.streams
        .filter(
          (stream) =>
            stream.streamType === 0x86 ||
            stream.descriptors.some(
              (descriptor) =>
                descriptor.tag === 0x05 && descriptor.fields?.formatIdentifier === 'CUEI',
            ),
        )
        .map((stream) => stream.pid),
    ),
  );
  session.scte35 = collectScte35Timeline(session.data, layout, {
    pids,
    ...(session.result.transport.bitrateBps !== undefined
      ? { bitrateBps: session.result.transport.bitrateBps }
      : {}),
    ...(session.result.transport.durationSec !== undefined
      ? { durationSec: session.result.transport.durationSec }
      : {}),
  });
  return session.scte35;
}

function sessionSubtitles(session: Session): SubtitleReport | undefined {
  if (session.subtitles) return session.subtitles;
  const layout = detectPacketLayout(session.data);
  if (!layout) return undefined;
  session.subtitles = collectSubtitleReport(session.data, layout, session.result);
  return session.subtitles;
}

function buildTimeline(
  session: Session,
  buckets: number,
  top: number,
  includeSubtitles: boolean,
): TimelineData | undefined {
  const layout = detectPacketLayout(session.data);
  if (!layout) return undefined;
  const packetCount = Math.max(
    0,
    Math.floor((session.data.length - layout.firstPacketOffset) / layout.packetSize),
  );
  if (packetCount === 0) {
    return { buckets: [], pids: [] };
  }
  const bucketCount = Math.max(1, Math.min(buckets, packetCount));
  const bucketPackets = new Array<number>(bucketCount).fill(0);
  const bucketBytes = new Array<number>(bucketCount).fill(0);
  const pidSeries = new Map<number, { total: number; series: number[] }>();

  for (let index = 0; index < packetCount; index += 1) {
    const offset = layout.firstPacketOffset + index * layout.packetSize;
    const base = offset + layout.syncOffset;
    if (session.data[base] !== 0x47) continue;
    const pid =
      (((session.data[base + 1] ?? 0) & 0x1f) << 8) |
      (session.data[base + 2] ?? 0);
    const bucket = Math.min(
      bucketCount - 1,
      Math.floor((index * bucketCount) / packetCount),
    );
    bucketPackets[bucket] = (bucketPackets[bucket] ?? 0) + 1;
    bucketBytes[bucket] = (bucketBytes[bucket] ?? 0) + layout.packetSize;
    let entry = pidSeries.get(pid);
    if (!entry) {
      entry = { total: 0, series: new Array<number>(bucketCount).fill(0) };
      pidSeries.set(pid, entry);
    }
    entry.total += 1;
    entry.series[bucket] = (entry.series[bucket] ?? 0) + 1;
  }

  const bitrate = session.result.transport.bitrateBps;
  const duration =
    session.result.transport.durationSec ??
    (bitrate !== undefined && bitrate > 0
      ? (packetCount * layout.packetSize * 8) / bitrate
      : undefined);
  const bucketSec = duration !== undefined && duration > 0 ? duration / bucketCount : undefined;
  const bucketsData: TimelineBucket[] = bucketPackets.map((packets, index) => {
    const bytes = bucketBytes[index] ?? 0;
    return {
      ...(bucketSec !== undefined ? { startSec: index * bucketSec } : {}),
      packets,
      bytes,
      ...(bucketSec !== undefined && bucketSec > 0
        ? { bitrateBps: (bytes * 8) / bucketSec }
        : {}),
    };
  });

  const pidInfo = new Map(session.result.pids.map((pid) => [pid.pid, pid]));
  const pids: TimelinePid[] = [...pidSeries.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, top)
    .map(([pid, entry]) => {
      const info = pidInfo.get(pid);
      return {
        pid,
        pidHex: info?.pidHex ?? `0x${pid.toString(16).padStart(4, '0').toUpperCase()}`,
        ...(info?.kind !== undefined ? { kind: info.kind } : {}),
        packets: entry.total,
        series: entry.series,
      };
    });

  let subtitles: TimelineSubtitleCue[] | undefined;
  let subtitlesTruncated: boolean | undefined;
  if (includeSubtitles) {
    const report = sessionSubtitles(session);
    if (report) {
      const cues: TimelineSubtitleCue[] = [];
      for (const service of report.services) {
        for (const stream of service.streams) {
          for (const cue of stream.cues) {
            cues.push({
              start: cue.start,
              end: cue.end,
              category: stream.category,
              format: stream.format,
              pidHex: stream.pidHex,
              ...(cue.label !== undefined ? { label: cue.label } : {}),
              text: cue.text.slice(0, 120),
            });
            if (cues.length >= 500) {
              subtitlesTruncated = true;
              break;
            }
          }
          if (cues.length >= 500) break;
        }
        if (cues.length >= 500) break;
      }
      if (cues.length > 0) {
        // Subtitle cue times are absolute PTS; the timeline chart starts at
        // zero. Normalise them against the first sampled cue.
        const base = Math.min(...cues.map((cue) => cue.start));
        for (const cue of cues) {
          cue.start = Math.max(0, cue.start - base);
          cue.end = Math.max(cue.start, cue.end - base);
        }
      }
      subtitles = cues;
      subtitlesTruncated ??= false;
    }
  }

  return {
    ...(duration !== undefined ? { durationSec: duration } : {}),
    ...(bitrate !== undefined ? { bitrateBps: bitrate } : {}),
    ...(bucketSec !== undefined ? { bucketSec } : {}),
    buckets: bucketsData,
    pids,
    ...(subtitles !== undefined ? { subtitles } : {}),
    ...(subtitlesTruncated !== undefined ? { subtitlesTruncated } : {}),
  };
}

app.post('/api/sessions', async (request, reply) => {
  const body = (request.body ?? {}) as { source?: string; bytes?: number };
  if (typeof body.source !== 'string' || body.source.trim().length === 0) {
    return reply.code(400).send({ error: 'source is required' });
  }
  const source = body.source.trim();
  const stream = (request.query as { stream?: string } | undefined)?.stream === '1';
  if (!stream) {
    try {
      const session = await analyzeSource(source, body.bytes, {});
      return { id: session.id, summary: summary(session) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ error: message });
    }
  }

  // Streaming mode: the response is newline-delimited JSON with loading and
  // probing progress lines followed by a single result or error line. Closing
  // the request aborts the download and terminates the probe worker.
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  });
  let finished = false;
  let created: Session | undefined;
  const controller = new AbortController();
  const write = (payload: unknown): void => {
    if (finished || response.writableEnded || response.destroyed) return;
    response.write(`${JSON.stringify(payload)}\n`);
  };
  response.on('close', () => {
    if (finished) return;
    finished = true;
    controller.abort();
    // No session exists while the analysis runs; drop one created in the short
    // window between the probe finishing and the result line being written.
    if (created) deleteSession(created.id);
  });
  try {
    created = await analyzeSource(source, body.bytes, {
      signal: controller.signal,
      onProgress: (progress) => write({ type: 'progress', ...progress }),
    });
    // The client may have disconnected after the abort check inside
    // analyzeSource; in that case the session would otherwise linger.
    if (finished) {
      deleteSession(created.id);
      return;
    }
    write({ type: 'result', id: created.id, summary: summary(created) });
  } catch (error) {
    if (!finished && !isAbortError(error)) {
      write({ type: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    finished = true;
    if (!response.writableEnded) response.end();
  }
});

app.get('/api/sessions', async () => ({
  sessions: listSessions().map((session) => summary(session)),
}));

app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
  if (!deleteSession(request.params.id)) {
    return reply.code(404).send({ error: 'session not found' });
  }
  return { deleted: request.params.id };
});

app.post('/api/system/pick-file', async (_request, reply) => {
  try {
    return { path: await pickFile() };
  } catch (error) {
    return reply.code(500).send({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
  const session = sessionOr404(request.params.id, reply);
  if (!session) return;
  return { id: session.id, summary: summary(session), result: session.result };
});

app.get<{ Params: { id: string } }>('/api/sessions/:id/services', async (request, reply) => {
  const session = sessionOr404(request.params.id, reply);
  if (!session) return;
  return { services: session.result.services, capabilities: session.result.capabilities };
});

app.get<{ Params: { id: string } }>('/api/sessions/:id/pids', async (request, reply) => {
  const session = sessionOr404(request.params.id, reply);
  if (!session) return;
  return { pids: session.result.pids };
});

app.get<{ Params: { id: string } }>('/api/sessions/:id/tables', async (request, reply) => {
  const session = sessionOr404(request.params.id, reply);
  if (!session) return;
  return { tables: session.result.tables };
});

app.get<{ Params: { id: string } }>('/api/sessions/:id/epg', async (request, reply) => {
  const session = sessionOr404(request.params.id, reply);
  if (!session) return;
  return { events: session.result.events, clock: session.result.clock };
});

app.get<{ Params: { id: string }; Querystring: { strict?: string } }>(
  '/api/sessions/:id/validation',
  async (request, reply) => {
    const session = sessionOr404(request.params.id, reply);
    if (!session) return;
    const strict = request.query.strict === '1' || request.query.strict === 'true';
    const diagnostics = session.result.diagnostics;
    const errors = diagnostics.filter((item) => item.severity === 'error').length;
    const warnings = diagnostics.filter((item) => item.severity === 'warning').length;
    const infos = diagnostics.filter((item) => item.severity === 'info').length;
    const status = errors > 0 ? 'FAIL' : warnings > 0 && strict ? 'FAIL' : warnings > 0 ? 'WARN' : 'PASS';
    return {
      summary: {
        errors,
        warnings,
        infos,
        strict,
        ok: errors === 0 && (!strict || warnings === 0),
        status,
      },
      diagnostics,
    };
  },
);

app.get<{
  Params: { id: string };
  Querystring: { buckets?: string; top?: string; subtitles?: string };
}>('/api/sessions/:id/timeline', async (request, reply) => {
  const session = sessionOr404(request.params.id, reply);
  if (!session) return;
  const buckets = Math.max(
    10,
    Math.min(600, Number.parseInt(request.query.buckets ?? '120', 10) || 120),
  );
  const top = Math.max(
    1,
    Math.min(32, Number.parseInt(request.query.top ?? '10', 10) || 10),
  );
  const includeSubtitles = request.query.subtitles === '1';
  const key = `${buckets}:${top}:${includeSubtitles ? 1 : 0}`;
  session.timeline ??= new Map();
  let timeline = session.timeline.get(key);
  if (!timeline) {
    timeline = buildTimeline(session, buckets, top, includeSubtitles);
    if (!timeline) {
      return reply.code(422).send({ error: 'no MPEG-TS sync pattern in session data' });
    }
    session.timeline.set(key, timeline);
  }
  return timeline;
});

app.get<{ Params: { id: string } }>('/api/sessions/:id/scte35', async (request, reply) => {
  const session = sessionOr404(request.params.id, reply);
  if (!session) return;
  const timeline = sessionScte35(session);
  if (!timeline) return reply.code(422).send({ error: 'no MPEG-TS sync pattern in session data' });
  return timeline;
});

app.get<{ Params: { id: string } }>('/api/sessions/:id/subtitles', async (request, reply) => {
  const session = sessionOr404(request.params.id, reply);
  if (!session) return;
  const report = sessionSubtitles(session);
  if (!report) return reply.code(422).send({ error: 'no MPEG-TS sync pattern in session data' });
  return report;
});

app.get<{
  Params: { id: string };
  Querystring: { pid?: string; time?: string };
}>('/api/sessions/:id/subtitles/frame', async (request, reply) => {
  const session = sessionOr404(request.params.id, reply);
  if (!session) return;
  const rawPid = request.query.pid ?? '';
  const pid = rawPid.startsWith('0x')
    ? Number.parseInt(rawPid.slice(2), 16)
    : Number.parseInt(rawPid, 10);
  const timeSec = Number.parseFloat(request.query.time ?? '');
  if (!Number.isFinite(pid) || !Number.isFinite(timeSec)) {
    return reply.code(400).send({ error: 'pid and time are required' });
  }
  const layout = detectPacketLayout(session.data);
  if (!layout) return reply.code(422).send({ error: 'no MPEG-TS sync pattern in session data' });

  let packets = session.dvbPes?.get(pid);
  if (!packets) {
    packets = collectPesPackets(session.data, layout, new Set([pid]));
    session.dvbPes ??= new Map();
    session.dvbPes.set(pid, packets);
  }
  const frame = renderDvbSubtitleFrame(packets, timeSec);
  if (!frame) return { frame: null };
  return {
    frame: {
      width: frame.width,
      height: frame.height,
      window: frame.window,
      regions: frame.regions.map((region) => ({
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
        palette: Buffer.from(region.palette).toString('base64'),
        pixels: Buffer.from(region.pixels).toString('base64'),
      })),
    },
  };
});

app.get<{ Params: { id: string }; Querystring: { offset?: string; length?: string } }>(
  '/api/sessions/:id/hex',
  async (request, reply) => {
    const session = sessionOr404(request.params.id, reply);
    if (!session) return;
    const offset = Math.max(0, Number.parseInt(request.query.offset ?? '0', 10) || 0);
    const length = Math.min(8192, Math.max(1, Number.parseInt(request.query.length ?? '256', 10) || 256));
    const end = Math.min(session.data.length, offset + length);
    const bytes = session.data.subarray(offset, end);
    return {
      offset,
      length: bytes.length,
      hex: hex(bytes, 0, bytes.length, bytes.length),
      ascii: Array.from(bytes)
        .map((value) => (value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : '.'))
        .join(''),
      size: session.data.length,
    };
  },
);

app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
  '/api/sessions/:id/export',
  async (request, reply) => {
    const session = sessionOr404(request.params.id, reply);
    if (!session) return;
    if (request.query.format === 'html') {
      const json = JSON.stringify(session.result, null, 2)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
      return reply
        .type('text/html; charset=utf-8')
        .header('content-disposition', `attachment; filename="${session.result.source.name}.report.html"`)
        .send(`<!doctype html><html><head><meta charset="utf-8"><title>tsinspect report</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem;background:#fff;color:#1b1b1f}pre{background:#f4f4f8;padding:1rem;border-radius:8px;overflow:auto}</style></head>
<body><h1>${session.result.source.name}</h1><p>tsinspect ${session.result.tool.version} · ${session.result.standard.detected}</p><pre>${json}</pre></body></html>`);
    }
    return reply
      .type('application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="${session.result.source.name}.json"`)
      .send(JSON.stringify(session.result, null, 2));
  },
);

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  ico: 'image/x-icon',
  map: 'application/json; charset=utf-8',
};

app.get('/*', async (request, reply) => {
  const relative = ((request.params as Record<string, string>)['*'] ?? '').replace(/^\/+/, '');
  const path = relative.length === 0 ? 'index.html' : relative;
  if (path.includes('..')) return reply.code(404).send({ error: 'not found' });
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  const contentType = MIME[extension] ?? 'application/octet-stream';

  if (sea.isSea()) {
    try {
      const body = sea.getAsset(`web/${path}`) as ArrayBuffer;
      return reply.type(contentType).send(Buffer.from(body));
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  }

  if (!webRoot) return reply.code(404).send({ error: 'web UI assets not found' });
  try {
    const body = await readFile(join(webRoot, path));
    return reply.type(contentType).send(body);
  } catch {
    return reply.code(404).send({ error: 'not found' });
  }
});

export interface StartServerOptions {
  /** Preferred port. The next free port is used when it is occupied. */
  port?: number;
  /** Listen address (default 127.0.0.1). */
  host?: string;
  /** Try following ports when the preferred one is busy (default true for port 5173). */
  findFreePort?: boolean;
}

export interface StartedServer {
  host: string;
  port: number;
  url: string;
}

function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, host);
  });
}

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const preferredPort = options.port ?? Number(process.env.PORT ?? 5173);
  const findFreePort = options.findFreePort ?? options.port === undefined;

  let port = preferredPort;
  if (findFreePort) {
    const limit = preferredPort + 50;
    while (port < limit && !(await isPortFree(host, port))) port += 1;
    if (port >= limit) throw new Error(`No free port found between ${preferredPort} and ${limit - 1}.`);
  }

  await app.listen({ port, host });
  return { host, port, url: `http://${host}:${port}` };
}
