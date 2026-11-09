import {
  descriptorName,
  parseEmergencyInformationDescriptor,
  parseEwsSection,
  parseScte18Eas,
  probeBuffer,
} from '@tsinspect/core';
import { describe, expect, it } from 'vitest';
import {
  atscMss,
  buildPacket,
  buildSection,
  concat,
  descriptor,
  packetizeSection,
  patBody,
  pmtBody,
} from './helpers.js';

function u16(value: number): Uint8Array {
  return Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);
}

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function mssField(text: string, lengthBytes: 1 | 2 = 1): Uint8Array {
  const mss = atscMss(text);
  return concat([lengthBytes === 1 ? Uint8Array.from([mss.length]) : u16(mss.length), mss]);
}

function easBody(locations: Array<[number, number]> = [[0x30, 0x201]]): Uint8Array {
  return concat([
    Uint8Array.from([0]), // protocol_version
    u16(0x1234), // EAS_event_ID
    ascii('PEP'), // EAS_originator_code
    Uint8Array.from([3]),
    ascii('TOR'), // EAS_event_code
    mssField('Tornado Warning'), // nature_of_activation_text
    Uint8Array.from([44]), // 44 seconds remaining (uint8)
    u16(0), // event start time (not set)
    u16(0),
    u16(0x0258), // event duration 600 s
    Uint8Array.from([0x00, 0x05]), // reserved + alert_priority 5
    u16(0xffff), // details_OOB_source_ID
    u16(5), // details major channel
    u16(1), // details minor channel
    u16(0xffff), // audio_OOB_source_ID
    mssField('A tornado warning has been issued.', 2), // alert_text
    Uint8Array.from([
      locations.length,
      ...locations.flatMap(([state, county]) => [state, (county >> 8) & 0xff, county & 0xff]),
    ]),
    Uint8Array.from([0]), // no exceptions
    u16(0), // no descriptors
  ]);
}

function eitBody(events: Array<{ eventId: number; descriptors: Uint8Array }>): Uint8Array {
  const head = concat([
    u16(1), // transport_stream_id
    u16(1), // original_network_id
    Uint8Array.from([0]), // segment_last_section_number
    Uint8Array.from([0x4e]), // last_table_id
  ]);
  const parts: Uint8Array[] = [];
  for (const event of events) {
    const length = event.descriptors.length;
    parts.push(
      concat([
        u16(event.eventId),
        new Uint8Array(5).fill(0xff), // start time not defined
        new Uint8Array(3), // duration 0
        Uint8Array.from([
          0x80 | ((length >> 8) & 0x0f), // running_status 4 + descriptor length
          length & 0xff,
        ]),
        event.descriptors,
      ]),
    );
  }
  return concat([head, ...parts]);
}

function ewbsDescriptorBody(): Uint8Array {
  return concat([
    u16(1), // service_id
    Uint8Array.from([0xc0]), // started = 1, signal_level = 1
    Uint8Array.from([4]), // area_code_length
    u16((0x123 << 4) | 0x0f),
    u16((0x456 << 4) | 0x0f),
  ]);
}

function buildEmergencyStream(): Uint8Array {
  const pat = buildSection(0x00, patBody([{ programNumber: 1, pid: 0x1000 }]), {
    tableIdExtension: 0x0001,
  });
  const pmt = buildSection(
    0x02,
    pmtBody(0x0100, [
      {
        streamType: 0x1b,
        pid: 0x0100,
        descriptors: descriptor(0xfc, ewbsDescriptorBody()),
      },
    ]),
    { tableIdExtension: 1 },
  );
  const eas = buildSection(0xd8, easBody(), { tableIdExtension: 0 });

  return concat([
    ...packetizeSection(0x0000, pat, 0),
    ...packetizeSection(0x1000, pmt, 0),
    ...packetizeSection(0x1ffb, eas, 0),
    buildPacket(0x0100, new Uint8Array(184).fill(0xaa), { cc: 0 }),
    buildPacket(0x0100, new Uint8Array(184).fill(0xbb), { cc: 1 }),
    buildPacket(0x0100, new Uint8Array(184).fill(0xcc), { cc: 2 }),
  ]);
}

