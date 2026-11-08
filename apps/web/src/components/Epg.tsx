import { useEffect, useState, type ReactNode } from 'react';
import type { ProbeEvent, ProbeRatingRegion, ProbeResult } from '@tsinspect/core';
import { useT } from '../i18n';
import {
  formatDuration,
  formatIsoClock,
  formatIsoMinute,
  hex16,
  humanizeField,
  languageLabel,
  readableLanguages,
} from '../format';
import { DataTable } from './shared';

export function Epg({ result, query }: { result: ProbeResult; query: string }) {
  const t = useT();
  const [selectedGroup, setSelectedGroup] = useState<string | undefined>(undefined);
  const [detailEvent, setDetailEvent] = useState<ProbeEvent | null>(null);
  const [sourceFilter, setSourceFilter] = useState<'all' | 'present-following' | 'schedule'>(
    'all',
  );
  const ratings = result.ratings ?? [];

  if (result.events.length === 0) {
    return (
      <>
        <section className="panel page-panel">
          <p className="muted">{t('epg.none')}</p>
        </section>
        <Ratings regions={ratings} defaultOpen />
      </>
    );
  }

  const matchesSource = (event: ProbeEvent): boolean =>
    sourceFilter === 'all' ||
    (sourceFilter === 'present-following'
      ? event.sources?.includes('present-following') === true
      : event.sources?.includes('schedule') === true);
  const sourceCounts = {
    all: result.events.length,
    presentFollowing: result.events.filter((event) =>
      event.sources?.includes('present-following'),
    ).length,
    schedule: result.events.filter((event) => event.sources?.includes('schedule')).length,
  };
  const filteredEvents = result.events.filter(matchesSource);

  const groups: Array<{
    id: string;
    name: string;
    programNumber?: number;
    serviceId?: number;
    events: ProbeEvent[];
  }> = result.services.map((service) => ({
    id: service.serviceId !== undefined ? `sid:${service.serviceId}` : `prog:${service.programNumber}`,
    name: service.name || t('services.unnamed'),
    programNumber: service.programNumber,
    serviceId: service.serviceId,
    events: filteredEvents.filter(
      (event) => service.serviceId !== undefined && event.serviceId === service.serviceId,
    ),
  }));
  const knownServiceIds = new Set(
    result.services
      .map((service) => service.serviceId)
      .filter((serviceId): serviceId is number => serviceId !== undefined),
  );
  const unmatched = filteredEvents.filter((event) => !knownServiceIds.has(event.serviceId));
  if (unmatched.length > 0) {
    groups.push({
      id: 'other',
      name: t('epg.other'),
      programNumber: undefined,
      serviceId: undefined,
      events: unmatched,
    });
  }

  const q = query.trim().toLowerCase();
  const matchesEvent = (event: ProbeEvent): boolean =>
    String(event.eventId).includes(q) ||
    (event.name ?? '').toLowerCase().includes(q) ||
    (event.text ?? '').toLowerCase().includes(q) ||
    (event.content ?? '').toLowerCase().includes(q) ||
    (event.rating ?? '').toLowerCase().includes(q) ||
    (event.languages ?? []).join('/').toLowerCase().includes(q);

  const visibleGroups = groups
    .map((group) => {
      const groupMatches =
        (group.name ?? '').toLowerCase().includes(q) ||
        String(group.programNumber ?? '').includes(q) ||
        (group.serviceId !== undefined && hex16(group.serviceId).toLowerCase().includes(q));
      const events =
        q.length === 0 || groupMatches ? group.events : group.events.filter(matchesEvent);
      return { group, events, groupMatches };
    })
    .filter((entry) => q.length === 0 || entry.groupMatches || entry.events.length > 0);

  const active =
    visibleGroups.find((entry) => entry.group.id === selectedGroup) ?? visibleGroups[0];

  return (
    <>
      <div className="epg-grid">
      <section className="panel service-panel">
        <div className="panel-head">
          <div>
            <h2>{t('overview.services')}</h2>
            <p>{t('epg.serviceHint')}</p>
          </div>
          <span className="count-pill">{visibleGroups.length}</span>
        </div>
        <div className="service-list">
          {visibleGroups.length === 0 ? (
            <p className="muted small">{t('epg.noEvents')}</p>
          ) : (
            visibleGroups.map((entry) => (
              <button
                key={entry.group.id}
                className={`service-item ${active?.group.id === entry.group.id ? 'active' : ''}`}
                onClick={() => setSelectedGroup(entry.group.id)}
              >
                <span className="service-name">
                  {entry.group.name}
                  <span className="service-number">
                    {entry.group.programNumber !== undefined
                      ? `#${entry.group.programNumber}`
                      : ''}
                  </span>
                </span>
                <span className="service-meta">
                  {t('epg.eventCount', { count: entry.events.length })}
                </span>
              </button>
            ))
          )}
        </div>
      </section>

      <section className="panel page-panel epg-events">
        <div className="subtitle-filter epg-source-filter">
          {(
            [
              ['all', t('epg.filter.all'), sourceCounts.all],
              ['present-following', t('epg.filter.pf'), sourceCounts.presentFollowing],
              ['schedule', t('epg.filter.schedule'), sourceCounts.schedule],
            ] as const
          ).map(([value, label, count]) => (
            <button
              key={value}
              className={sourceFilter === value ? 'active' : ''}
              title={t('epg.sourceHint')}
              onClick={() => setSourceFilter(value)}
            >
              {label}
              <span className="filter-count">{count}</span>
            </button>
          ))}
        </div>
        {active ? (
          <>
            <div className="epg-head">
              <div>
                <h2>{active.group.name}</h2>
                <p className="muted small">
                  {[
                    active.group.programNumber !== undefined
                      ? `#${active.group.programNumber}`
                      : '',
                    active.group.serviceId !== undefined
                      ? `SID ${hex16(active.group.serviceId)}`
                      : '',
                    t('epg.eventCount', { count: active.events.length }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
            </div>
            <Ratings regions={ratings} />
            {active.events.length === 0 ? (
              <p className="muted">{t('epg.noEvents')}</p>
            ) : (
              <>
                <p className="muted small epg-detail-hint">{t('epg.detailOpenHint')}</p>
                <DataTable
                  storageKey="epg"
                  rows={active.events}
                  rowKey={(row) => `${row.serviceId}:${row.eventId}`}
                  initialSort={{ key: 'start', dir: 'asc' }}
                  onRowClick={(row) => setDetailEvent(row)}
                  columns={[
                  {
                    key: 'event',
                    label: t('epg.event'),
                    align: 'num',
                    render: (row) => row.eventId,
                    sortValue: (row) => row.eventId,
                  },
                  {
                    key: 'start',
                    label: t('epg.start'),
                    render: (row) => (
                      <span className="mono small nowrap">{formatIsoMinute(row.startTimeIso)}</span>
                    ),
                    sortValue: (row) => row.startTimeIso ?? '',
                  },
                  {
                    key: 'duration',
                    label: t('epg.duration'),
                    align: 'num',
                    render: (row) =>
                      row.durationSec !== undefined ? formatDuration(row.durationSec) : '-',
                    sortValue: (row) => row.durationSec,
                  },
                  {
                    key: 'title',
                    label: t('epg.title'),
                    render: (row) => {
                      const title = row.name ?? '';
                      const description = row.text && row.text !== row.name ? row.text : '';
                      return (
                        <>
                          {title ? <strong>{title}</strong> : null}
                          {description ? (
                            <div className={title ? 'muted small' : undefined}>
                              {description.slice(0, 260)}
                            </div>
                          ) : null}
                          <div className="epg-tags" title={t('epg.metaHint')}>
                            {row.presentFollowing === 'present' ? (
                              <span className="epg-tag live">{t('epg.present')}</span>
                            ) : null}
                            {row.presentFollowing === 'following' ? (
                              <span className="epg-tag next">{t('epg.following')}</span>
                            ) : null}
                            {row.sources?.includes('schedule') ? (
                              <span className="epg-tag">{t('epg.scheduleSource')}</span>
                            ) : null}
                            {row.languages?.length ? (
                              <span className="epg-tag">
                                {t('epg.language', {
                                  value: row.languages.map(languageLabel).join('/'),
                                })}
                              </span>
                            ) : null}
                            {row.content ? (
                              <span
                                className={`epg-tag ${
                                  row.content === 'unclassified' ? 'muted' : ''
                                }`}
                              >
                                {t('epg.content', {
                                  value:
                                    row.content === 'unclassified'
                                      ? t('epg.unclassified')
                                      : row.content,
                                })}
                              </span>
                            ) : null}
                            {row.rating ? (
                              <span className="epg-tag rating">
                                {t('epg.rating', { value: row.rating })}
                              </span>
                            ) : null}
                          </div>
                        </>
                      );
                    },
                    sortValue: (row) => row.name ?? row.text ?? '',
                  },
                ]}
                />
                {detailEvent ? (
                  <EventDetail event={detailEvent} onClose={() => setDetailEvent(null)} />
                ) : null}
              </>
            )}
          </>
        ) : (
          <p className="muted">{t('epg.none')}</p>
        )}
      </section>
      </div>
    </>
  );
}

function EventDetail({ event, onClose }: { event: ProbeEvent; onClose: () => void }) {
  const t = useT();

  useEffect(() => {
    const handleKey = (keyboardEvent: KeyboardEvent): void => {
      if (keyboardEvent.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const facts: Array<[string, ReactNode]> = [
    [t('epg.event'), `${event.eventId} (${hex16(event.eventId)})`],
    [t('epg.detailService'), hex16(event.serviceId)],
  ];
  if (event.startTimeIso) facts.push([t('epg.start'), formatIsoClock(event.startTimeIso)]);
  if (event.endTimeIso) facts.push([t('epg.end'), formatIsoClock(event.endTimeIso)]);
  if (event.durationSec !== undefined) {
    facts.push([
      t('epg.duration'),
      `${formatDuration(event.durationSec)} (${event.durationSec}s)`,
    ]);
  }
  if (event.runningStatus !== undefined) {
    facts.push([
      t('epg.runningStatus'),
      `${event.runningStatusName ?? '-'} (${event.runningStatus}, ${hex16(
        event.runningStatus,
      )})`,
    ]);
  }
  const sourceLabels = (event.sources ?? []).map((source) =>
    source === 'present-following' ? t('epg.filter.pf') : t('epg.filter.schedule'),
  );
  if (sourceLabels.length > 0) facts.push([t('epg.sources'), sourceLabels.join(' · ')]);
  if (event.presentFollowing) {
    facts.push([
      t('epg.presentFollowing'),
      event.presentFollowing === 'present' ? t('epg.present') : t('epg.following'),
    ]);
  }
  if (event.content) {
    facts.push([
      t('epg.contentLabel'),
      event.content === 'unclassified' ? t('epg.unclassified') : event.content,
    ]);
  }
  if (event.rating) facts.push([t('epg.ratingLabel'), event.rating]);
  if (event.languages?.length) {
    facts.push([t('epg.languages'), event.languages.map(languageLabel).join(', ')]);
  }
  const series = [
    event.seriesName ?? '',
    event.seriesId !== undefined ? hex16(event.seriesId) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (series) facts.push([t('epg.series'), series]);
  if (event.linkage) facts.push([t('epg.linkage'), event.linkage]);

  const descriptorValue = (key: string, value: string | number | boolean): string => {
    if (typeof value === 'boolean') return value ? t('table.yes') : t('table.no');
    if ((key === 'language' || key === 'languages') && typeof value === 'string') {
      return readableLanguages(value);
    }
    return String(value);
  };

  return (
    <div className="descriptor-modal-backdrop" onClick={onClose}>
      <div
        className="descriptor-modal epg-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('epg.detailTitle')}
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <div className="descriptor-modal-head">
          <div>
            <h2>{event.name || t('epg.detailTitle')}</h2>
            <p className="muted small">{t('epg.detailHint')}</p>
          </div>
          <button className="ghost tiny" onClick={onClose} autoFocus>
            {t('epg.close')}
          </button>
        </div>
        <div className="descriptor-modal-body">
          <dl className="epg-detail-grid">
            {facts.map(([label, value]) => (
              <div className="epg-detail-item" key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {event.text && event.text !== event.name ? (
            <p className="epg-detail-text">{event.text}</p>
          ) : null}
          {event.items?.length ? (
            <section className="epg-detail-section">
              <h3>{t('epg.items')}</h3>
              <ul className="epg-detail-items">
                {event.items.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="epg-detail-section">
            <h3>
              {t('epg.descriptors')} ({event.descriptors.length})
            </h3>
            {event.descriptors.length === 0 ? (
              <p className="muted small">{t('epg.descriptorEmpty')}</p>
            ) : (
              <div className="epg-detail-descriptors">
                {event.descriptors.map((descriptor, index) => {
                  const fields = Object.entries(descriptor.fields ?? {});
                  return (
                    <article
                      className="epg-detail-descriptor"
                      key={`${descriptor.tag}-${index}`}
                    >
                      <header>
                        <strong>{descriptor.name}</strong>
                        <span className="descriptor-tag">{descriptor.tagHex}</span>
                        <span className="muted small">
                          {t('epg.descriptorLength', { count: descriptor.length })}
                        </span>
                      </header>
                      {fields.length > 0 ? (
                        <dl className="descriptor-fields">
                          {fields.map(([key, value]) => (
                            <div className="descriptor-field" key={key}>
                              <dt>{humanizeField(key)}</dt>
                              <dd>{descriptorValue(key, value)}</dd>
                            </div>
                          ))}
                        </dl>
                      ) : null}
                      <div className="epg-detail-raw">
                        <span className="muted small">{t('epg.raw')}</span>
                        <code>{descriptor.raw || '-'}</code>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Ratings({
  regions,
  defaultOpen = false,
}: {
  regions: ProbeRatingRegion[];
  defaultOpen?: boolean;
}) {
  const t = useT();
  if (regions.length === 0) return null;

  return (
    <details className="ratings-panel" open={defaultOpen || undefined}>
      <summary title={t('ratings.hint')}>
        <span className="ratings-title">{t('ratings.title')}</span>
        <span className="muted small">
          {regions.map((region) => `RRT${region.ratingRegion}`).join(' · ')}
        </span>
        <span className="count-pill">{regions.length}</span>
      </summary>
      <div className="rating-regions">
        {regions.map((region) => (
          <article className="rating-region" key={region.ratingRegion}>
            <header className="rating-region-head">
              <strong>{t('ratings.region', { region: region.ratingRegion })}</strong>
              {region.name ? <span className="rating-name">{region.name}</span> : null}
              <span className="muted small">
                {[
                  t('ratings.protocol', { value: region.protocolVersion }),
                  t('ratings.dimensions', { count: region.dimensions.length }),
                ].join(' · ')}
              </span>
            </header>
            {region.dimensions.map((dimension, dimensionIndex) => (
              <div
                className="rating-dimension"
                key={`${dimension.name}-${dimensionIndex}`}
              >
                <div className="rating-dimension-head">
                  <span>{dimension.name || t('ratings.dimension')}</span>
                  <span className="muted small">
                    {dimension.graduatedScale
                      ? t('ratings.scale.graduated')
                      : t('ratings.scale.literal')}
                    {' · '}
                    {t('ratings.valueCount', { count: dimension.values.length })}
                  </span>
                </div>
                <div className="rating-values">
                  {dimension.values.map((value, valueIndex) => (
                    <span className="rating-value" key={`${value.abbrev}-${valueIndex}`}>
                      {value.abbrev ? <strong>{value.abbrev}</strong> : null}
                      {value.abbrev && value.text ? ' ' : ''}
                      {value.text}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            {region.descriptors.length > 0 ? (
              <div className="muted small">
                {region.descriptors.map((descriptor) => descriptor.name).join(', ')}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </details>
  );
}
