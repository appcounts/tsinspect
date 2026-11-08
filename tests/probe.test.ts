import { describe, expect, it } from 'vitest';
import { crc32Mpeg2, probeBuffer } from '@tsinspect/core';
import {
  atscMss,
  buildPacket,
  buildSection,
  concat,
  descriptor,
  dvbDateTimeBytes,
  dvbDurationBytes,
  packetizeSection,
  patBody,
  pmtBody,
  sdtBody,
} from './helpers.js';

function buildStream(options: { trailerLength?: number; prefixLength?: number } = {}): Uint8Array {
  const pat = buildSection(
    0x00,
    patBody([
      { programNumber: 0, pid: 0x0010 },
      { programNumber: 1, pid: 0x1000 },
      { programNumber: 2, pid: 0x1001 },
    ]),
    { tableIdExtension: 0x1234 },
  );
  const pmt1 = buildSection(
    0x02,
    pmtBody(0x0100, [
      { streamType: 0x1b, pid: 0x0100 },
      { streamType: 0x0f, pid: 0x0101 },
    ]),
    { tableIdExtension: 1 },
  );
  const pmt2 = buildSection(0x02, pmtBody(0x0200, [{ streamType: 0x1b, pid: 0x0200 }]), {
    tableIdExtension: 2,
  });
  const sdt = buildSection(
    0x42,
    sdtBody(0x2000, [
      { serviceId: 1, name: 'One', provider: 'Net' },
      { serviceId: 2, name: 'Two', provider: 'Net' },
    ]),
    { tableIdExtension: 0x1234 },
  );

  const packets = [
    ...packetizeSection(0x0000, pat, 0, options),
    ...packetizeSection(0x1000, pmt1, 0, options),
    ...packetizeSection(0x1001, pmt2, 0, options),
    ...packetizeSection(0x0011, sdt, 0, options),
    buildPacket(0x0100, new Uint8Array(0), {
      pcrTicks: 0,
      cc: 0,
      ...options,
    }),
    buildPacket(0x0100, new Uint8Array(0), {
      pcrTicks: 27_000_000,
      cc: 1,
      ...options,
    }),
    buildPacket(0x0100, new Uint8Array(184).fill(0xaa), { cc: 2, ...options }),
  ];

  return concat(packets);
}