describe('emergency alerting', () => {
  it('parses an SCTE 18 EAS section', () => {
    const eas = parseScte18Eas(buildSection(0xd8, easBody(), { tableIdExtension: 0 }));

    expect(eas).not.toBeNull();
    expect(eas?.eventId).toBe(0x1234);
    expect(eas?.originatorCode).toBe('PEP');
    expect(eas?.eventCode).toBe('TOR');
    expect(eas?.priority).toBe(5);
    expect(eas?.timeRemainingSec).toBe(44);
    expect(eas?.durationSec).toBe(600);
    expect(eas?.natureOfActivation).toBe('Tornado Warning');
    expect(eas?.alertText).toBe('A tornado warning has been issued.');
    expect(eas?.locations).toEqual([{ stateCode: 0x30, countySubdivision: 0, countyCode: 0x201 }]);
    expect(eas?.crcValid).toBe(true);
  });

  it('parses the ISDB emergency information descriptor', () => {
    expect(descriptorName(0xfc)).toBe('ISDB emergency information');
    expect(parseEmergencyInformationDescriptor(ewbsDescriptorBody())).toEqual([
      { serviceId: 1, started: true, signalLevel: 1, areaCodes: [0x123, 0x456] },
    ]);
  });

  it('ignores SCTE 18 shaped data on an unsignalled PID', () => {
    const pat = buildSection(0x00, patBody([{ programNumber: 1, pid: 0x1000 }]), {
      tableIdExtension: 1,
    });
    const pmt = buildSection(0x02, pmtBody(0x0100, [{ streamType: 0x1b, pid: 0x0100 }]), {
      tableIdExtension: 1,
    });
    // Private data whose first payload byte after the pointer field is 0xD8 must
    // not turn an elementary stream PID into an EAS PID.
    const bogus = buildSection(0xd8, easBody(), { tableIdExtension: 0 });

    const result = probeBuffer(
      concat([
        ...packetizeSection(0x0000, pat, 0),
        ...packetizeSection(0x1000, pmt, 0),
        ...packetizeSection(0x0100, bogus, 0),
        buildPacket(0x0100, new Uint8Array(184).fill(0xaa), { cc: 1 }),
        buildPacket(0x0100, new Uint8Array(184).fill(0xbb), { cc: 2 }),
      ]),
      { name: 'unsignalled.ts', kind: 'buffer' },
    );

    expect(result.emergency).toBeUndefined();
  });

  it('reads EWBS signalling from an EIT event descriptor', () => {
    const pat = buildSection(0x00, patBody([{ programNumber: 1, pid: 0x1000 }]), {
      tableIdExtension: 1,
    });
    const pmt = buildSection(0x02, pmtBody(0x0100, [{ streamType: 0x1b, pid: 0x0100 }]), {
      tableIdExtension: 1,
    });
    // Present/following EIT: the 0xFC descriptor sits on the event, not the PMT.
    const eit = buildSection(
      0x4e,
      eitBody([{ eventId: 1, descriptors: descriptor(0xfc, ewbsDescriptorBody()) }]),
      { tableIdExtension: 1 },
    );

    const result = probeBuffer(
      concat([
        ...packetizeSection(0x0000, pat, 0),
        ...packetizeSection(0x1000, pmt, 0),
        ...packetizeSection(0x0012, eit, 0),
        buildPacket(0x0100, new Uint8Array(184).fill(0xaa), { cc: 0 }),
        buildPacket(0x0100, new Uint8Array(184).fill(0xbb), { cc: 1 }),
        buildPacket(0x0100, new Uint8Array(184).fill(0xcc), { cc: 2 }),
      ]),
      { name: 'ewbs-eit.ts', kind: 'buffer' },
    );

    expect(result.emergency?.ewbs?.activated).toBe(true);
    expect(result.emergency?.ewbs?.services).toMatchObject([
      { serviceId: 1, started: true, signalLevel: 1, areaCodes: [0x123, 0x456] },
    ]);
    expect(result.services[0]?.ewbs?.started).toBe(true);
    expect(result.emergency?.timeline).toMatchObject([
      { kind: 'EWBS', startSec: 0, level: 1, title: 'service 1', areas: '291, 1110' },
    ]);
  });

  it('merges locations across SCTE 18 sections of one alert', () => {
    const pat = buildSection(0x00, patBody([{ programNumber: 1, pid: 0x1000 }]), {
      tableIdExtension: 1,
    });
    const pmt = buildSection(0x02, pmtBody(0x0100, [{ streamType: 0x1b, pid: 0x0100 }]), {
      tableIdExtension: 1,
    });
    const first = buildSection(0xd8, easBody([[0x30, 0x201]]), {
      tableIdExtension: 0,
      sectionNumber: 0,
      lastSectionNumber: 1,
    });
    const second = buildSection(0xd8, easBody([[0x31, 0x202]]), {
      tableIdExtension: 0,
      sectionNumber: 1,
      lastSectionNumber: 1,
    });

    const result = probeBuffer(
      concat([
        ...packetizeSection(0x0000, pat, 0),
        ...packetizeSection(0x1000, pmt, 0),
        ...packetizeSection(0x1ffb, first, 0),
        ...packetizeSection(0x1ffb, second, 1),
        buildPacket(0x0100, new Uint8Array(184).fill(0xaa), { cc: 0 }),
        buildPacket(0x0100, new Uint8Array(184).fill(0xbb), { cc: 1 }),
        buildPacket(0x0100, new Uint8Array(184).fill(0xcc), { cc: 2 }),
      ]),
      { name: 'eas-sections.ts', kind: 'buffer' },
    );

    expect(result.emergency?.eas).toHaveLength(1);
    expect(result.emergency?.eas?.[0]?.locations).toEqual([
      { stateCode: 0x30, countySubdivision: 0, countyCode: 0x201 },
      { stateCode: 0x31, countySubdivision: 0, countyCode: 0x202 },
    ]);
    expect(result.emergency?.eas?.[0]?.occurrences).toBe(2);
  });

  it('surfaces EAS and EWBS in the probe result', () => {
    const result = probeBuffer(buildEmergencyStream(), {
      name: 'emergency.ts',
      kind: 'buffer',
    });

    expect(result.emergency?.eas?.[0]).toMatchObject({
      eventId: 0x1234,
      originatorCode: 'PEP',
      eventCode: 'TOR',
      priority: 5,
      timeRemainingSec: 44,
    });
    expect(result.emergency?.eas?.[0]?.alertText).toBe('A tornado warning has been issued.');
    expect(result.emergency?.ewbs?.activated).toBe(true);
    expect(result.emergency?.ewbs?.services).toMatchObject([
      { serviceId: 1, started: true, signalLevel: 1, areaCodes: [0x123, 0x456] },
    ]);
    expect(result.services[0]?.ewbs?.areaCodes).toEqual([0x123, 0x456]);
    expect(result.diagnostics.some((item) => item.code === 'EAS_ALERT_ACTIVE')).toBe(true);
    expect(result.diagnostics.some((item) => item.code === 'EWBS_ACTIVE')).toBe(true);
    expect(result.emergency?.timeline).toMatchObject([
      {
        kind: 'EAS',
        startSec: 0,
        endSec: 600,
        level: 5,
        title: 'TOR - A tornado warning has been issued.',
      },
      { kind: 'EWBS', startSec: 0, level: 1, title: 'service 1' },
    ]);
  });
});

