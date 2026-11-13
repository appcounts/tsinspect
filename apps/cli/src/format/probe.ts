import type {
  DescriptorInfo,
  EsMetadata,
  ProbeDataBroadcast,
  ProbeEvent,
  ProbePid,
  ProbeRatingRegion,
  ProbeResult,
  ProbeService,
  ProbeTable,
} from '@tsinspect/core';
import { formatBitrate, formatBytes, formatDuration, hex16 } from '@tsinspect/core';

export interface TextFormatOptions {
  /** Include descriptor raw bytes, all evidence and every PID/table row. */
  all?: boolean;
  /** Show compact parsed summaries for tables that have them. */
  detail?: boolean;
}

const LABEL_WIDTH = 13;

export function formatProbeText(result: ProbeResult, options: TextFormatOptions = {}): string {
  const lines: string[] = [];
  const all = options.all ?? false;

  lines.push(`tsinspect ${result.tool.version} - MPEG-TS transport stream probe`);
  lines.push('');

  lines.push(label('Source', result.source.name));
  const sourceParts: string[] = [result.source.kind];
  if (result.source.size !== undefined) {
    sourceParts.push(
      result.source.full
        ? `${formatBytes(result.source.size)} total`
        : `${formatBytes(result.source.sampledBytes)} sampled of ${formatBytes(result.source.size)}`,
    );
  } else {
    sourceParts.push(`${formatBytes(result.source.sampledBytes)} sampled`);
  }
  if (!result.source.full) sourceParts.push('partial scan');
  lines.push(label('Input', sourceParts.join(', ')));
  lines.push(
    label(
      'Packets',
      `${result.packet.size}-byte ${packetFormatName(result.packet.format)}, sync +${result.packet.syncOffset}, ` +
        `${result.transport.packetCount.toLocaleString('en-US')} packet(s)`,
    ),
  );
  lines.push(
    label(
      'Standard',
      `${result.standard.detected} (${Math.round(result.standard.confidence * 100)}% confidence)`,
    ),
  );
  if (result.standard.evidence.length > 0) {
    const wrapped = wrapText(result.standard.evidence.join('; '), 120);
    lines.push(label('Evidence', wrapped[0] ?? ''));
    for (const extra of wrapped.slice(1)) lines.push(' '.repeat(LABEL_WIDTH) + extra);
  }

  const transport: string[] = [];
  if (result.transport.tsid !== undefined) transport.push(`TSID ${hex16(result.transport.tsid)}`);
  if (result.transport.networkId !== undefined) {
    transport.push(`network ${hex16(result.transport.networkId)}`);
  }
  if (result.transport.networkName) transport.push(`"${result.transport.networkName}"`);
  if (result.transport.country) transport.push(`country ${result.transport.country}`);
  if (result.transport.networkPid !== undefined) {
    transport.push(`NIT PID ${hex16(result.transport.networkPid)}`);
  }
  if (transport.length > 0) lines.push(label('Transport', transport.join(', ')));

  const timing: string[] = [];
  if (result.transport.pcrPid !== undefined)
    timing.push(`PCR PID ${hex16(result.transport.pcrPid)}`);
  if (result.transport.durationSec !== undefined) {
    timing.push(`duration ${formatDuration(result.transport.durationSec)}`);
  }
  if (result.transport.bitrateBps !== undefined) {
    timing.push(`bitrate ${formatBitrate(result.transport.bitrateBps)}`);
    timing.push(`bitrate-204 ${formatBitrate((result.transport.bitrateBps * 204) / 188)}`);
  }
  if (timing.length > 0) lines.push(label('Timing', timing.join(', ')));
  if (result.clock) {
    const clock = result.clock;
    const parts: string[] = [];
    if (clock.utcIso) parts.push(`UTC ${clock.utcIso}`);
    if (clock.utcFirstIso && clock.utcLastIso && clock.utcFirstIso !== clock.utcLastIso) {
      parts.push(`range ${clock.utcFirstIso} .. ${clock.utcLastIso}`);
    }
    if (clock.localFirstIso && clock.localLastIso) {
      parts.push(`local ${clock.localFirstIso} .. ${clock.localLastIso}`);
    } else if (clock.localOffsetSec !== undefined) {
      const sign = clock.localOffsetSec < 0 ? '-' : '+';
      const absolute = Math.abs(clock.localOffsetSec);
      const hours = Math.floor(absolute / 3600)
        .toString()
        .padStart(2, '0');
      const minutes = Math.floor((absolute % 3600) / 60)
        .toString()
        .padStart(2, '0');
      parts.push(`local offset ${sign}${hours}:${minutes}`);
    }
    if (clock.countryCode) parts.push(`country ${clock.countryCode}`);
    parts.push(
      `${clock.source}${clock.gpsUtcOffset !== undefined ? `, GPS-UTC ${clock.gpsUtcOffset}s` : ''}`,
    );
    lines.push(label('Clock', parts.join(', ')));
  }

  const caps: string[] = [];
  if (result.capabilities.teletext) caps.push('Teletext');
  if (result.capabilities.dvbSubtitles) caps.push('DVB subtitles');
  if (result.capabilities.atscCaptions) caps.push('ATSC captions');
  if (result.capabilities.aribCaptions) caps.push('ARIB captions');
  if (result.capabilities.vbi) caps.push('VBI');
  if (result.capabilities.scte35) caps.push('SCTE-35');
  if (result.capabilities.scrambled) caps.push('scrambled');
  if (result.capabilities.caSystems.length > 0) {
    caps.push(
      `CA ${result.capabilities.caSystems.map((id) => `0x${id.toString(16).padStart(4, '0').toUpperCase()}`).join('/')}`,
    );
  }
  lines.push(label('Capabilities', caps.length > 0 ? caps.join(', ') : 'none detected'));

  if (result.isdb) {
    const layers = result.isdb.layers
      .map((entry) => `layer ${entry.layer}=${entry.packets}`)
      .join(', ');
    const iip =
      result.isdb.iipPid !== undefined
        ? `, IIP PID ${hex16(result.isdb.iipPid)} (${result.isdb.iipPackets} packet(s))`
        : '';
    lines.push(
      label(
        'ISDB-Tb',
        `${result.isdb.trailerPackets} trailer packet(s)${layers ? `, ${layers}` : ''}${iip}${
          result.isdb.country ? `, country ${result.isdb.country}` : ''
        }`,
      ),
    );
  }

  if (result.emergency) {
    const parts: string[] = [];
    for (const alert of result.emergency.eas ?? []) {
      parts.push(
        `EAS ${alert.eventCode || 'alert'} from ${alert.originatorCode || '?'} (priority ${alert.priority}, ${alert.timeRemainingSec}s remaining, ${alert.locations.length} area(s))`,
      );
    }
    if (result.emergency.ewbs) {
      const started = result.emergency.ewbs.services.filter((service) => service.started).length;
      parts.push(
        `EWBS ${result.emergency.ewbs.activated ? 'active' : 'inactive'}, ${result.emergency.ewbs.services.length} service(s), ${started} started`,
      );
    }
    if (result.emergency.ews) {
      const ews = result.emergency.ews;
      const names = [
        ...new Set(
          ews.regions.map((region) => {
            const disaster = ews.disasters.find(
              (entry) => entry.disasterCode === region.disasterCode,
            );
            return disaster?.name || `0x${region.disasterCode.toString(16)}`;
          }),
        ),
      ];
      parts.push(
        `EWS PID ${hex16(ews.pid)} ${names.join('/') || '-'}: ${ews.regions.length} region(s), ${ews.disasters.length} disaster(s), ${ews.messages.length} message(s)`,
      );
    }
    if (result.emergency.timeline && result.emergency.timeline.length > 0) {
      for (const segment of result.emergency.timeline) {
        const range = `${formatDuration(segment.startSec)}-${
          segment.endSec === undefined ? 'ongoing' : formatDuration(segment.endSec)
        }`;
        const level = segment.level !== undefined ? ` L${segment.level}` : '';
        const info = [segment.title, segment.areas].filter(Boolean).join(' · ');
        parts.push(`${range} ${segment.kind}${level}${info ? ` ${info}` : ''}`);
      }
    }
    if (parts.length > 0) lines.push(label('Emergency', parts.join('; ')));
  }

  lines.push('');
  lines.push(sectionTitle(`SERVICES (${result.services.length})`));
  if (result.services.length === 0) {
    lines.push('  No services found.');
  } else {
    for (const service of result.services) {
      lines.push(...formatService(service, all));
    }
  }

  if (result.ratings && result.ratings.length > 0) {
    lines.push('');
    lines.push(sectionTitle(`RATINGS (${result.ratings.length} rating region(s))`));
    lines.push(...formatRatings(result.ratings));
  }

  if (result.events.length > 0) {
    lines.push('');
    lines.push(sectionTitle(`EPG (${result.events.length} event(s))`));
    lines.push(...formatEvents(result.events));
  }

  if (result.dataBroadcast) {
    lines.push('');
    lines.push(...formatDataBroadcast(result.dataBroadcast, all));
  }

  lines.push('');
  lines.push(sectionTitle(`TABLES (${result.tables.length})`));
  lines.push(...formatTables(result.tables, all));
  lines.push('');
  lines.push(sectionTitle(`PIDS (${result.pids.length})`));
  lines.push(...formatPids(result.pids, all));

  lines.push('');
  lines.push(sectionTitle(`DIAGNOSTICS (${result.diagnostics.length})`));
  if (result.diagnostics.length === 0) {
    lines.push('  None.');
  } else {
    for (const diagnostic of result.diagnostics) {
      const location: string[] = [];
      if (diagnostic.pid !== undefined) location.push(`PID ${hex16(diagnostic.pid)}`);
      if (diagnostic.tableId !== undefined) location.push(`table ${hex16(diagnostic.tableId)}`);
      if (diagnostic.packet !== undefined) location.push(`packet ${diagnostic.packet}`);
      const where = location.length > 0 ? ` [${location.join(', ')}]` : '';
      lines.push(`  ${diagnostic.severity.toUpperCase().padEnd(7)} ${diagnostic.code}${where}`);
      lines.push(`          ${diagnostic.message}`);
    }
  }

  return lines.join('\n');
}

