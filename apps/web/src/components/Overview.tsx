import { useState } from 'react';
import type { ProbeResult, ProbeService } from '@tsinspect/core';
import { useT, type UiKey } from '../i18n';
import {
  capabilityNames,
  esText,
  formatBitrate,
  formatClockRange,
  formatIsoClock,
  formatOffset,
  hex16,
  streamTitle,
} from '../format';
import { AccessibilityCell, DataTable, DescriptorCell, streamAccessibility } from './shared';

function areaCodeText(codes: number[]): string {
  return (
    codes
      .map((code) => `0x${code.toString(16).padStart(3, '0').toUpperCase()}`)
      .join(', ') || '-'
  );
}

export function Overview({
  result,
  query,
  selectedProgram,
  onSelect,
  onPid,
  onValidation,
  errors,
  warnings,
  healthStatus,
}: {
  result: ProbeResult;
  query: string;
  selectedProgram: number | undefined;
  onSelect: (program: number | undefined) => void;
  onPid: (pid: number) => void;
  onValidation: () => void;
  errors: number;
  warnings: number;
  healthStatus: 'pass' | 'warn' | 'fail';
}) {
  const t = useT();
  const tdtTable = result.tables.find((table) => table.tableId === 0x70);
  const totTable = result.tables.find((table) => table.tableId === 0x73);
  const tdtUtc =
    tdtTable?.fields?.utc !== undefined ? String(tdtTable.fields.utc) : undefined;
  const totUtc =
    totTable?.fields?.utc !== undefined
      ? String(totTable.fields.utc)
      : result.clock?.totIso;
  const totOffset = result.clock?.localTimeOffset;
  const nextOffset = result.clock?.nextLocalTimeOffset;
  const switchOffset = nextOffset ?? totOffset;
  const timeOfChange = result.clock?.timeOfChangeIso;
  const totHint = result.clock
    ? totOffset
      ? timeOfChange
        ? t('overview.totHint', {
            change: formatIsoClock(timeOfChange),
            offset: switchOffset ?? totOffset,
          })
        : t('overview.totHintNoChange', { offset: totOffset })
      : t('overview.totHintNoOffset')
    : t('overview.totHintNoOffset');
  const [accessibilityOnly, setAccessibilityOnly] = useState(false);
  const q = query.trim().toLowerCase();
  const visible = q
    ? result.services.filter(
        (service) =>
          (service.name ?? '').toLowerCase().includes(q) ||
          (service.providerName ?? '').toLowerCase().includes(q) ||
          String(service.programNumber).includes(q) ||
          (service.serviceId !== undefined && hex16(service.serviceId).toLowerCase().includes(q)) ||
          service.streams.some(
            (stream) =>
              String(stream.pid).includes(q) ||
              stream.pidHex.toLowerCase().includes(q) ||
              stream.description.toLowerCase().includes(q) ||
              streamTitle(stream).toLowerCase().includes(q) ||
              stream.descriptors.some(
                (descriptor) =>
                  descriptor.name.toLowerCase().includes(q) ||
                  Object.values(descriptor.fields ?? {}).some((value) =>
                    String(value).toLowerCase().includes(q),
                  ),
              ),
          ),
      )
    : result.services;
  const selected =
    visible.find((service) => service.programNumber === selectedProgram) ?? visible[0];
  const streams = selected
    ? accessibilityOnly
      ? selected.streams.filter((stream) => {
          const traits = streamAccessibility(stream.descriptors);
          return (
            traits.audioDescription ||
            traits.spokenSubtitles ||
            traits.hearingImpaired
          );
        })
      : selected.streams
    : [];
  const caps = capabilityNames(result);
  const infos = result.diagnostics.filter((item) => item.severity === 'info').length;
  const healthLabel = t(`validation.${healthStatus}` as UiKey);

  return (
    <div className="overview-grid">
      <section className="panel service-panel">
        <div className="panel-head">
          <div>
            <h2>{t('overview.services')}</h2>
            <p>{t('overview.serviceHint')}</p>
          </div>
          <span className="count-pill">{visible.length}</span>
        </div>
        <div className="service-list">
          {visible.length === 0 ? (
            <p className="muted small">{t('services.empty')}</p>
          ) : (
            visible.map((service) => (
              <button
                key={service.programNumber}
                className={`service-item ${
                  selected?.programNumber === service.programNumber ? 'active' : ''
                }`}
                onClick={() => onSelect(service.programNumber)}
              >
                <span className="service-name">
                  {service.name || t('services.unnamed')}
                  <span className="service-number">#{service.programNumber}</span>
                </span>
                <span className="service-meta">
                  {service.streams.length} {t('overview.streams')}
                  {service.serviceId !== undefined
                    ? ` · SID ${hex16(service.serviceId)}`
                    : ''}
                </span>
              </button>
            ))
          )}
        </div>
      </section>

      <div className="overview-main">
        <section className="panel detail-panel">
        {selected ? (
          <>
            <div className="detail-head">
              <div>
                <h2>
                  {selected.name || t('services.unnamed')}{' '}
                  <span className="soft-badge">#{selected.programNumber}</span>
                </h2>
                <p className="detail-meta">
                  {[
                    selected.providerName || '',
                    selected.serviceTypeName || '',
                    `PMT ${hex16(selected.pmtPid)}`,
                    selected.pcrPid !== undefined ? `PCR ${hex16(selected.pcrPid)}` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <div className="subtitle-meta service-stats">
                  {selected.bitrateBps !== undefined ? (
                    <span className="cap-badge">
                      {t('stats.bitrate', { value: formatBitrate(selected.bitrateBps) })}
                    </span>
                  ) : null}
                  {selected.packets !== undefined ? (
                    <span className="cap-badge">
                      {t('stats.packets', { count: selected.packets.toLocaleString() })}
                    </span>
                  ) : null}
                  {selected.pids !== undefined ? (
                    <span className="cap-badge">
                      {t('stats.pids', { count: selected.pids.length })}
                    </span>
                  ) : null}
                  {selected.components !== undefined ? (
                    <span
                      className={`cap-badge ${selected.isScrambled ? 'warning' : ''}`}
                    >
                      {t('stats.components', {
                        clear: selected.components.clear,
                        scrambled: selected.components.scrambled,
                      })}
                    </span>
                  ) : null}
                  {selected.isScrambled ? (
                    <span className="cap-badge warning">{t('stats.scrambled')}</span>
                  ) : null}
                  {selected.hidden ? (
                    <span className="cap-badge warning">{t('stats.hidden')}</span>
                  ) : null}
                  {selected.tsid !== undefined ? (
                    <span className="cap-badge">
                      {t('stats.tsid', { value: hex16(selected.tsid) })}
                    </span>
                  ) : null}
                  {selected.originalNetworkId !== undefined ? (
                    <span className="cap-badge">
                      {t('stats.onid', { value: hex16(selected.originalNetworkId) })}
                    </span>
                  ) : null}
                  {selected.conditionalAccess ? (
                    <span className="cap-badge warning">
                      {t('stats.ca', {
                        systems: selected.conditionalAccess.systems
                          .map((system) => String(system))
                          .join(', '),
                        ecm: selected.conditionalAccess.ecmPids
                          .map((pid) => hex16(pid))
                          .join(', ') || '-',
                        emm: selected.conditionalAccess.emmPids
                          .map((pid) => hex16(pid))
                          .join(', ') || '-',
                      })}
                    </span>
                  ) : null}
                  {selected.epg ? (
                    <span className="cap-badge">
                      {t('stats.epg', {
                        days: selected.epg.days,
                        events: selected.epg.events,
                      })}
                    </span>
                  ) : null}
                  {selected.ssu ? (
                    <span className="cap-badge">{t('stats.ssu')}</span>
                  ) : null}
                  {selected.t2mi ? (
                    <span className="cap-badge">{t('stats.t2mi')}</span>
                  ) : null}
                  {selected.ewbs ? (
                    <span className={`cap-badge ${selected.ewbs.started ? 'warning' : ''}`}>
                      {t('stats.ewbs', {
                        state: t(
                          selected.ewbs.started ? 'overview.ewbsActive' : 'overview.ewbsIdle',
                        ),
                        level: selected.ewbs.signalLevel,
                        areas: areaCodeText(selected.ewbs.areaCodes),
                      })}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
            {streams.length === 0 ? (
              <p className="muted small">
                {accessibilityOnly
                  ? t('overview.noAccessibleStreams')
                  : t('overview.noStreams')}
              </p>
            ) : (
              <DataTable<ProbeService['streams'][number]>
                storageKey="streams"
                rows={streams}
                rowKey={(stream) => stream.pid}
                initialSort={{ key: 'pid', dir: 'asc' }}
                toolbar={
                  <div className="stream-toolbar">
                    <span className="muted small">
                      {streams.length} {t('overview.streams')}
                    </span>
                    <label className="inline-check">
                      <input
                        type="checkbox"
                        checked={accessibilityOnly}
                        onChange={(event) => setAccessibilityOnly(event.target.checked)}
                      />
                      {t('overview.accessibilityOnly')}
                    </label>
                  </div>
                }
                columns={[
                  {
                    key: 'pid',
                    label: 'PID',
                    render: (stream) => <span className="mono">{hex16(stream.pid)}</span>,
                    sortValue: (stream) => stream.pid,
                  },
                  {
                    key: 'description',
                    label: t('services.description'),
                    render: (stream) => (
                      <div className="stream-description">
                        <span className={`kind-badge ${stream.es?.kind ?? 'unknown'}`}>
                          {t(`stream.${stream.es?.kind ?? 'unknown'}` as UiKey)}
                        </span>
                        <span>{streamTitle(stream)}</span>
                      </div>
                    ),
                    sortValue: (stream) => streamTitle(stream),
                  },
                  {
                    key: 'es',
                    label: t('services.es'),
                    render: (stream) => (
                      <span className="muted small">{esText(stream, t) || '—'}</span>
                    ),
                    sortValue: (stream) => esText(stream, t),
                  },
                  {
                    key: 'accessibility',
                    label: t('services.accessibility'),
                    render: (stream) => (
                      <AccessibilityCell
                        descriptors={stream.descriptors}
                        kind={stream.es?.kind}
                      />
                    ),
                  },
                  {
                    key: 'descriptors',
                    label: t('services.descriptors'),
                    render: (stream) => <DescriptorCell descriptors={stream.descriptors} />,
                  },
                  {
                    key: 'action',
                    label: '',
                    align: 'num',
                    render: (stream) => (
                      <button className="ghost tiny" onClick={() => onPid(stream.pid)}>
                        {t('overview.viewPid')}
                      </button>
                    ),
                  },
                ]}
              />
            )}
          </>
        ) : (
          <p className="muted">{t('services.empty')}</p>
        )}
      </section>

      <aside className="panel health-panel">
        <div className="health-summary">
          <div className="panel-head">
            <h2>{t('overview.health')}</h2>
          </div>
          <div className={`health-block ${healthStatus}`}>
            <strong>{healthLabel}</strong>
            <span>{t('validation.errors')} {errors} · {t('validation.warnings')} {warnings} · {t('validation.infos')} {infos}</span>
          </div>
          <button className="ghost full" onClick={onValidation}>
            {t('overview.viewValidation')} →
          </button>
        </div>
        <div className="health-section">
          <div className="panel-label">{t('overview.capabilities')}</div>
          <div className="cap-list">
            {caps.length > 0 ? (
              caps.map((cap) => (
                <span className="cap-badge" key={cap}>
                  {cap}
                </span>
              ))
            ) : (
              <span className="muted small">{t('overview.noCapabilities')}</span>
            )}
          </div>
        </div>
        <div className="health-section">
          <div className="panel-label">{t('overview.time')}</div>
          {result.clock ? (
            <div className="clock-info">
              <div>
                <span className="muted">{t('overview.clockSource')}</span>{' '}
                {result.clock.source}
              </div>
              {result.clock.utcIso ? (
                <div className="clock-tip" title={t('overview.utcHint')}>
                  <span className="muted">{t('overview.utc')}</span>{' '}
                  {formatIsoClock(result.clock.utcIso)}
                </div>
              ) : null}
              {tdtUtc ? (
                <div className="clock-tip" title={t('overview.tdtHint')}>
                  <span className="muted">{t('overview.tdt')}</span>{' '}
                  {formatIsoClock(tdtUtc)}
                </div>
              ) : null}
              {totUtc ? (
                <div className="clock-tip" title={totHint}>
                  <span className="muted">{t('overview.tot')}</span>{' '}
                  {formatIsoClock(totUtc)}
                </div>
              ) : null}
              {timeOfChange ? (
                <div className="clock-tip" title={totHint}>
                  <span className="muted">{t('overview.timeChange')}</span>{' '}
                  {formatIsoClock(timeOfChange)} UTC → {switchOffset ?? '-'}
                </div>
              ) : null}
              {result.clock.utcFirstIso &&
              result.clock.utcLastIso &&
              result.clock.utcFirstIso !== result.clock.utcLastIso ? (
                <div>
                  <span className="muted">{t('overview.range')}</span>{' '}
                  {formatClockRange(result.clock.utcFirstIso, result.clock.utcLastIso)}
                </div>
              ) : null}
              {result.clock.localFirstIso && result.clock.localLastIso ? (
                <div>
                  <span className="muted">{t('overview.local')}</span>{' '}
                  {formatClockRange(result.clock.localFirstIso, result.clock.localLastIso)}
                </div>
              ) : null}
              {result.clock.localOffsetSec !== undefined ? (
                <div className="clock-tip" title={totHint}>
                  <span className="muted">{t('overview.localOffset')}</span>{' '}
                  {formatOffset(result.clock.localOffsetSec)}
                </div>
              ) : null}
              {result.clock.countryCode ? (
                <div>
                  <span className="muted">{t('overview.country')}</span>{' '}
                  {result.clock.countryCode}
                </div>
              ) : null}
              {result.clock.gpsUtcOffset !== undefined ? (
                <div>
                  <span className="muted">{t('overview.gpsOffset')}</span>{' '}
                  {result.clock.gpsUtcOffset}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="muted small">{t('overview.noClock')}</p>
          )}
        </div>
        {result.conditionalAccess ? (
          <div className="health-section">
            <div className="panel-label">{t('overview.ca')}</div>
            <div className="clock-info">
              <div>
                {t('overview.caLine', {
                  systems:
                    result.conditionalAccess.systems
                      .map((entry) => String(entry.caSystemId))
                      .join(', ') || '-',
                  ecm:
                    result.conditionalAccess.ecmPids
                      .map((pid) => hex16(pid))
                      .join(', ') || '-',
                  emm:
                    result.conditionalAccess.emmPids
                      .map((pid) => hex16(pid))
                      .join(', ') || '-',
                })}
              </div>
              {result.conditionalAccess.catPid !== undefined ? (
                <div>
                  {t('overview.cat', {
                    pid: hex16(result.conditionalAccess.catPid),
                    version: result.conditionalAccess.catVersion ?? '-',
                  })}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {result.t2mi ? (
          <div className="health-section">
            <div className="panel-label">{t('overview.t2mi')}</div>
            <div className="clock-info">
              <div>
                {t('overview.t2miLine', {
                  pid: hex16(result.t2mi.pid),
                  packets: result.t2mi.packets,
                  ts: result.t2mi.tsPackets,
                })}
              </div>
              {result.t2mi.types.length > 0 ? (
                <div>
                  {t('overview.t2miTypes', {
                    value: result.t2mi.types
                      .map((entry) => `${entry.name}:${entry.packets}`)
                      .join(', '),
                  })}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {result.emergency ? (
          <div className="health-section">
            <div className="panel-label">{t('overview.emergency')}</div>
            <div className="clock-info">
              {result.emergency.eas?.map((alert) => (
                <div key={`${alert.pid}-${alert.eventId}-${alert.eventCode}`}>
                  <div>
                    {t('overview.easLine', {
                      code: alert.eventCode || '-',
                      originator: alert.originatorCode || '-',
                      priority: alert.priority,
                      remaining: alert.timeRemainingSec,
                    })}
                  </div>
                  <div className="muted small">
                    {t('overview.easDetails', {
                      start: alert.startTimeIso ?? '-',
                      duration: alert.durationSec,
                      areas: alert.locations.length,
                      exceptions: alert.exceptionCount,
                    })}
                  </div>
                  {alert.alertText ? (
                    <div className="muted small">{alert.alertText}</div>
                  ) : null}
                </div>
              ))}
              {result.emergency.ewbs ? (
                <div>
                  {t('overview.ewbsLine', {
                    state: t(
                      result.emergency.ewbs.activated
                        ? 'overview.ewbsActive'
                        : 'overview.ewbsIdle',
                    ),
                    services: result.emergency.ewbs.services.length,
                  })}
                  {result.emergency.ewbs.services.map((service) => (
                    <div className="muted small" key={service.serviceId}>
                      {t('overview.ewbsServiceLine', {
                        service: service.serviceId,
                        level: service.signalLevel,
                        areas: areaCodeText(service.areaCodes),
                      })}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {result.isdb ? (
          <div className="health-section">
            <div className="panel-label">{t('overview.isdb')}</div>
            <div className="clock-info">
              <div>{t('overview.trailer', { count: result.isdb.trailerPackets })}</div>
              {result.isdb.layers.length > 0 ? (
                <div>
                  {t('overview.layers', {
                    value: result.isdb.layers
                      .map((entry) => `${entry.layer}:${entry.packets.toLocaleString()}`)
                      .join(', '),
                  })}
                </div>
              ) : null}
              {result.isdb.iipPid !== undefined ? (
                <div>
                  {t('overview.iip', {
                    value: hex16(result.isdb.iipPid),
                    count: result.isdb.iipPackets,
                  })}
                </div>
              ) : null}
              {result.isdb.tmccIdentifiers !== undefined &&
              result.isdb.tmccIdentifiers.length > 0 ? (
                <div>
                  {t('overview.isdbTmcc', {
                    value: result.isdb.tmccIdentifiers.join(', '),
                  })}
                </div>
              ) : null}
              {result.isdb.partialReception ? (
                <div>
                  {t('overview.isdbPartial', {
                    start: hex16(result.isdb.partialReception.startServiceId),
                    end: hex16(result.isdb.partialReception.endServiceId),
                  })}
                </div>
              ) : null}
              {result.isdb.emergencyControlPackets > 0 ? (
                <div>
                  {t('overview.isdbEmergency', {
                    count: result.isdb.emergencyControlPackets,
                  })}
                </div>
              ) : null}
              {result.isdb.country ? (
                <div>
                  <span className="muted">{t('overview.country')}</span>{' '}
                  {result.isdb.country}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </aside>
      </div>
    </div>
  );
}