function lengthPrefixed(text: string): Uint8Array {
  const bytes = ascii(text);
  return concat([Uint8Array.from([bytes.length]), bytes]);
}

function lengthPrefixed16(text: string): Uint8Array {
  const bytes = ascii(text);
  return concat([u16(bytes.length), bytes]);
}

function trdwBody(
  disasterCode = 0x0001,
  code: [number, number, number] = [0x47, 0x40, 0x0f],
  description = 'Location 47400',
): Uint8Array {
  return concat([
    u16(disasterCode),
    Uint8Array.from([0x01]), // severity: Awas
    Uint8Array.from([0x01]), // package id
    Uint8Array.from([0x01]), // one location
    Uint8Array.from(code), // postal code in BCD (0xF padding)
    lengthPrefixed(description),
  ]);
}

function tcdwBody(
  disasters: Array<{ disasterCode: number; name: string }> = [
    { disasterCode: 0x0001, name: 'Earth Quake' },
  ],
): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from([disasters.length])];
  for (const entry of disasters) {
    parts.push(
      Uint8Array.from([0x01]), // package id
      Uint8Array.from([0x01]), // authority: BMKG
      u16(entry.disasterCode),
      lengthPrefixed(entry.name),
      lengthPrefixed('Display Location here 47400'),
      lengthPrefixed('Today'),
      lengthPrefixed('Strong shaking'),
    );
  }
  return concat(parts);
}

function tmdwBody(): Uint8Array {
  return concat([
    Uint8Array.from([0x01]), // severity: Awas
    Uint8Array.from([0x01]), // package id
    lengthPrefixed16('StreamSpark Indonesia EWS Test - This is 01 Message'),
  ]);
}