function formatRatings(regions: ProbeRatingRegion[]): string[] {
  const lines: string[] = [];
  for (const region of regions) {
    const name = region.name ? ` "${region.name}"` : '';
    const dimensions =
      region.dimensions.length === 1 ? '1 dimension' : `${region.dimensions.length} dimensions`;
    lines.push(
      `  RRT${region.ratingRegion}${name}   protocol ${region.protocolVersion}, ${dimensions}`,
    );
    for (const dimension of region.dimensions) {
      const scale = dimension.graduatedScale ? 'graduated' : 'litteral';
      const values =
        dimension.values.length === 1 ? '1 value' : `${dimension.values.length} values`;
      lines.push(`      ${dimension.name || '(unnamed)'} (${scale}, ${values})`);
      for (const value of dimension.values) {
        const abbrev = value.abbrev || '-';
        lines.push(`        ${abbrev.padEnd(8)} ${value.text}`);
      }
    }
    if (region.descriptors.length > 0) {
      lines.push(
        `      descriptors: ${region.descriptors.map((descriptor) => descriptor.name).join(', ')}`,
      );
    }
  }
  return lines;
}

function formatService(service: ProbeService, all: boolean): string[] {
  const lines: string[] = [];
  const name = service.name ? `"${service.name}"` : '(unnamed)';
  const provider = service.providerName ? ` by "${service.providerName}"` : '';
  const channel =
    service.majorChannelNumber !== undefined
      ? ` [channel ${service.majorChannelNumber}.${service.minorChannelNumber ?? 0}]`
      : '';
  lines.push(
    `  Program ${service.programNumber}${name !== '(unnamed)' ? ` ${name}` : ''}${channel}${provider}`,
  );

  const details: string[] = [];
  if (service.serviceId !== undefined) details.push(`service id ${hex16(service.serviceId)}`);
  if (service.serviceType !== undefined) {
    const typeName = service.serviceTypeName ?? serviceTypeName(service.serviceType);
    details.push(`type ${service.serviceType} (${typeName})`);
  } else if (service.serviceTypeName) {
    details.push(`type ${service.serviceTypeName}`);
  }
  if (service.sourceId !== undefined && service.sourceId !== service.serviceId) {
    details.push(`source id ${hex16(service.sourceId)}`);
  }
  if (service.channelTsid !== undefined) details.push(`channel TSID ${hex16(service.channelTsid)}`);
  if (service.modulationMode !== undefined) {
    details.push(`modulation ${hex16(service.modulationMode)}`);
  }
  details.push(`PMT PID ${hex16(service.pmtPid)}`);
  if (service.pcrPid !== undefined) details.push(`PCR PID ${hex16(service.pcrPid)}`);
  lines.push(`      ${details.join('   ')}`);

  const serviceStats: string[] = [];
  if (service.bitrateBps !== undefined) {
    serviceStats.push(`bitrate ${formatBitrate(service.bitrateBps)}`);
  }
  if (service.bitrate204Bps !== undefined) {
    serviceStats.push(`bitrate-204 ${formatBitrate(service.bitrate204Bps)}`);
  }
  if (service.packets !== undefined) {
    serviceStats.push(`${service.packets.toLocaleString('en-US')} packet(s)`);
  }
  if (service.pids !== undefined && service.pids.length > 0) {
    serviceStats.push(`PIDs ${service.pids.map((pid) => hex16(pid)).join(',')}`);
  }
  if (service.components !== undefined) {
    serviceStats.push(
      `components ${service.components.clear} clear, ${service.components.scrambled} scrambled`,
    );
  }
  if (service.isScrambled) serviceStats.push('scrambled');
  if (service.hidden) serviceStats.push('hidden');
  if (service.tsid !== undefined) serviceStats.push(`TSID ${hex16(service.tsid)}`);
  if (service.originalNetworkId !== undefined) {
    serviceStats.push(`ONID ${hex16(service.originalNetworkId)}`);
  }
  if (service.ssu) serviceStats.push('SSU');
  if (service.t2mi) serviceStats.push('T2-MI');
  if (service.ewbs) {
    const areas = service.ewbs.areaCodes
      .map((code) => `0x${code.toString(16).padStart(3, '0').toUpperCase()}`)
      .join('/');
    serviceStats.push(
      `EWBS ${service.ewbs.started ? 'active' : 'inactive'} (level ${service.ewbs.signalLevel}${areas ? `, areas ${areas}` : ''})`,
    );
  }
  if (serviceStats.length > 0) lines.push(`      ${serviceStats.join('   ')}`);

  if (service.descriptors.length > 0) {
    lines.push('      Program descriptors:');
    for (const descriptor of service.descriptors) {
      lines.push(`        ${descriptorSummary(descriptor, all)}`);
    }
  }

  if (service.streams.length === 0) {
    lines.push('      No elementary streams announced.');
    return lines;
  }

  lines.push(`      Streams (${service.streams.length})`);
  const rows = service.streams.map((stream) => {
    const joined = stream.descriptors.map((d) => descriptorSummary(d, all)).join('; ');
    const description =
      stream.descriptionDetails !== undefined
        ? `${stream.description} (${stream.descriptionDetails})`
        : stream.description + formatEsDetails(stream.es);
    return [
      hex16(stream.pid),
      stream.streamTypeHex,
      description,
      joined ? truncateDisplay(joined, all ? 0 : 96) : '-',
    ];
  });
  const table = renderTable(
    [{ header: 'PID' }, { header: 'Type' }, { header: 'Description' }, { header: 'Descriptors' }],
    rows,
    '        ',
  );
  lines.push(...table);
  return lines;
}

