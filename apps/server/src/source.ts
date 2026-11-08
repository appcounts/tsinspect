import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { SourceKind } from '@tsinspect/core';
import { abortError, throwIfAborted } from './abort.js';

export interface LoadedSource {
  data: Uint8Array;
  kind: SourceKind;
  name: string;
  size?: number;
  /** True when the requested budget stopped the read before the source ended. */
  truncated: boolean;
}

export interface LoadSourceHooks {
  signal?: AbortSignal;
  /** Called as bytes arrive; totalBytes is the full source size when known. */
  onProgress?: (progress: { receivedBytes: number; totalBytes?: number }) => void;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export async function loadSource(
  input: string,
  maxBytes: number,
  hooks: LoadSourceHooks = {},
): Promise<LoadedSource> {
  if (isHttpUrl(input)) return loadHttp(input, maxBytes, hooks);
  return loadFile(input, maxBytes, hooks);
}

async function loadFile(
  path: string,
  maxBytes: number,
  hooks: LoadSourceHooks,
): Promise<LoadedSource> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
  const readLength = maxBytes > 0 ? Math.min(maxBytes, info.size) : info.size;
  const buffer = Buffer.alloc(readLength);
  const handle = await open(path, 'r');
  try {
    let offset = 0;
    hooks.onProgress?.({ receivedBytes: 0, totalBytes: info.size });
    while (offset < readLength) {
      throwIfAborted(hooks.signal);
      const { bytesRead } = await handle.read(buffer, offset, readLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      hooks.onProgress?.({ receivedBytes: offset, totalBytes: info.size });
    }
    return {
      data: new Uint8Array(buffer.buffer, buffer.byteOffset, offset),
      kind: 'file',
      name: basename(path),
      size: info.size,
      truncated: offset < info.size,
    };
  } finally {
    await handle.close();
  }
}

async function loadHttp(
  url: string,
  maxBytes: number,
  hooks: LoadSourceHooks,
): Promise<LoadedSource> {
  const headers: Record<string, string> = {
    'User-Agent': 'tsinspect/0.0.1 web console',
  };
  if (maxBytes > 0) headers.Range = `bytes=0-${maxBytes - 1}`;
  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    ...(hooks.signal ? { signal: hooks.signal } : {}),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  const contentRange = response.headers.get('content-range');
  const total = contentRange ? Number(/\/(\d+)\s*$/.exec(contentRange)?.[1]) : undefined;
  const size =
    total ??
    (response.headers.get('content-length')
      ? Number(response.headers.get('content-length'))
      : undefined);

  const body = response.body;
  if (!body) {
    const raw = new Uint8Array(await response.arrayBuffer());
    const data = maxBytes > 0 ? raw.subarray(0, maxBytes) : raw;
    hooks.onProgress?.({ receivedBytes: data.length, ...(size !== undefined ? { totalBytes: size } : {}) });
    return {
      data,
      kind: 'url',
      name: basename(new URL(url).pathname) || url,
      ...(size !== undefined ? { size } : {}),
      truncated: maxBytes > 0 && raw.length > maxBytes,
    };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let hitLimit = false;
  try {
    hooks.onProgress?.({ receivedBytes: 0, ...(size !== undefined ? { totalBytes: size } : {}) });
    for (;;) {
      throwIfAborted(hooks.signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes > 0 ? maxBytes - received : Number.POSITIVE_INFINITY;
      if (remaining <= 0) {
        hitLimit = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      const chunk = value.length > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      received += chunk.length;
      hooks.onProgress?.({
        receivedBytes: received,
        ...(size !== undefined ? { totalBytes: size } : {}),
      });
      if (maxBytes > 0 && received >= maxBytes) {
        hitLimit = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (hooks.signal?.aborted) throw abortError();
    throw error;
  } finally {
    reader.releaseLock();
  }

  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    data,
    kind: 'url',
    name: basename(new URL(url).pathname) || url,
    ...(size !== undefined ? { size } : {}),
    truncated: hitLimit && (size === undefined || received < size),
  };
}
