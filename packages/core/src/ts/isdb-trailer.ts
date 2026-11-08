/**
 * ISDB-T information block in a 204-byte packet trailer (ARIB STD-B31, 5.5.2).
 *
 * Wire layout of the first four bytes, MSB first:
 *   TMCC identifier (2) | emergency broadcast flag (1) | buffer reset (1)
 *   frame indicator (1) | initialization timing head (1) | frame head (1)
 *   reserved (1) | layer indicator (4) | count-down index (4)
 *   AC data invalid (1) | AC data effective bytes (2) | TSP counter (13)
 *
 * The final four bytes are the optional AC data. The remaining eight bytes of
 * the 16-byte trailer are Reed-Solomon parity.
 */

export interface IsdbTrailer {
  tmccIdentifier: number;
  emergencyControlFlag: boolean;
  bufferResetControl: boolean;
  frameIndicator: boolean;
  initializationTimingHead: boolean;
  frameHead: boolean;
  layerIndicator: number;
  countDownIndex: number;
  acDataInvalid: boolean;
  acDataEffectiveBytes: number;
  tspCounter: number;
  acData?: number;
  /** Layer 0x8 marks the ISDB Information Packet (IIP), not sent on air. */
  iip: boolean;
}

function readBits(data: Uint8Array, bitOffset: number, bitCount: number): number {
  let value = 0;
  for (let i = 0; i < bitCount; i += 1) {
    const position = bitOffset + i;
    const byte = data[position >> 3] as number;
    value = (value << 1) | ((byte >> (7 - (position & 7))) & 0x01);
  }
  return value >>> 0;
}

export function parseIsdbTrailer(data: Uint8Array): IsdbTrailer | null {
  if (data.length < 4) return null;

  const acDataInvalid = readBits(data, 16, 1) !== 0;
  const layerIndicator = readBits(data, 8, 4);
  return {
    tmccIdentifier: readBits(data, 0, 2),
    emergencyControlFlag: readBits(data, 2, 1) !== 0,
    bufferResetControl: readBits(data, 3, 1) !== 0,
    frameIndicator: readBits(data, 4, 1) !== 0,
    initializationTimingHead: readBits(data, 5, 1) !== 0,
    frameHead: readBits(data, 6, 1) !== 0,
    layerIndicator,
    countDownIndex: readBits(data, 12, 4),
    acDataInvalid,
    acDataEffectiveBytes: readBits(data, 17, 2),
    tspCounter: readBits(data, 19, 13),
    ...(acDataInvalid || data.length < 8
      ? {}
      : {
          acData:
            ((data[4] as number) << 24) |
            ((data[5] as number) << 16) |
            ((data[6] as number) << 8) |
            (data[7] as number),
        }),
    iip: layerIndicator === 0x08,
  };
}