function formatEvents(events: ProbeEvent[]): string[] {
  const rows = events.map((event) => [
    hex16(event.serviceId),
    String(event.eventId),
    event.startTimeIso ? shortIsoTime(event.startTimeIso) : '-',
    event.durationSec !== undefined ? formatEventDuration(event.durationSec) : '-',
    event.runningStatusName ?? '-',
    truncateDisplay(eventSummary(event), 82),
  ]);

  return renderTable(
    [
      { header: 'Service' },
      { header: 'Event', align: 'right' },
      { header: 'Start (UTC)' },
      { header: 'Duration', align: 'right' },
      { header: 'Status' },
      { header: 'Title / text' },
    ],
    rows,
    '  ',
  );
}

function eventSummary(event: ProbeEvent): string {
  const title = event.name?.trim();
  const text = event.text?.trim();
  const summary = title && text ? `${title} - ${text}` : title || text || '(no title)';
  const meta: string[] = [];
  if (event.languages !== undefined && event.languages.length > 0) {
    meta.push(event.languages.join('/'));
  }
  if (event.content) meta.push(`content ${event.content}`);
  if (event.rating) meta.push(`rating ${event.rating}`);
  return meta.length > 0 ? `${summary} [${meta.join('; ')}]` : summary;
}

function shortIsoTime(iso: string): string {
  if (iso.length < 19) return iso;
  return `${iso.slice(0, 19).replace('T', ' ')}Z`;
}

function formatEventDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Compact table index used by `tsinspect tables`. */
export function formatTableIndexText(result: ProbeResult, options: TextFormatOptions = {}): string {
  const lines: string[] = [];
  lines.push(`tsinspect ${result.tool.version} - MPEG-TS table index`);
  lines.push('');
  lines.push(label('Source', result.source.name));
  lines.push(label('Standard', result.standard.detected));
  lines.push('');
  lines.push(sectionTitle(`TABLES (${result.tables.length})`));
  lines.push(...formatTables(result.tables, options.all ?? false, options.detail ?? false));
  return lines.join('\n');
}

function formatTables(tables: ProbeTable[], all: boolean, detail = false): string[] {
  const visible = all ? tables : tables.filter((table) => table.tableId !== 0xff);
  if (visible.length === 0) return ['  None.'];

  const rows = visible.map((table) => [
    hex16(table.pid),
    table.name,
    table.tableIdHex,
    table.tableIdExtension !== undefined ? hex16(table.tableIdExtension) : '-',
    table.version !== undefined ? String(table.version) : '-',
    table.sectionNumber !== undefined
      ? `${table.sectionNumber}${table.lastSectionNumber !== undefined ? `/${table.lastSectionNumber}` : ''}`
      : '-',
    table.crcValid === undefined ? '-' : table.crcValid ? 'ok' : 'BAD',
    String(table.occurrences),
    String(table.length),
    String(table.firstPacket),
  ]);

  const lines = renderTable(
    [
      { header: 'PID' },
      { header: 'Table' },
      { header: 'ID' },
      { header: 'Ext' },
      { header: 'Ver', align: 'right' },
      { header: 'Sec', align: 'right' },
      { header: 'CRC' },
      { header: 'Occ', align: 'right' },
      { header: 'Bytes', align: 'right' },
      { header: 'Packet', align: 'right' },
    ],
    rows,
    '  ',
  );

  if (detail) {
    const detailed = visible.filter(
      (table) => table.fields !== undefined && Object.keys(table.fields).length > 0,
    );
    lines.push('');
    lines.push('  Details:');
    if (detailed.length === 0) {
      lines.push('    None.');
    } else {
      for (const table of detailed) {
        const fields = Object.entries(table.fields ?? {})
          .map(
            ([key, value]) =>
              `${key}=${
                Array.isArray(value)
                  ? `[${value.length}]`
                  : value !== null && typeof value === 'object'
                    ? '{…}'
                    : String(value)
              }`,
          )
          .join(' ');
        lines.push(`    ${hex16(table.pid)} ${table.tableIdHex} ${table.name}: ${fields}`);
      }
    }
  }

  return lines;
}

