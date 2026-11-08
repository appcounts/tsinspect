const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = (i << 24) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc & 0x80000000) !== 0 ? (crc << 1) ^ 0x04c11db7 : crc << 1) >>> 0;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

/**
 * CRC-32/MPEG-2, as used by PSI/SI sections.
 * The check value for the ASCII string "123456789" is 0x0376E6E7.
 */
export function crc32Mpeg2(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffffffff;
  const from = Math.max(0, start);
  const to = Math.min(data.length, end);
  for (let i = from; i < to; i += 1) {
    crc = (((crc << 8) >>> 0) ^ TABLE[((crc >>> 24) ^ (data[i] as number)) & 0xff]!) >>> 0;
  }
  return crc >>> 0;
}

/** A section with a valid appended CRC leaves a remainder of zero. */
export function isSectionCrcValid(data: Uint8Array): boolean {
  return data.length >= 4 && crc32Mpeg2(data) === 0;
}
