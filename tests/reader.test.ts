import { describe, expect, it } from 'vitest';
import { detectPacketLayout, parseTsPacket, scanPackets } from '@tsinspect/core';
import { buildPacket, concat } from './helpers.js';

function packets(options: { prefixLength?: number; trailerLength?: number }, count = 12): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(
      buildPacket(0x0100, new Uint8Array(184).fill(i & 0xff), {
        cc: i & 0x0f,
        ...options,
      }),
    );
  }
  return out;
}

describe('packet layout detection', () => {
  it('detects 188-byte packets', () => {
    const layout = detectPacketLayout(concat(packets({})));
    expect(layout).not.toBeNull();
    expect(layout?.packetSize).toBe(188);
    expect(layout?.syncOffset).toBe(0);
    expect(layout?.format).toBe('ts');
  });

  it('detects 192-byte M2TS packets', () => {
    const layout = detectPacketLayout(concat(packets({ prefixLength: 4 })));
    expect(layout).not.toBeNull();
    expect(layout?.packetSize).toBe(192);
    expect(layout?.syncOffset).toBe(4);
    expect(layout?.format).toBe('m2ts');
  });

  it('detects 204-byte ISDB-Tb packets', () => {
    const layout = detectPacketLayout(concat(packets({ trailerLength: 16 })));
    expect(layout).not.toBeNull();
    expect(layout?.packetSize).toBe(204);
    expect(layout?.syncOffset).toBe(0);
    expect(layout?.format).toBe('isdb-tb');
  });

  it('finds the first packet after leading garbage', () => {
    const garbage = new Uint8Array(37).fill(0x00);
    const layout = detectPacketLayout(concat([garbage, ...packets({})]));
    expect(layout?.firstPacketOffset).toBe(37);
  });

  it('returns null for random data', () => {
    expect(detectPacketLayout(new Uint8Array(4096).fill(0xaa))).toBeNull();
  });
});

describe('adaptation field', () => {
  it('decodes private-data and extension flags from the correct bits', () => {
    const layout = detectPacketLayout(concat(packets({})));
    expect(layout).not.toBeNull();
    const pcrPacket = buildPacket(0x0100, new Uint8Array(0), { pcrTicks: 27_000_000 });

    const withPcr = parseTsPacket(pcrPacket, 0, layout!, 0);
    expect(withPcr?.adaptation?.pcr?.ticks).toBe(27_000_000);
    expect(withPcr?.adaptation?.hasPrivateData).toBe(false);
    expect(withPcr?.adaptation?.hasExtension).toBe(false);

    const flagged = pcrPacket.slice();
    flagged[5] = 0x03; // transport_private_data_flag + adaptation_field_extension_flag
    const parsed = parseTsPacket(flagged, 0, layout!, 0);
    expect(parsed?.adaptation?.hasPrivateData).toBe(true);
    expect(parsed?.adaptation?.hasExtension).toBe(true);
    expect(parsed?.adaptation?.pcr).toBeUndefined();
  });
});

describe('packet scan', () => {
  it('resynchronises after a corrupt packet', () => {
    const parts = packets({});
    parts[5] = new Uint8Array(188).fill(0x00);
    let syncLosses = 0;
    const scanned = [
      ...scanPackets(concat(parts), {
        packetSize: 188,
        syncOffset: 0,
        format: 'ts',
        firstPacketOffset: 0,
      }, { onSyncLoss: () => { syncLosses += 1; } }),
    ];
    expect(syncLosses).toBeGreaterThan(0);
    expect(scanned.length).toBe(11);
    expect(scanned.at(-1)?.pid).toBe(0x0100);
  });
});