function formatPids(pids: ProbePid[], all: boolean): string[] {
  const visible = all ? pids : pids.filter((pid) => pid.pid !== 0x1fff || pids.length === 1);
  if (visible.length === 0) return ['  None.'];

  const rows = visible.map((pid) => [
    hex16(pid.pid),
    pid.kind ?? '-',
    String(pid.packets),
    formatBytes(pid.payloadBytes),
    String(pid.pusi),
    String(pid.tei),
    String(pid.ccErrors),
    String(pid.pcrCount),
    pid.lastCc !== undefined ? String(pid.lastCc) : '-',
  ]);

  return renderTable(
    [
      { header: 'PID' },
      { header: 'Kind' },
      { header: 'Packets', align: 'right' },
      { header: 'Payload', align: 'right' },
      { header: 'PUSI', align: 'right' },
      { header: 'TEI', align: 'right' },
      { header: 'CC err', align: 'right' },
      { header: 'PCR', align: 'right' },
      { header: 'Last CC', align: 'right' },
    ],
    rows,
    '  ',
  );
}

function formatEsDetails(es?: EsMetadata): string {
  if (!es) return '';
  const parts: string[] = [];
  if (es.width !== undefined && es.height !== undefined) parts.push(`${es.width}x${es.height}`);
  if (es.frameRate !== undefined) {
    parts.push(`${Number(es.frameRate.toFixed(2))}fps`);
  }
  if (es.interlaced) parts.push('interlaced');
  if (es.sampleRate !== undefined) parts.push(`${(es.sampleRate / 1000).toFixed(1)}kHz`);
  if (es.channels !== undefined) parts.push(`${es.channels}ch`);
  if (es.bitrateBps !== undefined) parts.push(formatBitrate(es.bitrateBps));
  if (es.profile || es.level) {
    parts.push([es.profile, es.level].filter((value) => value !== undefined).join('/'));
  }
  return parts.length > 0 ? ` [${parts.join(' ')}]` : '';
}

