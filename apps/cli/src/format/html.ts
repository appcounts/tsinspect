import type { EsMetadata, ProbeResult } from '@tsinspect/core';
import { formatBitrate, formatBytes, formatDuration, hex16 } from '@tsinspect/core';

export interface HtmlFormatOptions {
  all?: boolean;
}

/**
 * Render a standalone report: no external assets, no network access, and JSON
 * embedded for downstream tooling.
 */
export function formatProbeHtml(result: ProbeResult, options: HtmlFormatOptions = {}): string {
  const all = options.all ?? false;
  const title = `tsinspect report - ${result.source.name}`;
  const transport = result.transport;

  const summaryRows: Array<[string, string]> = [
    ['Source', escapeHtml(result.source.name)],
    ['Input', escapeHtml(sourceSummary(result))],
    [
      'Packets',
      `${result.packet.size}-byte ${escapeHtml(result.packet.format)}, sync +${result.packet.syncOffset}, ` +
        `${result.transport.packetCount.toLocaleString('en-US')} packet(s)`,
    ],
    [
      'Standard',
      `<strong>${escapeHtml(result.standard.detected)}</strong> (${Math.round(
        result.standard.confidence * 100,
      )}% confidence)`,
    ],
  ];
  if (transport.tsid !== undefined) summaryRows.push(['Transport stream', hex16(transport.tsid)]);
  if (transport.networkId !== undefined) summaryRows.push(['Network', hex16(transport.networkId)]);
  if (transport.networkName) summaryRows.push(['Network name', escapeHtml(transport.networkName)]);
  if (transport.country) summaryRows.push(['Country', escapeHtml(transport.country)]);
  if (transport.networkPid !== undefined) {
    summaryRows.push(['NIT PID', hex16(transport.networkPid)]);
  }
  if (transport.pcrPid !== undefined) summaryRows.push(['PCR PID', hex16(transport.pcrPid)]);
  if (transport.durationSec !== undefined) {
    summaryRows.push(['Duration', formatDuration(transport.durationSec)]);
  }
  if (transport.bitrateBps !== undefined) {
    summaryRows.push(['Bitrate', formatBitrate(transport.bitrateBps)]);
    summaryRows.push(['Bitrate (204)', formatBitrate((transport.bitrateBps * 204) / 188)]);
  }
  if (result.clock) {
    const clock = result.clock;
    const clockParts: string[] = [];
    if (clock.utcIso) clockParts.push(`UTC ${clock.utcIso}`);
    if (clock.utcFirstIso && clock.utcLastIso && clock.utcFirstIso !== clock.utcLastIso) {
      clockParts.push(`range ${clock.utcFirstIso} .. ${clock.utcLastIso}`);
    }
    if (clock.localFirstIso && clock.localLastIso) {
      clockParts.push(`local ${clock.localFirstIso} .. ${clock.localLastIso}`);
    }
    if (clock.countryCode) clockParts.push(`country ${clock.countryCode}`);
    clockParts.push(
      `${clock.source}${clock.gpsUtcOffset !== undefined ? `, GPS-UTC ${clock.gpsUtcOffset}s` : ''}`,
    );
    summaryRows.push(['Clock', escapeHtml(clockParts.join(', '))]);
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
      `CA ${result.capabilities.caSystems
        .map((id) => `0x${id.toString(16).padStart(4, '0').toUpperCase()}`)
        .join('/')}`,
    );
  }
  summaryRows.push([
    'Capabilities',
    escapeHtml(caps.length > 0 ? caps.join(', ') : 'none detected'),
  ]);

  if (result.isdb) {
    const layers = result.isdb.layers
      .map((entry) => `layer ${entry.layer}=${entry.packets}`)
      .join(', ');
    const iip =
      result.isdb.iipPid !== undefined
        ? `, IIP PID ${hex16(result.isdb.iipPid)} (${result.isdb.iipPackets} packet(s))`
        : '';
    summaryRows.push([
      'ISDB-Tb',
      escapeHtml(
        `${result.isdb.trailerPackets} trailer packet(s)${layers ? `, ${layers}` : ''}${iip}${
          result.isdb.country ? `, country ${result.isdb.country}` : ''
        }`,
      ),
    ]);
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
    if (parts.length > 0) {
      summaryRows.push(['Emergency', escapeHtml(parts.join('; '))]);
    }
  }

  const services = result.services.map((service) => {
    const streams = service.streams
      .map(
        (stream) => `<tr>
          <td class="mono">${hex16(stream.pid)}</td>
          <td class="mono">${escapeHtml(stream.streamTypeHex)}</td>
          <td>${escapeHtml(stream.description)}${
            stream.descriptionDetails
              ? `<br><span class="muted">${escapeHtml(stream.descriptionDetails)}</span>`
              : stream.es
                ? `<br><span class="muted">${escapeHtml(esDetails(stream.es))}</span>`
                : ''
          }</td>
          <td>${descriptorList(stream.descriptors, all)}</td>
        </tr>`,
      )
      .join('');

    const meta: string[] = [];
    if (service.providerName) meta.push(`Provider ${escapeHtml(service.providerName)}`);
    if (service.serviceId !== undefined) meta.push(`Service ID ${hex16(service.serviceId)}`);
    if (service.serviceType !== undefined) {
      const typeName = service.serviceTypeName ?? serviceTypeName(service.serviceType);
      meta.push(`Type ${service.serviceType} (${escapeHtml(typeName)})`);
    } else if (service.serviceTypeName) {
      meta.push(`Type ${escapeHtml(service.serviceTypeName)}`);
    }
    if (service.sourceId !== undefined && service.sourceId !== service.serviceId) {
      meta.push(`Source ID ${hex16(service.sourceId)}`);
    }
    if (service.majorChannelNumber !== undefined) {
      meta.push(`Channel ${service.majorChannelNumber}.${service.minorChannelNumber ?? 0}`);
    }
    if (service.channelTsid !== undefined) meta.push(`Channel TSID ${hex16(service.channelTsid)}`);
    if (service.modulationMode !== undefined) {
      meta.push(`Modulation ${hex16(service.modulationMode)}`);
    }
    meta.push(`PMT PID ${hex16(service.pmtPid)}`);
    if (service.pcrPid !== undefined) meta.push(`PCR PID ${hex16(service.pcrPid)}`);
    if (service.bitrateBps !== undefined) {
      meta.push(`Bitrate ${formatBitrate(service.bitrateBps)}`);
    }
    if (service.bitrate204Bps !== undefined) {
      meta.push(`Bitrate-204 ${formatBitrate(service.bitrate204Bps)}`);
    }
    if (service.packets !== undefined) {
      meta.push(`${service.packets.toLocaleString('en-US')} packets`);
    }
    if (service.pids !== undefined && service.pids.length > 0) {
      meta.push(`PIDs ${service.pids.map((pid) => hex16(pid)).join(', ')}`);
    }
    if (service.components !== undefined) {
      meta.push(
        `Components ${service.components.clear} clear / ${service.components.scrambled} scrambled`,
      );
    }
    if (service.isScrambled) meta.push('Scrambled');
    if (service.hidden) meta.push('Hidden');
    if (service.tsid !== undefined) meta.push(`TSID ${hex16(service.tsid)}`);
    if (service.originalNetworkId !== undefined) {
      meta.push(`ONID ${hex16(service.originalNetworkId)}`);
    }
    if (service.ssu) meta.push('SSU');
    if (service.t2mi) meta.push('T2-MI');
    if (service.ewbs) {
      const areas = service.ewbs.areaCodes
        .map((code) => `0x${code.toString(16).padStart(3, '0').toUpperCase()}`)
        .join('/');
      meta.push(
        `EWBS ${service.ewbs.started ? 'active' : 'inactive'} (level ${service.ewbs.signalLevel}${areas ? `, areas ${areas}` : ''})`,
      );
    }

    return `<section class="service">
      <h3>Program ${service.programNumber}${service.name ? ` - ${escapeHtml(service.name)}` : ''}${
        service.majorChannelNumber !== undefined
          ? ` <span class="muted">(channel ${service.majorChannelNumber}.${service.minorChannelNumber ?? 0})</span>`
          : ''
      }</h3>
      <p class="muted">${meta.join(' &middot; ')}</p>
      ${service.descriptors.length > 0 ? `<p class="muted">Program descriptors: ${descriptorList(service.descriptors, all)}</p>` : ''}
      ${
        streams
          ? `<table><thead><tr><th>PID</th><th>Type</th><th>Description</th><th>Descriptors</th></tr></thead><tbody>${streams}</tbody></table>`
          : '<p class="muted">No elementary streams announced.</p>'
      }
    </section>`;
  });

  const ratingRegionSections = (result.ratings ?? [])
    .map((region) => {
      const dimensionRows = region.dimensions
        .map(
          (dimension) => `<tr>
        <th>${escapeHtml(dimension.name || '(unnamed)')}</th>
        <td>${dimension.graduatedScale ? 'graduated' : 'litteral'}</td>
        <td>${
          dimension.values
            .map(
              (value) =>
                `${value.abbrev ? `<strong>${escapeHtml(value.abbrev)}</strong> ` : ''}${escapeHtml(value.text)}`,
            )
            .join('<br>') || '-'
        }</td>
      </tr>`,
        )
        .join('');
      return `<section class="service">
      <h3>RRT${region.ratingRegion}${region.name ? ` - ${escapeHtml(region.name)}` : ''}</h3>
      <p class="muted">Protocol ${region.protocolVersion} &middot; ${region.dimensions.length} dimension(s)${
        region.descriptors.length > 0 ? ` &middot; ${descriptorList(region.descriptors, all)}` : ''
      }</p>
      <table><thead><tr><th>Dimension</th><th>Scale</th><th>Rating values</th></tr></thead><tbody>${dimensionRows}</tbody></table>
    </section>`;
    })
    .join('');

  const eventRows = result.events
    .map(
      (event) => `<tr>
        <td class="mono">${hex16(event.serviceId)}</td>
        <td class="num">${event.eventId}</td>
        <td class="mono">${event.startTimeIso ? escapeHtml(formatEventTime(event.startTimeIso)) : '-'}</td>
        <td class="num">${event.durationSec !== undefined ? escapeHtml(formatEventDuration(event.durationSec)) : '-'}</td>
        <td>${escapeHtml(event.runningStatusName ?? '-')}</td>
        <td><strong>${escapeHtml(event.name ?? '')}</strong>${
          event.text ? `<br><span class="muted">${escapeHtml(event.text)}</span>` : ''
        }${
          event.languages?.length || event.content || event.rating
            ? `<br><span class="muted">${escapeHtml(
                [
                  ...(event.languages?.length ? [event.languages.join('/')] : []),
                  ...(event.content ? [`content ${event.content}`] : []),
                  ...(event.rating ? [`rating ${event.rating}`] : []),
                ].join(' · '),
              )}</span>`
            : ''
        }</td>
      </tr>`,
    )
    .join('');

  const tableRows = result.tables
    .map(
      (table) => `<tr>
        <td class="mono">${hex16(table.pid)}</td>
        <td>${escapeHtml(table.name)}</td>
        <td class="mono">${escapeHtml(table.tableIdHex)}</td>
        <td class="mono">${table.tableIdExtension !== undefined ? hex16(table.tableIdExtension) : '-'}</td>
        <td class="num">${table.version ?? '-'}</td>
        <td class="num">${
          table.sectionNumber !== undefined
            ? `${table.sectionNumber}/${table.lastSectionNumber ?? '-'}`
            : '-'
        }</td>
        <td>${table.crcValid === undefined ? '-' : table.crcValid ? '<span class="ok">ok</span>' : '<span class="bad">BAD</span>'}</td>
        <td class="num">${table.occurrences}</td>
        <td class="num">${table.length}</td>
        <td class="num">${table.firstPacket}</td>
      </tr>`,
    )
    .join('');

  const pidRows = result.pids
    .map(
      (pid) => `<tr>
        <td class="mono">${hex16(pid.pid)}</td>
        <td>${escapeHtml(pid.kind ?? '-')}</td>
        <td class="num">${pid.packets}</td>
        <td class="num">${formatBytes(pid.payloadBytes)}</td>
        <td class="num">${pid.pusi}</td>
        <td class="num">${pid.tei}</td>
        <td class="num">${pid.ccErrors}</td>
        <td class="num">${pid.pcrCount}</td>
      </tr>`,
    )
    .join('');

  const diagnosticRows = result.diagnostics
    .map(
      (diagnostic) => `<tr class="diag-${diagnostic.severity}">
        <td><span class="badge ${diagnostic.severity}">${diagnostic.severity}</span></td>
        <td class="mono">${escapeHtml(diagnostic.code)}</td>
        <td>${escapeHtml(diagnostic.message)}</td>
        <td class="mono">${diagnostic.pid !== undefined ? hex16(diagnostic.pid) : '-'}</td>
        <td class="num">${diagnostic.packet ?? '-'}</td>
      </tr>`,
    )
    .join('');

  const evidence = result.standard.evidence.length
    ? `<ul class="evidence">${result.standard.evidence
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join('')}</ul>`
    : '';

  const embeddedJson = JSON.stringify(result, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1b1b1f;
  --muted: #62626b;
  --border: #d9d9e0;
  --accent: #0b5fff;
  --ok: #0a7a33;
  --warn: #9a5b00;
  --err: #b00020;
  --card: #f6f6f9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151519;
    --fg: #ececf1;
    --muted: #a0a0aa;
    --border: #34343d;
    --accent: #6ea0ff;
    --ok: #58d68d;
    --warn: #f0b35a;
    --err: #ff7b86;
    --card: #1e1e25;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2rem 1.25rem 4rem;
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.15rem; margin: 2.25rem 0 .75rem; }
h3 { font-size: 1rem; margin: 1.25rem 0 .35rem; }
p { margin: .35rem 0; }
.muted { color: var(--muted); }
.mono, code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
table { width: 100%; border-collapse: collapse; margin: .5rem 0 1rem; font-size: 13px; }
th, td { padding: .4rem .55rem; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
th { font-weight: 600; background: var(--card); white-space: nowrap; }
section.service { border: 1px solid var(--border); border-radius: 8px; padding: .35rem 1rem .75rem; margin: 1rem 0; }
.cards { display: flex; flex-wrap: wrap; gap: .75rem; margin: 1.25rem 0; }
.card { flex: 1 1 140px; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: .7rem .85rem; }
.card .value { font-size: 1.5rem; font-weight: 650; }
.card .name { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.badge { display: inline-block; padding: .05rem .45rem; border-radius: 999px; font-size: 11px; text-transform: uppercase; font-weight: 600; }
.badge.info { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); }
.badge.warning { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
.badge.error { background: color-mix(in srgb, var(--err) 18%, transparent); color: var(--err); }
.ok { color: var(--ok); }
.bad { color: var(--err); font-weight: 600; }
.evidence { margin: .25rem 0 0; padding-left: 1.25rem; color: var(--muted); }
details { margin-top: 2rem; }
summary { cursor: pointer; color: var(--muted); }
pre { overflow-x: auto; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: .75rem; font-size: 12px; }
footer { margin-top: 3rem; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(result.source.name)}</h1>
  <p class="muted">MPEG-TS transport stream probe report &middot; tsinspect ${escapeHtml(
    result.tool.version,
  )}</p>

  <div class="cards">
    <div class="card"><div class="name">Packets</div><div class="value">${result.transport.packetCount.toLocaleString(
      'en-US',
    )}</div></div>
    <div class="card"><div class="name">Services</div><div class="value">${result.services.length}</div></div>
    <div class="card"><div class="name">PIDs</div><div class="value">${result.pids.length}</div></div>
    <div class="card"><div class="name">Tables</div><div class="value">${result.tables.length}</div></div>
    <div class="card"><div class="name">EPG events</div><div class="value">${result.events.length}</div></div>
    <div class="card"><div class="name">Diagnostics</div><div class="value">${result.diagnostics.length}</div></div>
  </div>

  <table class="summary">
    <tbody>
      ${summaryRows.map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${value}</td></tr>`).join('')}
    </tbody>
  </table>
  ${evidence}

  <h2>Services</h2>
  ${services.length > 0 ? services.join('') : '<p class="muted">No services found.</p>'}

  ${ratingRegionSections.length > 0 ? `<h2>ATSC rating regions</h2>${ratingRegionSections}` : ''}

  <h2>EPG</h2>
  ${
    result.events.length > 0
      ? `<table><thead><tr><th>Service</th><th>Event</th><th>Start (UTC)</th><th>Duration</th><th>Status</th><th>Title / text</th></tr></thead><tbody>${eventRows}</tbody></table>`
      : '<p class="muted">No events found.</p>'
  }

  <h2>Tables</h2>
  ${
    result.tables.length > 0
      ? `<table><thead><tr><th>PID</th><th>Table</th><th>ID</th><th>Ext</th><th>Ver</th><th>Sec</th><th>CRC</th><th>Occ</th><th>Bytes</th><th>Packet</th></tr></thead><tbody>${tableRows}</tbody></table>`
      : '<p class="muted">No PSI/SI sections found.</p>'
  }

  <h2>PIDs</h2>
  ${
    result.pids.length > 0
      ? `<table><thead><tr><th>PID</th><th>Kind</th><th>Packets</th><th>Payload</th><th>PUSI</th><th>TEI</th><th>CC err</th><th>PCR</th></tr></thead><tbody>${pidRows}</tbody></table>`
      : '<p class="muted">No packets.</p>'
  }

  <h2>Diagnostics</h2>
  ${
    result.diagnostics.length > 0
      ? `<table><thead><tr><th>Severity</th><th>Code</th><th>Message</th><th>PID</th><th>Packet</th></tr></thead><tbody>${diagnosticRows}</tbody></table>`
      : '<p class="muted">None.</p>'
  }

  <details>
    <summary>Machine-readable JSON</summary>
    <pre>${escapeHtml(embeddedJson)}</pre>
  </details>

  <footer>Generated by tsinspect ${escapeHtml(result.tool.version)}. Analysis scope: ${
    result.source.full ? 'full source' : 'sampled source'
  }.</footer>
</main>
</body>
</html>
`;
}

function sourceSummary(result: ProbeResult): string {
  const parts: string[] = [result.source.kind];
  parts.push(`${formatBytes(result.source.sampledBytes)} sampled`);
  if (result.source.size !== undefined) parts.push(`${formatBytes(result.source.size)} total`);
  if (!result.source.full) parts.push('partial scan');
  return parts.join(', ');
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

function formatEventTime(iso: string): string {
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

function descriptorList(
  descriptors: ProbeResult['services'][number]['descriptors'],
  all: boolean,
): string {
  if (descriptors.length === 0) return '-';
  return descriptors
    .map((descriptor) => {
      const fields = descriptor.fields
        ? Object.entries(descriptor.fields)
            .map(([key, value]) => `${key}=${escapeHtml(String(value))}`)
            .join(' ')
        : '';
      const raw = all ? ` raw=${escapeHtml(descriptor.raw)}` : '';
      return `<span class="mono">${escapeHtml(descriptor.name)} (${escapeHtml(
        descriptor.tagHex,
      )})</span>${fields ? ` <span class="muted">${fields}</span>` : ''}${raw}`;
    })
    .join('<br>');
}

function esDetails(es: EsMetadata): string {
  const parts: string[] = [];
  if (es.width !== undefined && es.height !== undefined) parts.push(`${es.width}x${es.height}`);
  if (es.frameRate !== undefined) parts.push(`${Number(es.frameRate.toFixed(2))}fps`);
  if (es.interlaced) parts.push('interlaced');
  if (es.sampleRate !== undefined) parts.push(`${(es.sampleRate / 1000).toFixed(1)}kHz`);
  if (es.channels !== undefined) parts.push(`${es.channels}ch`);
  if (es.bitrateBps !== undefined) parts.push(formatBitrate(es.bitrateBps));
  if (es.profile || es.level) {
    parts.push([es.profile, es.level].filter((value) => value !== undefined).join('/'));
  }
  return parts.join(' ');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