describe('probeBuffer', () => {
  it('reports monotonic packet progress', () => {
    const chunk = buildStream();
    const data = concat(Array.from({ length: 800 }, () => chunk));
    const reports: Array<{ pass: number; packets: number; totalPackets: number; bytes: number; totalBytes: number }> = [];
    probeBuffer(data, {
      name: 'progress.ts',
      kind: 'buffer',
      size: data.length,
      onProgress: (progress) => reports.push({ ...progress }),
    });
    expect(reports.length).toBeGreaterThan(1);
    const total = reports[0]?.totalPackets ?? 0;
    expect(total).toBeGreaterThan(4096);
    expect(reports.every((report) => report.pass === 1)).toBe(true);
    expect(reports.every((report) => report.totalPackets === total)).toBe(true);
    for (let index = 1; index < reports.length; index += 1) {
      expect(reports[index]!.packets).toBeGreaterThan(reports[index - 1]!.packets);
    }
    expect(reports.at(-1)?.packets).toBe(total);
    expect(reports.at(-1)?.bytes).toBe(data.length);
  });

  it('builds services, PIDs, tables and timing', () => {
    const data = buildStream();
    const result = probeBuffer(data, { name: 'synthetic.ts', kind: 'buffer', size: data.length });

    expect(result.schemaVersion).toBe('1.0');
    expect(result.packet.size).toBe(188);
    expect(result.transport.tsid).toBe(0x1234);
    expect(result.transport.networkPid).toBe(0x0010);
    expect(result.transport.packetCount).toBeGreaterThan(0);
    expect(result.transport.durationSec).toBeCloseTo(1, 6);
    expect(result.transport.bitrateBps).toBeCloseTo((result.transport.packetCount * 188 * 8) / 1, 3);
    expect(result.pids.find((pid) => pid.pid === 0x0000)?.kind).toBe('PAT');
    expect(result.pids.find((pid) => pid.pid === 0x0000)?.firstPacketOffset).toBe(0);
    expect(result.pids.find((pid) => pid.pid === 0x1000)?.kind).toBe('PMT');

    expect(result.services).toHaveLength(2);
    const first = result.services[0];
    expect(first?.programNumber).toBe(1);
    expect(first?.name).toBe('One');
    expect(first?.providerName).toBe('Net');
    expect(first?.pcrPid).toBe(0x0100);
    expect(first?.streams.map((stream) => stream.pid)).toEqual([0x0100, 0x0101]);
    expect(first?.serviceTypeName).toBe('digital television');
    expect(first?.tsid).toBe(0x1234);
    expect(first?.originalNetworkId).toBe(0x2000);
    expect(first?.packets).toBeGreaterThan(0);
    expect(first?.bitrateBps).toBeGreaterThan(0);
    expect(first?.pids).toEqual([0x0100, 0x0101, 0x1000]);
    expect(first?.components?.total).toBe(first?.pids?.length);
    expect(first?.isScrambled).toBe(false);

    expect(result.tables.some((table) => table.name === 'PAT')).toBe(true);
    expect(result.tables.filter((table) => table.name === 'PMT')).toHaveLength(2);
    expect(result.tables.find((table) => table.name === 'SDT (actual)')?.tableIdExtension).toBe(
      0x1234,
    );
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'PMT_MISSING')).toBe(false);
  });

  it('captures TOT time range, local offset and country', () => {
    const offsetBody = new Uint8Array(13);
    offsetBody.set(new TextEncoder().encode('FRA'), 0);
    offsetBody[3] = 0x01; // polarity 1 (negative)
    offsetBody[4] = 0x02; // BCD hours
    offsetBody[5] = 0x00; // BCD minutes
    offsetBody[11] = 0x03; // next offset BCD hours
    offsetBody[12] = 0x00; // next offset BCD minutes
    const change = dvbDateTimeBytes(Date.UTC(2026, 6, 2, 0, 0, 0) / 1000);
    offsetBody.set(change, 6);
    const offset = descriptor(0x58, offsetBody);

    const totSection = (unixSeconds: number): Uint8Array => {
      const utc = dvbDateTimeBytes(unixSeconds);
      const sectionLength = 5 + 2 + offset.length + 4;
      const section = new Uint8Array(3 + sectionLength);
      section[0] = 0x73;
      section[1] = 0xb0 | ((sectionLength >> 8) & 0x0f);
      section[2] = sectionLength & 0xff;
      section.set(utc, 3);
      section[8] = 0xf0 | ((offset.length >> 8) & 0x0f);
      section[9] = offset.length & 0xff;
      section.set(offset, 10);
      const crc = crc32Mpeg2(section.subarray(0, section.length - 4));
      section[section.length - 4] = (crc >>> 24) & 0xff;
      section[section.length - 3] = (crc >>> 16) & 0xff;
      section[section.length - 2] = (crc >>> 8) & 0xff;
      section[section.length - 1] = crc & 0xff;
      return section;
    };

    const data = concat([
      buildStream(),
      ...packetizeSection(0x0014, totSection(Date.UTC(2026, 6, 1, 10, 0, 0) / 1000)),
      ...packetizeSection(0x0014, totSection(Date.UTC(2026, 6, 1, 10, 1, 0) / 1000)),
    ]);
    const result = probeBuffer(data, { name: 'tot.ts', kind: 'buffer' });
    expect(result.clock?.utcFirstIso).toBe('2026-07-01T10:00:00.000Z');
    expect(result.clock?.utcLastIso).toBe('2026-07-01T10:01:00.000Z');
    expect(result.clock?.localFirstIso).toBe('2026-07-01T08:00:00.000Z');
    expect(result.clock?.localLastIso).toBe('2026-07-01T08:01:00.000Z');
    expect(result.clock?.localOffsetSec).toBe(-7200);
    expect(result.clock?.localTimeOffset).toBe('-02:00');
    expect(result.clock?.nextLocalTimeOffset).toBe('-03:00');
    expect(result.clock?.timeOfChangeIso).toBe('2026-07-02T00:00:00.000Z');
    expect(result.clock?.countryCode).toBe('FRA');
    expect(result.transport.country).toBe('FRA');
  });

  it('collects ATSC RRT rating regions, including RRT5', () => {
    const name = atscMss('USA');
    const dimension = atscMss('MPAA');
    const abbrev = atscMss('PG-13');
    const value = atscMss('Parents Strongly Cautioned');
    const body = concat([
      Uint8Array.from([0x00, name.length]),
      name,
      Uint8Array.from([1, dimension.length]),
      dimension,
      Uint8Array.from([0xf1]),
      Uint8Array.from([abbrev.length]),
      abbrev,
      Uint8Array.from([value.length]),
      value,
      Uint8Array.from([0x00, 0x00]),
    ]);
    const rrt = buildSection(0xca, body, { tableIdExtension: 0xff05 });

    const title = atscMss('News');
    const advisory = descriptor(0x87, Uint8Array.from([0x05, 0x01, 0x00, 0x00]));
    const event = concat([
      Uint8Array.from([0x00, 0x01]), // event id
      Uint8Array.from([0x00, 0x00, 0x00, 0x00]), // start time
      Uint8Array.from([0x00, 0x00, 0x00]), // ETM location, length in seconds
      Uint8Array.from([title.length]),
      title,
      Uint8Array.from([(advisory.length >> 8) & 0xff, advisory.length & 0xff]),
      advisory,
    ]);
    const eit = buildSection(0xcb, concat([Uint8Array.from([0x00, 0x01]), event]), {
      tableIdExtension: 1,
    });

    const data = concat([
      buildStream(),
      ...packetizeSection(0x1ffb, rrt),
      ...packetizeSection(0x1ffb, eit),
    ]);
    const result = probeBuffer(data, { name: 'rrt.ts', kind: 'buffer' });
    expect(result.ratings).toHaveLength(1);
    expect(result.ratings?.[0]?.ratingRegion).toBe(5);
    expect(result.ratings?.[0]?.name).toBe('USA');
    expect(result.ratings?.[0]?.dimensions[0]?.values[0]?.abbrev).toBe('PG-13');
    expect(result.events[0]?.rating).toBe('RRT5 MPAA PG-13');
    const table = result.tables.find((entry) => entry.tableId === 0xca);
    expect(table?.fields?.ratingRegion).toBe(5);
    expect(table?.fields?.regionName).toBe('USA');
  });

  it('detects ISDB via the BIT table', () => {
    const data = buildStream();
    const bit = buildSection(0xc4, new Uint8Array(8), { tableIdExtension: 0x1234 });
    const withBit = concat([data.subarray(0, data.length), ...packetizeSection(0x0024, bit)]);
    const result = probeBuffer(withBit, { name: 'isdb.ts', kind: 'buffer' });
    expect(result.standard.detected).toBe('ISDB');
    expect(result.standard.evidence.join(' ')).toContain('ISDB BIT');
    expect(result.pids.find((pid) => pid.pid === 0x0024)?.kind).toBe('ISDB BIT');
  });

  it('resolves the shared ISDB LDT/CDT and ATSC MGT/TVCT table ids', () => {
    const base = buildStream();
    const bit = buildSection(0xc4, new Uint8Array(8), { tableIdExtension: 0x1234 });
    const ldt = buildSection(0xc7, new Uint8Array(8), { tableIdExtension: 0x1234 });
    const cdt = buildSection(0xc8, new Uint8Array(8), { tableIdExtension: 0x1234 });
    const isdb = probeBuffer(
      concat([
        base,
        ...packetizeSection(0x0024, bit, 0),
        ...packetizeSection(0x0024, ldt, 1),
        ...packetizeSection(0x0024, cdt, 2),
      ]),
      { name: 'isdb-tables.ts', kind: 'buffer' },
    );
    expect(isdb.standard.detected).toBe('ISDB');
    expect(isdb.tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(['ISDB LDT', 'ISDB CDT']),
    );

    const atscPat = buildSection(0x00, patBody([{ programNumber: 1, pid: 0x1000 }]), {
      tableIdExtension: 0x1234,
    });
    const atscPmt = buildSection(
      0x02,
      pmtBody(0x0100, [{ streamType: 0x1b, pid: 0x0100 }]),
      { tableIdExtension: 1 },
    );
    const atsc = probeBuffer(
      concat([
        ...packetizeSection(0x0000, atscPat),
        ...packetizeSection(0x1000, atscPmt),
        buildPacket(0x1ffb, new Uint8Array(184).fill(0xff), { pusi: true }),
        ...packetizeSection(0x1ffb, ldt, 1),
        ...packetizeSection(0x1ffb, cdt, 2),
      ]),
      { name: 'atsc-tables.ts', kind: 'buffer' },
    );
    expect(atsc.standard.detected).toBe('ATSC');
    expect(atsc.tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(['ATSC MGT', 'ATSC TVCT']),
    );
  });

  it('detects ATSC via PSIP and registration descriptors', () => {
    const data = buildStream();
    const withPsi = concat([
      data,
      buildPacket(0x1ffb, new Uint8Array(184).fill(0xff), { pusi: true }),
    ]);
    const result = probeBuffer(withPsi, { name: 'atsc.ts', kind: 'buffer' });
    expect(['ATSC', 'mixed']).toContain(result.standard.detected);
    expect(result.standard.evidence.join(' ')).toContain('ATSC PSIP');
  });

  it('handles 192-byte M2TS packets', () => {
    const data = buildStream({ prefixLength: 4 });
    const result = probeBuffer(data, { name: 'm2ts.ts', kind: 'buffer' });
    expect(result.packet.size).toBe(192);
    expect(result.packet.format).toBe('m2ts');
    expect(result.services).toHaveLength(2);
    expect(result.transport.pcrPid).toBe(0x0100);
  });

  it('handles 204-byte ISDB-Tb packets', () => {
    const data = buildStream({ trailerLength: 16 });
    const result = probeBuffer(data, { name: 'isdb-tb.ts', kind: 'buffer' });
    expect(result.packet.size).toBe(204);
    expect(result.packet.format).toBe('isdb-tb');
    expect(result.services).toHaveLength(2);
    expect(result.standard.detected).toBe('ISDB');
    expect(result.isdb?.trailerPackets).toBe(result.transport.packetCount);
    expect(result.isdb?.layers.length).toBeGreaterThan(0);
  });

  it('reports a clean error when there is no sync', () => {
    const result = probeBuffer(new Uint8Array(2048), { name: 'empty.bin', kind: 'buffer' });
    expect(result.packet.size).toBe(0);
    expect(result.diagnostics[0]?.code).toBe('TS_NO_SYNC');
  });

  it('flags continuity counter errors', () => {
    const data = buildStream();
    const broken = buildPacket(0x0100, new Uint8Array(184), { cc: 9 });
    const withGap = concat([data, broken]);
    const result = probeBuffer(withGap, { name: 'cc.ts', kind: 'buffer' });
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'TS_CC_DISCONTINUITY')).toBe(
      true,
    );
  });

  it('counts duplicate packets separately from continuity errors', () => {
    const filler = (cc: number): Uint8Array =>
      buildPacket(0x0200, new Uint8Array(184).fill(0xaa), { cc });
    const data = concat([buildStream(), filler(0), filler(0), filler(0), filler(1)]);
    const result = probeBuffer(data, { name: 'duplicate.ts', kind: 'buffer' });
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);

    expect(codes).toContain('TS_DUPLICATE_PACKET');
    expect(codes).not.toContain('TS_CC_DISCONTINUITY');
  });

  it('recognises SCTE-35 signalled with a CUEI registration descriptor', () => {
    const pat = buildSection(0x00, patBody([{ programNumber: 1, pid: 0x1000 }]), {
      tableIdExtension: 0x1234,
    });
    const pmt = buildSection(
      0x02,
      pmtBody(0x0100, [
        { streamType: 0x1b, pid: 0x0100 },
        {
          streamType: 0x06,
          pid: 0x0106,
          descriptors: descriptor(0x05, new TextEncoder().encode('CUEI')),
        },
      ]),
      { tableIdExtension: 1 },
    );
    const data = concat([
      ...packetizeSection(0x0000, pat),
      ...packetizeSection(0x1000, pmt),
      ...Array.from({ length: 5 }, (_, index) =>
        buildPacket(0x1fff, new Uint8Array(184).fill(0xff), { cc: index }),
      ),
    ]);
    const result = probeBuffer(data, { name: 'cuei.ts', kind: 'buffer' });

    expect(result.capabilities.scte35).toBe(true);
  });

  it('detects teletext, subtitles, captions, SCTE-35 and CA from PMT descriptors', () => {
    const pat = buildSection(0x00, patBody([{ programNumber: 1, pid: 0x1000 }]), {
      tableIdExtension: 0x1234,
    });
    const pmt = buildSection(
      0x02,
      pmtBody(0x0100, [
        { streamType: 0x1b, pid: 0x0100 },
        {
          streamType: 0x06,
          pid: 0x0101,
          descriptors: descriptor(0x56, Uint8Array.from([0x65, 0x6e, 0x67, 0x10, 0x88])),
        },
        {
          streamType: 0x06,
          pid: 0x0102,
          descriptors: descriptor(
            0x59,
            Uint8Array.from([0x65, 0x6e, 0x67, 0x10, 0x00, 0x01, 0x00, 0x02]),
          ),
        },
        {
          streamType: 0x1b,
          pid: 0x0103,
          descriptors: descriptor(
            0x86,
            Uint8Array.from([0x01, 0x65, 0x6e, 0x67, 0x00, 0x00, 0x01]),
          ),
        },
        {
          streamType: 0x06,
          pid: 0x0104,
          descriptors: descriptor(0xfd, Uint8Array.from([0x00, 0x08, 0x3d])),
        },
        { streamType: 0x86, pid: 0x0105 },
        {
          streamType: 0x06,
          pid: 0x0106,
          descriptors: descriptor(0x09, Uint8Array.from([0x00, 0x05, 0xe0, 0x01])),
        },
      ]),
      { tableIdExtension: 1 },
    );
    const data = concat([
      ...packetizeSection(0x0000, pat),
      ...packetizeSection(0x1000, pmt),
      // Layout detection needs a run of at least five packets.
      ...Array.from({ length: 5 }, (_, index) =>
        buildPacket(0x1fff, new Uint8Array(184).fill(0xff), { cc: index }),
      ),
    ]);
    const result = probeBuffer(data, { name: 'caps.ts', kind: 'buffer' });

    expect(result.capabilities).toMatchObject({
      teletext: true,
      dvbSubtitles: true,
      atscCaptions: true,
      aribCaptions: true,
      scte35: true,
      vbi: false,
      scrambled: false,
      caSystems: [5],
    });
  });

  it('records BAT and RST summaries in the table index', () => {
    const base = buildStream();
    const bouquetName = descriptor(0x47, new TextEncoder().encode('Test Bouquet'));
    const batBody = concat([
      Uint8Array.from([0xf0, bouquetName.length]),
      bouquetName,
      Uint8Array.from([0xf0, 0x00]),
    ]);
    const bat = buildSection(0x4a, batBody, { tableIdExtension: 0x0042 });
    const rst = buildSection(
      0x71,
      Uint8Array.from([0x00, 0x01, 0x00, 0x02, 0x80]),
      { long: false },
    );
    const data = concat([
      base,
      ...packetizeSection(0x0011, bat, 1),
      ...packetizeSection(0x0013, rst, 0),
    ]);
    const result = probeBuffer(data, { name: 'bat.ts', kind: 'buffer' });

    expect(result.tables.find((table) => table.tableId === 0x4a)?.fields?.bouquetName).toBe(
      'Test Bouquet',
    );
    const rstEntries = result.tables.find((table) => table.tableId === 0x71)?.fields?.entries;
    expect(Array.isArray(rstEntries) ? rstEntries.length : rstEntries).toBe(1);
  });

  it('summarizes event content, parental rating and languages', () => {
    const name = new TextEncoder().encode('News');
    const shortEvent = descriptor(
      0x4d,
      concat([
        new TextEncoder().encode('eng'),
        Uint8Array.from([name.length]),
        name,
        Uint8Array.from([0x00]),
      ]),
    );
    const events = concat([
      Uint8Array.from([0x00, 0x01]),
      dvbDateTimeBytes(0),
      dvbDurationBytes(60),
      Uint8Array.from([0x80, 0x00]), // running, descriptor length placeholder
    ]);
    const descriptors = concat([
      shortEvent,
      descriptor(0x54, Uint8Array.from([0x21, 0x30])),
      descriptor(0x55, Uint8Array.from([0x46, 0x52, 0x41, 0x04])),
    ]);
    // Patch the event descriptor length and append the descriptors.
    events[events.length - 1] = descriptors.length;
    const eitBody = concat([
      Uint8Array.from([0x12, 0x34]),
      Uint8Array.from([0x05, 0x55]),
      Uint8Array.from([0x00, 0x4e]),
      events,
      descriptors,
    ]);
    const eit = buildSection(0x4e, eitBody, { tableIdExtension: 1 });
    const data = concat([buildStream(), ...packetizeSection(0x0012, eit)]);
    const result = probeBuffer(data, { name: 'event.ts', kind: 'buffer' });
    const event = result.events.find((item) => item.eventId === 1);

    expect(event?.content).toBe('news/weather report (user 3/0)');
    expect(event?.rating).toBe('FRA: rating 4');
    expect(event?.languages).toEqual(['eng']);
  });
});

