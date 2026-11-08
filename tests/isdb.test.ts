import { describe, expect, it } from 'vitest';
import { parseBit, parseCdt, parseLdt, parseSdtt } from '@tsinspect/core';
import { buildSection, concat, descriptor } from './helpers.js';

function u16(value: number): Uint8Array {
  return Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);
}

describe('ISDB tables', () => {
  it('parses BIT broadcasters and descriptors', () => {
    const broadcasterName = descriptor(0xd8, new TextEncoder().encode('NHK'));
    const body = concat([
      Uint8Array.from([0xf0, 0x00]), // view propriety + empty first descriptor loop
      Uint8Array.from([0x01, 0xf0 | ((broadcasterName.length >> 8) & 0x0f), broadcasterName.length & 0xff]),
      broadcasterName,
    ]);
    const section = buildSection(0xc4, body, { tableIdExtension: 0x7ed0 });

    const bit = parseBit(section);
    expect(bit).not.toBeNull();
    expect(bit?.originalNetworkId).toBe(0x7ed0);
    expect(bit?.broadcastViewPropriety).toBe(true);
    expect(bit?.broadcasters).toHaveLength(1);
    expect(bit?.broadcasters[0]?.broadcasterId).toBe(1);
    expect(bit?.broadcasters[0]?.descriptors[0]?.tag).toBe(0xd8);
    expect(bit?.crcValid).toBe(true);
  });

  it('parses LDT descriptions', () => {
    const description = descriptor(0x40, new TextEncoder().encode('Linked'));
    const body = concat([
      u16(0x7ed0), // transport_stream_id
      u16(0x7ed0), // original_network_id
      u16(0x0001), // description_id
      Uint8Array.from([0xf0 | ((description.length >> 8) & 0x0f), description.length & 0xff]),
      description,
    ]);
    const section = buildSection(0xc7, body, { tableIdExtension: 0x4800 });

    const ldt = parseLdt(section);
    expect(ldt?.originalServiceId).toBe(0x4800);
    expect(ldt?.transportStreamId).toBe(0x7ed0);
    expect(ldt?.descriptions).toHaveLength(1);
    expect(ldt?.descriptions[0]?.descriptionId).toBe(1);
    expect(ldt?.descriptions[0]?.descriptors[0]?.tag).toBe(0x40);
  });

  it('parses the SDTT header and CDT module', () => {
    const sdtt = parseSdtt(
      buildSection(
        0xc3,
        concat([u16(0x7ed0), u16(0x7ed0), u16(0x4800), Uint8Array.from([0x02])]),
        { tableIdExtension: 0x0001 },
      ),
    );
    expect(sdtt?.transportStreamId).toBe(0x7ed0);
    expect(sdtt?.originalNetworkId).toBe(0x7ed0);
    expect(sdtt?.serviceId).toBe(0x4800);
    expect(sdtt?.contentCount).toBe(2);

    const cdt = parseCdt(
      buildSection(0xc8, concat([u16(0x7ed0), Uint8Array.from([0x01, 0xaa, 0xbb])])),
    );
    expect(cdt?.originalNetworkId).toBe(0x7ed0);
    expect(cdt?.dataType).toBe(1);
    expect(cdt?.dataModuleLength).toBe(2);
    expect(cdt?.dataModuleHex).toBe('AA BB');
  });
});
