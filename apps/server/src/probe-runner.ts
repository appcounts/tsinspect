import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sea from 'node:sea';
import { Worker } from 'node:worker_threads';
import { inflateSync } from 'node:zlib';
import {
  probeBuffer,
  type ProbeOptions,
  type ProbeProgress,
  type ProbeResult,
} from '@tsinspect/core';
import { abortError } from './abort.js';

export interface ProbeJob {
  result: ProbeResult;
  /** Buffer owned by the session; detached from the worker after analysis. */
  data: Uint8Array;
  /** False when the probe had to run on the main thread (no worker available). */
  cancelable: boolean;
}

export interface RunProbeHooks {
  signal?: AbortSignal;
  onProgress?: (progress: ProbeProgress & { cancelable: boolean }) => void;
}

interface WorkerData {
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
  options: ProbeOptions;
}

let cachedWorkerCode: string | undefined;

/**
 * Locate the compiled probe worker. The packaged CLI ships a sibling
 * `probe-worker.cjs`; the Windows SEA executable embeds it as an asset. When
 * neither exists (running from TypeScript sources), bundle it once with the
 * esbuild dev dependency. Returns undefined when no worker can be produced;
 * callers then fall back to a synchronous probe.
 */
async function loadWorkerCode(): Promise<string | undefined> {
  if (cachedWorkerCode) return cachedWorkerCode;
  if (sea.isSea()) {
    try {
      const asset = sea.getAsset('worker/probe-worker.cjs', 'utf8');
      if (typeof asset === 'string' && asset.length > 0) {
        cachedWorkerCode = asset;
        return cachedWorkerCode;
      }
    } catch {
      // Asset missing (older executable); fall through to the other strategies.
    }
  }
  const script = process.argv[1];
  if (script) {
    const candidate = join(dirname(script), 'probe-worker.cjs');
    if (existsSync(candidate)) {
      cachedWorkerCode = readFileSync(candidate, 'utf8');
      return cachedWorkerCode;
    }
  }
  const entry = join(process.cwd(), 'apps/server/src/probe-worker.ts');
  if (!existsSync(entry)) return undefined;
  try {
    const { build } = await import('esbuild');
    const output = await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      write: false,
      logLevel: 'silent',
    });
    const text = output.outputFiles?.[0]?.text;
    if (text) {
      cachedWorkerCode = text;
      return cachedWorkerCode;
    }
  } catch {
    // esbuild is a dev dependency; without it we keep the synchronous path.
  }
  return undefined;
}

/**
 * Transferring detaches the buffer from this thread, so only hand it over when
 * it is the whole (dedicated) allocation. Small buffers are copied because
 * Node's allocator may have carved them out of its shared pool.
 */
function transferable(
  data: Uint8Array,
): { buffer: ArrayBuffer; byteOffset: number; byteLength: number } | undefined {
  if (!(data.buffer instanceof ArrayBuffer)) return undefined;
  if (
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength &&
    data.byteLength > 8 * 1024
  ) {
    return { buffer: data.buffer, byteOffset: 0, byteLength: data.byteLength };
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return { buffer: copy.buffer, byteOffset: 0, byteLength: copy.byteLength };
}

function probeInThread(
  data: Uint8Array,
  options: ProbeOptions,
  hooks: RunProbeHooks,
): ProbeJob {
  const result = probeBuffer(data, {
    ...options,
    inflate: (payload) => new Uint8Array(inflateSync(payload)),
    onProgress: (progress) => hooks.onProgress?.({ ...progress, cancelable: false }),
  });
  return { result, data, cancelable: false };
}

export async function runProbeJob(
  data: Uint8Array,
  options: ProbeOptions,
  hooks: RunProbeHooks = {},
): Promise<ProbeJob> {
  const code = await loadWorkerCode();
  const transfer = code ? transferable(data) : undefined;
  if (!code || !transfer) {
    if (hooks.signal?.aborted) throw abortError();
    return probeInThread(data, options, hooks);
  }
  const workerData: WorkerData = { ...transfer, options };

  return new Promise<ProbeJob>((resolve, reject) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(code, {
        eval: true,
        workerData,
        transferList: [workerData.buffer],
      });
    } catch {
      if (hooks.signal?.aborted) {
        reject(abortError());
        return;
      }
      if (data.byteLength === 0) {
        reject(new Error('probe worker failed to start'));
        return;
      }
      resolve(probeInThread(data, options, hooks));
      return;
    }

    const cleanup = (): void => {
      hooks.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      reject(error);
    };
    const onAbort = (): void => fail(abortError());
    hooks.signal?.addEventListener('abort', onAbort, { once: true });
    if (hooks.signal?.aborted) {
      onAbort();
      return;
    }

    worker.on('message', (message: {
      type?: string;
      progress?: ProbeProgress;
      result?: ProbeResult;
      buffer?: ArrayBuffer;
      byteOffset?: number;
      byteLength?: number;
      error?: string;
    }) => {
      if (message.type === 'progress' && message.progress) {
        hooks.onProgress?.({ ...message.progress, cancelable: true });
        return;
      }
      if (message.type === 'result' && message.result && message.buffer) {
        if (settled) return;
        settled = true;
        cleanup();
        void worker.terminate();
        resolve({
          result: message.result,
          data: new Uint8Array(
            message.buffer,
            message.byteOffset ?? 0,
            message.byteLength ?? message.buffer.byteLength,
          ),
          cancelable: true,
        });
        return;
      }
      if (message.type === 'error') {
        fail(new Error(message.error ?? 'probe worker failed'));
      }
    });
    worker.on('error', (error) => fail(error));
    worker.on('exit', (code2) => {
      if (!settled) fail(new Error(`probe worker exited with code ${code2}`));
    });
  });
}