function shortEvent(name: string, text?: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const textBytes = new TextEncoder().encode(text ?? '');
  return descriptor(
    0x4d,
    concat([
      new TextEncoder().encode('eng'),
      Uint8Array.from([nameBytes.length]),
      nameBytes,
      Uint8Array.from([textBytes.length]),
      textBytes,
    ]),
  );
}

interface EitEventSpec {
  eventId: number;
  name?: string;
  text?: string;
  runningStatus?: number;
}

function eitSection(tableId: number, serviceId: number, events: EitEventSpec[]): Uint8Array {
  const entries = events.map((event) => {
    const desc =
      event.name !== undefined ? shortEvent(event.name, event.text) : new Uint8Array(0);
    const body = new Uint8Array(12 + desc.length);
    body[0] = (event.eventId >> 8) & 0xff;
    body[1] = event.eventId & 0xff;
    body.set(dvbDateTimeBytes(0), 2);
    body.set(dvbDurationBytes(60), 7);
    body[10] = ((event.runningStatus ?? 0) << 5) | ((desc.length >> 8) & 0x0f);
    body[11] = desc.length & 0xff;
    body.set(desc, 12);
    return body;
  });
  return buildSection(
    tableId,
    concat([Uint8Array.from([0x12, 0x34, 0x20, 0x00, 0x00, 0x4e]), ...entries]),
    { tableIdExtension: serviceId },
  );
}

