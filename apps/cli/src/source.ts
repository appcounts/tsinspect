import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { SourceKind } from '@tsinspect/core';

export interface LoadedSource {
  data: Uint8Array;
  kind: SourceKind;
  name: string;
  size?: number;
}

export interface LoadSourceOptions {
  /** 0 means read the whole source. */
  maxBytes: number;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export async function loadSource(input: string, options: LoadSourceOptions): Promise<LoadedSource> {
  if (isHttpUrl(input)) return loadHttp(input, options.maxBytes);
  return loadFile(input, options.maxBytes);
}

async function loadFile(path: string, maxBytes: number): Promise<LoadedSource> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);

  const size = info.size;
  const readLength = maxBytes > 0 ? Math.min(maxBytes, size) : size;
  const buffer = Buffer.alloc(readLength);
  const handle = await open(path, 'r');

  try {
    let offset = 0;
    while (offset < readLength) {
      const { bytesRead } = await handle.read(buffer, offset, readLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {
      data: new Uint8Array(buffer.buffer, buffer.byteOffset, offset),
      kind: 'file',
      name: basename(path),
      size,
    };
  } finally {
    await handle.close();
  }
}

async function loadHttp(url: string, maxBytes: number): Promise<LoadedSource> {
  const headers: Record<string, string> = {
    'User-Agent': 'tsinspect/0.0.1 (+https://github.com/)',
  };
  if (maxBytes > 0) headers.Range = `bytes=0-${maxBytes - 1}`;

  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }

  const contentRange = response.headers.get('content-range');
  const total = contentRange ? parseContentRangeTotal(contentRange) : undefined;
  const size =
    total ??
    (response.headers.get('content-length')
      ? Number(response.headers.get('content-length'))
      : undefined);

  if (response.status === 206) {
    const data = new Uint8Array(await response.arrayBuffer());
    return { data, kind: 'url', name: basename(new URL(url).pathname) || url, ...(size !== undefined ? { size } : {}) };
  }

  if (maxBytes === 0) {
    const data = new Uint8Array(await response.arrayBuffer());
    return { data, kind: 'url', name: basename(new URL(url).pathname) || url, ...(size !== undefined ? { size } : {}) };
  }

  if (!response.body) {
    return { data: new Uint8Array(0), kind: 'url', name: url, ...(size !== undefined ? { size } : {}) };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalRead = 0;
  try {
    while (totalRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const take = Math.min(value.length, maxBytes - totalRead);
      chunks.push(value.subarray(0, take));
      totalRead += take;
      if (take < value.length) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const data = new Uint8Array(totalRead);
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
  };
}

function parseContentRangeTotal(value: string): number | undefined {
  const match = /\/(\d+)\s*$/.exec(value);
  return match ? Number(match[1]) : undefined;
}

export function parseByteSize(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid byte size: ${value}`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const multiplier =
    unit === 'gb' || unit === 'gib'
      ? 1024 ** 3
      : unit === 'mb' || unit === 'mib'
        ? 1024 ** 2
        : unit === 'kb' || unit === 'kib'
          ? 1024
          : 1;
  return Math.floor(amount * multiplier);
}