function descriptorSummary(descriptor: DescriptorInfo, all: boolean): string {
  const parts: string[] = [`${descriptor.name} (${descriptor.tagHex})`];
  if (descriptor.fields) {
    for (const [key, value] of Object.entries(descriptor.fields)) {
      const text = String(value);
      parts.push(`${key}=${text.length > 64 ? `${text.slice(0, 61)}...` : text}`);
    }
  }
  if (all) parts.push(`raw=${descriptor.raw}`);
  return parts.join(' ');
}

function serviceTypeName(type: number): string {
  switch (type) {
    case 0x01:
      return 'digital television';
    case 0x02:
      return 'digital radio';
    case 0x03:
      return 'teletext';
    case 0x0c:
      return 'data broadcast';
    case 0x16:
      return 'AVC SD television';
    case 0x19:
      return 'AVC HD television';
    case 0x1f:
      return 'HEVC television';
    case 0xc0:
      return 'ISDB mobile television';
    default:
      return 'unknown';
  }
}

function formatDataBroadcast(data: ProbeDataBroadcast, all: boolean): string[] {
  const lines: string[] = [];
  const totals = [
    data.mpe.length > 0
      ? `${data.mpe.length} MPE session(s), ${data.mpe.reduce((sum, item) => sum + item.datagrams, 0)} datagram(s)`
      : '',
    data.mpeFec.length > 0 ? `${data.mpeFec.length} MPE-FEC PID(s)` : '',
    data.carousels.length > 0
      ? `${data.carousels.length} object carousel(s), ${data.carousels.reduce((sum, item) => sum + item.entries.length, 0)} object(s)`
      : '',
    data.applications.length > 0 ? `${data.applications.length} application(s)` : '',
  ].filter((part) => part.length > 0);
  lines.push(sectionTitle('DATA BROADCAST'));
  lines.push(`  ${totals.length > 0 ? totals.join('; ') : 'None.'}`);
  if (data.mhp || data.hbbtv) {
    lines.push(
      `  Signalling: ${data.mhp ? 'MHP' : ''}${data.mhp && data.hbbtv ? ' / ' : ''}${data.hbbtv ? 'HbbTV' : ''}`,
    );
  }

  for (const carousel of data.carousels) {
    lines.push('');
    lines.push(
      `  PID ${hex16(carousel.pid)}  DSI ${carousel.serverInitiates}  DII ${carousel.downloadInfos}  DDB ${carousel.dataBlocks}  modules ${carousel.modules.length}`,
    );
    const status = [
      `root ${carousel.root ?? '(unresolved)'}`,
      `complete modules ${carousel.completeModules}`,
      carousel.pendingModules > 0 ? `pending ${carousel.pendingModules}` : '',
      carousel.compressedModules > 0 ? `compressed ${carousel.compressedModules}` : '',
      carousel.danglingBindings > 0 ? `dangling ${carousel.danglingBindings}` : '',
      carousel.truncated ? 'truncated' : '',
    ].filter((part) => part.length > 0);
    lines.push(`    ${status.join('  ')}`);
    if (carousel.entries.length === 0) {
      lines.push('    No objects recovered from the sampled module data.');
    }
    const limit = all ? carousel.entries.length : 24;
    for (const entry of carousel.entries.slice(0, limit)) {
      const depth = entry.path === '/' ? 0 : entry.path.split('/').length - 1;
      const name = entry.path === '/' ? '/' : (entry.path.split('/').pop() ?? entry.path);
      const marker = entry.kind === 'directory' ? '+' : entry.kind === 'stream' ? '*' : '-';
      const details: string[] = [];
      if (entry.size !== undefined) details.push(`${entry.size} B`);
      if (entry.contentType !== undefined) details.push(entry.contentType);
      if (!entry.complete && entry.kind === 'file') details.push('incomplete');
      lines.push(
        `    ${'  '.repeat(depth)}${marker} ${name}${details.length > 0 ? `  (${details.join(', ')})` : ''}`,
      );
    }
    if (limit < carousel.entries.length) {
      lines.push(`    ... ${carousel.entries.length - limit} more object(s) (use --all)`);
    }
  }
  return lines;
}