function eitStream(sections: Uint8Array[]): Uint8Array {
  const packets: Uint8Array[] = [];
  let cc = 0;
  for (const section of sections) {
    const chunk = packetizeSection(0x0012, section, cc);
    packets.push(...chunk);
    cc = (cc + chunk.length) & 0x0f;
  }
  // Layout detection needs five valid packets; the base stream also gives the
  // probe a PAT/PMT to associate the EIT data with.
  return concat([buildStream(), ...packets]);
}

describe('EIT present/following and schedule merging', () => {
  it('keeps both sources when a schedule event is announced again as present', () => {
    const data = eitStream([
      eitSection(0x50, 0x0401, [
        { eventId: 1, name: 'Schedule name', text: 'Schedule text', runningStatus: 0 },
      ]),
      // The present/following occurrence carries no descriptors of its own.
      eitSection(0x4e, 0x0401, [{ eventId: 1, runningStatus: 4 }]),
    ]);
    const result = probeBuffer(data, { name: 'eit.ts', kind: 'buffer', size: data.length });
    const event = result.events.find((item) => item.serviceId === 0x0401 && item.eventId === 1);

    expect(event?.sources).toEqual(['present-following', 'schedule']);
    expect(event?.presentFollowing).toBe('present');
    expect(event?.runningStatus).toBe(4);
    // Fields the present/following section did not carry come from the schedule.
    expect(event?.name).toBe('Schedule name');
    expect(event?.text).toBe('Schedule text');
  });

  it('does not let running_status 0 in a schedule overwrite present/following', () => {
    const data = eitStream([
      eitSection(0x4e, 0x0401, [{ eventId: 1, name: 'Live', runningStatus: 4 }]),
      eitSection(0x50, 0x0401, [
        { eventId: 1, name: 'Schedule', text: 'Filler', runningStatus: 0 },
      ]),
    ]);
    const result = probeBuffer(data, { name: 'eit.ts', kind: 'buffer', size: data.length });
    const event = result.events.find((item) => item.serviceId === 0x0401 && item.eventId === 1);

    expect(event?.runningStatus).toBe(4);
    expect(event?.runningStatusName).toBe('running');
    expect(event?.name).toBe('Live');
    expect(event?.sources).toEqual(['present-following', 'schedule']);
  });

  it('moves an event from following to present', () => {
    const data = eitStream([
      eitSection(0x4e, 0x0401, [
        { eventId: 10, name: 'Now', runningStatus: 4 },
        { eventId: 11, name: 'Next', runningStatus: 2 },
      ]),
      eitSection(0x4e, 0x0401, [{ eventId: 11, name: 'Next live', runningStatus: 4 }]),
    ]);
    const result = probeBuffer(data, { name: 'eit.ts', kind: 'buffer', size: data.length });
    const event = result.events.find((item) => item.serviceId === 0x0401 && item.eventId === 11);

    expect(event?.presentFollowing).toBe('present');
    expect(event?.runningStatus).toBe(4);
    expect(event?.sources).toEqual(['present-following']);
    expect(
      result.events.find((item) => item.serviceId === 0x0401 && item.eventId === 10)
        ?.presentFollowing,
    ).toBe('present');
  });
});

