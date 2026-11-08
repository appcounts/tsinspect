export function readU8(data: Uint8Array, offset: number): number {
  return offset >= 0 && offset < data.length ? (data[offset] as number) : 0;
}

export function readU16(data: Uint8Array, offset: number): number {
  return (readU8(data, offset) << 8) | readU8(data, offset + 1);
}

export function readU24(data: Uint8Array, offset: number): number {
  return (readU8(data, offset) << 16) | (readU8(data, offset + 1) << 8) | readU8(data, offset + 2);
}

export function readU32(data: Uint8Array, offset: number): number {
  return (
    readU8(data, offset) * 0x1000000 +
    (readU8(data, offset + 1) << 16) +
    (readU8(data, offset + 2) << 8) +
    readU8(data, offset + 3)
  );
}

/** Read a 33-bit PCR base plus 9-bit extension, returned in 27 MHz ticks. */
export function readPcrTicks(data: Uint8Array, offset: number): number {
  const b0 = readU8(data, offset);
  const b1 = readU8(data, offset + 1);
  const b2 = readU8(data, offset + 2);
  const b3 = readU8(data, offset + 3);
  const b4 = readU8(data, offset + 4);
  const b5 = readU8(data, offset + 5);

  const base = b0 * 0x2000000 + (b1 << 17) + (b2 << 9) + (b3 << 1) + (b4 >> 7);
  const ext = ((b4 & 0x01) << 8) | b5;
  return base * 300 + ext;
}

export function hex(data: Uint8Array, start = 0, end = data.length, limit = 64): string {
  const from = Math.max(0, start);
  const to = Math.min(data.length, end, from + limit);
  let out = '';
  for (let i = from; i < to; i += 1) {
    if (out.length > 0) out += ' ';
    out += (data[i] as number).toString(16).padStart(2, '0').toUpperCase();
  }
  if (to < Math.min(data.length, end)) out += ' …';
  return out;
}

export function hex16(value: number): string {
  return `0x${(value & 0xffff).toString(16).padStart(4, '0').toUpperCase()}`;
}

export function pad(value: number, width: number): string {
  return value.toString().padStart(width, '0');
}

/** Human-readable byte count, using binary units. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'n/a';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatBitrate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return 'n/a';
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)} Mb/s`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(1)} kb/s`;
  return `${bps.toFixed(0)} b/s`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'n/a';
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)} ms`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m ${s.toFixed(2).padStart(5, '0')}s`;
  if (m > 0) return `${m}m ${s.toFixed(2).padStart(5, '0')}s`;
  return `${s.toFixed(2)} s`;
}
