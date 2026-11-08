import { describe, expect, it } from 'vitest';
import { probeBuffer } from '@tsinspect/core';
import { buildSection, concat, packetizeSection, patBody, sdtBody } from './helpers.js';

describe('probeBuffer resource limits', () => {
  it(
    'caps the table index and reports a diagnostic',
    () => {
      const packets = packetizeSection(
        0x0000,
        buildSection(0x00, patBody([{ programNumber: 1, pid: 0x1000 }]), {
          tableIdExtension: 1,
        }),
      );
      // Each unique original_network_id produces a distinct table index entry.
      for (let networkId = 0; networkId < 8_300; networkId += 1) {
        packets.push(
          ...packetizeSection(
            0x0011,
            buildSection(0x42, sdtBody(networkId, []), {
              tableIdExtension: networkId,
            }),
          ),
        );
      }
      const data = concat(packets);
      const result = probeBuffer(data, { name: 'limits.ts', kind: 'buffer' });
      expect(result.tables.length).toBeLessThanOrEqual(8_192);
      expect(result.diagnostics.some((item) => item.code === 'TABLE_INDEX_LIMIT')).toBe(true);
    },
    20_000,
  );
});