describe('Indonesian EWS (TRDW/TCDW/TMDW)', () => {
  it('parses the three EWS private tables', () => {
    const trdw = parseEwsSection(buildSection(0x80, trdwBody(), { tableIdExtension: 0x01 }));
    expect(trdw?.kind).toBe('TRDW');
    expect(trdw?.regions).toEqual([
      {
        disasterCode: 1,
        locationTypeCode: 1,
        packageId: 1,
        locations: [{ code: '47400', description: 'Location 47400' }],
      },
    ]);

    const tcdw = parseEwsSection(buildSection(0x80, tcdwBody(), { tableIdExtension: 0x02 }));
    expect(tcdw?.kind).toBe('TCDW');
    expect(tcdw?.disasters[0]).toMatchObject({
      authority: 1,
      disasterCode: 1,
      name: 'Earth Quake',
      position: 'Display Location here 47400',
    });

    const tmdw = parseEwsSection(buildSection(0x80, tmdwBody(), { tableIdExtension: 0x03 }));
    expect(tmdw?.kind).toBe('TMDW');
    expect(tmdw?.messages).toEqual([
      {
        locationTypeCode: 1,
        packageId: 1,
        message: 'StreamSpark Indonesia EWS Test - This is 01 Message',
      },
    ]);
  });

  it('rejects an EWS section with an invalid CRC', () => {
    const section = buildSection(0x80, trdwBody(), { tableIdExtension: 0x01 });
    const corrupted = Uint8Array.from(section);
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] as number) ^ 0xff;
    expect(parseEwsSection(corrupted)).toBeNull();
  });

  it('reports EWS tables from a user-private stream in the probe result', () => {
    const pat = buildSection(0x00, patBody([{ programNumber: 1000, pid: 0x038f }]), {
      tableIdExtension: 1,
    });
    const pmt = buildSection(0x02, pmtBody(0x0080, [{ streamType: 0x80, pid: 0x0080 }]), {
      tableIdExtension: 1000,
    });
    const pcrAt = (seconds: number) =>
      buildPacket(0x0100, new Uint8Array(0), { pcrTicks: seconds * 27_000_000 });

    const result = probeBuffer(
      concat([
        ...packetizeSection(0x0000, pat, 0),
        ...packetizeSection(0x038f, pmt, 0),
        pcrAt(0),
        pcrAt(1), // stream time t=1 s
        ...packetizeSection(0x0080, buildSection(0x80, trdwBody(), { tableIdExtension: 0x01 }), 0),
        ...packetizeSection(0x0080, buildSection(0x80, tcdwBody(), { tableIdExtension: 0x02 }), 1),
        ...packetizeSection(0x0080, buildSection(0x80, tmdwBody(), { tableIdExtension: 0x03 }), 2),
        pcrAt(4), // stream time t=4 s
        ...packetizeSection(
          0x0080,
          buildSection(0x80, trdwBody(0x0002, [0x10, 0x00, 0x1f], 'Tsunami area 10001'), {
            tableIdExtension: 0x01,
          }),
          3,
        ),
        ...packetizeSection(
          0x0080,
          buildSection(
            0x80,
            tcdwBody([
              { disasterCode: 0x0001, name: 'Earth Quake' },
              { disasterCode: 0x0002, name: 'Tsunami' },
            ]),
            { tableIdExtension: 0x02, version: 1 },
          ),
          4,
        ),
        pcrAt(5), // stream time t=5 s, sample ends here
      ]),
      { name: 'ews.ts', kind: 'buffer' },
    );

    expect(result.emergency?.ews?.pid).toBe(0x0080);
    // The summary keeps the newest TRDW revision (the tsunami region).
    expect(result.emergency?.ews?.regions).toHaveLength(1);
    expect(result.emergency?.ews?.regions[0]?.disasterCode).toBe(0x0002);
    expect(result.emergency?.ews?.disasters.map((entry) => entry.name)).toEqual([
      'Earth Quake',
      'Tsunami',
    ]);
    expect(result.emergency?.ews?.messages[0]?.message).toBe(
      'StreamSpark Indonesia EWS Test - This is 01 Message',
    );
    expect(result.pids.find((pid) => pid.pid === 0x0080)?.kind).toBe('EWS');
    expect(
      result.tables.find((table) => table.pid === 0x0080 && table.tableId === 0x80)?.name,
    ).toBe('EWS TRDW (disaster region)');
    expect(result.diagnostics.some((item) => item.code === 'EWS_ACTIVE')).toBe(true);

    // Each region occurrence becomes a stream-time segment: the first one ends
    // when it stops repeating, the second is still present at the sample end.
    const ewsTimeline =
      result.emergency?.timeline?.filter((segment) => segment.kind === 'EWS') ?? [];
    expect(ewsTimeline).toEqual([
      {
        kind: 'EWS',
        startSec: 1,
        endSec: 1,
        level: 1,
        title: 'Earth Quake',
        areas: '47400 Location 47400',
        detail: 'StreamSpark Indonesia EWS Test - This is 01 Message',
        pid: 0x0080,
      },
      {
        kind: 'EWS',
        startSec: 4,
        level: 1,
        title: 'Tsunami',
        areas: '10001 Tsunami area 10001',
        detail: 'StreamSpark Indonesia EWS Test - This is 01 Message',
        pid: 0x0080,
      },
    ]);
  });
});