describe('cross-table consistency diagnostics', () => {
  it('flags TSID/ONID mismatch, SDT other differences and unreferenced PIDs', () => {
    const pat = buildSection(
      0x00,
      patBody([{ programNumber: 1, pid: 0x1000 }]),
      { tableIdExtension: 0x1234 },
    );
    const pmt = buildSection(
      0x02,
      pmtBody(0x0100, [{ streamType: 0x1b, pid: 0x0100 }]),
      { tableIdExtension: 1 },
    );
    const sdtActual = buildSection(
      0x42,
      sdtBody(0x2000, [{ serviceId: 1, name: 'One' }]),
      { tableIdExtension: 0x9999 },
    );
    const sdtOther = buildSection(
      0x46,
      sdtBody(0x2000, [
        { serviceId: 1, name: 'One' },
        { serviceId: 2, name: 'Two' },
      ]),
      { tableIdExtension: 0x9999 },
    );
    const nit = buildSection(
      0x40,
      concat([
        Uint8Array.from([0xf0, 0x00]),
        Uint8Array.from([0xf0, 0x08]),
        Uint8Array.from([0x99, 0x99, 0x30, 0x00, 0xf0, 0x00]),
      ]),
      { tableIdExtension: 0x0555 },
    );

    const data = concat([
      ...packetizeSection(0x0000, pat),
      ...packetizeSection(0x1000, pmt),
      ...packetizeSection(0x0011, sdtActual),
      ...packetizeSection(0x0011, sdtOther, 1),
      ...packetizeSection(0x0010, nit),
      buildPacket(0x0777, new Uint8Array(184).fill(0x55)),
    ]);
    const result = probeBuffer(data, {
      name: 'inconsistent.ts',
      kind: 'buffer',
      size: data.length,
    });
    const codes = new Set(result.diagnostics.map((diagnostic) => diagnostic.code));

    expect(codes.has('TSID_MISMATCH')).toBe(true);
    expect(codes.has('ONID_MISMATCH')).toBe(true);
    expect(codes.has('SDT_OTHER_INCONSISTENT')).toBe(true);
    expect(codes.has('UNREFERENCED_PID')).toBe(true);
  });
});