function packetFormatName(format: ProbeResult['packet']['format']): string {
  switch (format) {
    case 'ts':
      return 'TS';
    case 'm2ts':
      return 'M2TS';
    case 'isdb-tb':
      return 'ISDB-Tb TS';
    case 'rs208':
      return 'RS(208) TS';
    default:
      return format;
  }
}

function label(name: string, value: string): string {
  return `${name.padEnd(LABEL_WIDTH)}${value}`;
}

function sectionTitle(title: string): string {
  return `${title}\n${'-'.repeat(title.length)}`;
}

interface Column {
  header: string;
  align?: 'left' | 'right';
}

function renderTable(columns: Column[], rows: string[][], indent: string): string[] {
  const widths = columns.map((column, index) => {
    let width = displayWidth(column.header);
    for (const row of rows) {
      width = Math.max(width, displayWidth(row[index] ?? ''));
    }
    return width;
  });

  const line = (cells: string[]): string => {
    const parts = columns.map((column, index) => {
      const text = cells[index] ?? '';
      return column.align === 'right'
        ? padStartDisplay(text, widths[index]!)
        : padEndDisplay(text, widths[index]!);
    });
    return indent + parts.join('  ').replace(/\s+$/, '');
  };

  const lines = [line(columns.map((column) => column.header))];
  lines.push(indent + widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) lines.push(line(row));
  return lines;
}

function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0) continue;
    if (codePoint >= 0x0300 && codePoint <= 0x036f) continue;
    width += isWide(codePoint) ? 2 : 1;
  }
  return width;
}

function padEndDisplay(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}

function padStartDisplay(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? ' '.repeat(pad) + text : text;
}

function truncateDisplay(text: string, width: number): string {
  if (width <= 0 || displayWidth(text) <= width) return text;
  const ellipsis = '...';
  const limit = width - ellipsis.length;
  let out = '';
  for (const character of text) {
    if (displayWidth(out + character) > limit) break;
    out += character;
  }
  return out + ellipsis;
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (displayWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (displayWidth(word) <= width) {
      current = word;
      continue;
    }
    let chunk = '';
    for (const character of word) {
      if (displayWidth(chunk + character) > width) {
        lines.push(chunk);
        chunk = character;
      } else {
        chunk += character;
      }
    }
    current = chunk;
  }

  if (current) lines.push(current);
  return lines;
}
