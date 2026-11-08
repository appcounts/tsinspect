/**
 * Hamming 8/4 decoding table from ETSI EN 300 706 (Teletext).
 * Values are data nibbles; 0xff marks an uncorrectable code.
 * The table is indexed by the bit-reversed transmitted byte.
 */
const UNHAM_8_4 = Uint8Array.from(
  (
    '01 ff 01 01 ff 00 01 ff ff 02 01 ff 0a ff ff 07 ' +
    'ff 00 01 ff 00 00 ff 00 06 ff ff 0b ff 00 03 ff ' +
    'ff 0c 01 ff 04 ff ff 07 06 ff ff 07 ff 07 07 07 ' +
    '06 ff ff 05 ff 00 0d ff 06 06 06 ff 06 ff ff 07 ' +
    'ff 02 01 ff 04 ff ff 09 02 02 ff 02 ff 02 03 ff ' +
    '08 ff ff 05 ff 00 03 ff ff 02 03 ff 03 ff 03 03 ' +
    '04 ff ff 05 04 04 04 ff ff 02 0f ff 04 ff ff 07 ' +
    'ff 05 05 05 04 ff ff 05 06 ff ff 05 ff 0e 03 ff ' +
    'ff 0c 01 ff 0a ff ff 09 0a ff ff 0b 0a 0a 0a ff ' +
    '08 ff ff 0b ff 00 0d ff ff 0b 0b 0b 0a ff ff 0b ' +
    '0c 0c ff 0c ff 0c 0d ff ff 0c 0f ff 0a ff ff 07 ' +
    'ff 0c 0d ff 0d ff 0d 0d 06 ff ff 0b ff 0e 0d ff ' +
    '08 ff ff 09 ff 09 09 09 ff 02 0f ff 0a ff ff 09 ' +
    '08 08 08 ff 08 ff ff 09 08 ff ff 0b ff 0e 03 ff ' +
    'ff 0c 0f ff 04 ff ff 09 0f ff 0f 0f ff 0e 0f ff ' +
    '08 ff ff 05 ff 0e 0d ff ff 0e 0f ff 0e 0e ff 0e'
  )
    .trim()
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 16)),
);

/** Reverse the bits of one byte (Teletext transmits data LSB first). */
export function reverse8(value: number): number {
  let result = 0;
  for (let i = 0; i < 8; i += 1) {
    result = (result << 1) | ((value >> i) & 1);
  }
  return result;
}

/** Decode a Hamming 8/4 protected byte to its data nibble. */
export function unham84(value: number): number {
  return UNHAM_8_4[value] as number;
}
