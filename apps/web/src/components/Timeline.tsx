import { useEffect, useState } from 'react';
import type { ProbeResult, Scte35Timeline, Scte35TimelineEvent } from '@tsinspect/core';
import { useT } from '../i18n';
import { formatBitrate, formatCueTime, formatDuration } from '../format';
import { api } from '../api';
import { DataTable } from './shared';

interface TimelineBucketData {
  startSec?: number;
  packets: number;
  bytes: number;
  bitrateBps?: number;
}

interface TimelinePidData {
  pid: number;
  pidHex: string;
  kind?: string;
  packets: number;
  series: number[];
}

interface TimelineSubtitleCueData {
  start: number;
  end: number;
  category: string;
  format: string;
  pidHex: string;
  label?: string;
  text: string;
}

interface TimelineData {
  durationSec?: number;
  bitrateBps?: number;
  bucketSec?: number;
  buckets: TimelineBucketData[];
  pids: TimelinePidData[];
  subtitles?: TimelineSubtitleCueData[];
  subtitlesTruncated?: boolean;
}

export function Timeline({
  result,
  scte35,
  sessionId,
}: {
  result: ProbeResult;
  scte35: Scte35Timeline | null;
  sessionId?: string;
}) {
  const t = useT();
  const [timeline, setTimeline] = useState<TimelineData | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | undefined>();
  const [selectedPid, setSelectedPid] = useState<number | undefined>();

  useEffect(() => {
    if (!sessionId) {
      setTimeline(null);
      return;
    }
    const controller = new AbortController();
    setTimelineLoading(true);
    setTimelineError(undefined);
    api<TimelineData>(
      `/api/sessions/${sessionId}/timeline?buckets=120&top=10&subtitles=1`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        setTimeline(value);
        setTimelineLoading(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setTimelineError(error instanceof Error ? error.message : String(error));
        setTimelineLoading(false);
      });
    return () => controller.abort();
  }, [sessionId]);

  const duration = timeline?.durationSec ?? result.transport.durationSec;
  const buckets = timeline?.buckets ?? [];
  const bucketCount = buckets.length;
  const selected = timeline?.pids.find((pid) => pid.pid === selectedPid);
  const max = Math.max(...result.pids.map((pid) => pid.packets), 1);
  const pids = [...result.pids].sort((a, b) => b.packets - a.packets).slice(0, 24);
  const position = (seconds: number | undefined) =>
    duration !== undefined && duration > 0 && seconds !== undefined
      ? Math.min(100, Math.max(0, (seconds / duration) * 100))
      : undefined;
  const bucketStart = (index: number): number | undefined =>
    buckets[index]?.startSec ?? (duration !== undefined && bucketCount > 0
      ? (index * duration) / bucketCount
      : undefined);
  const maxBitrate = Math.max(
    ...buckets.map((bucket) => bucket.bitrateBps ?? bucket.packets),
    1,
  );
  const maxSelected = selected ? Math.max(...selected.series, 1) : 1;

  return (
    <div>
      <p className="muted">
        {t('timeline.total', {
          duration: duration ? formatDuration(duration) : '-',
          bitrate: result.transport.bitrateBps ? formatBitrate(result.transport.bitrateBps) : '',
        })}
      </p>
      {timelineLoading ? (
        <p className="muted small">{t('timeline.loading')}</p>
      ) : timelineError ? (
        <p className="bad small">{t('timeline.loadFailed', { value: timelineError })}</p>
      ) : buckets.length > 0 ? (
        <section className="timeline-panel">
          <div className="timeline-panel-head">
            <h3>{selected ? t('timeline.selectedPid', { value: selected.pidHex }) : t('timeline.bitrate')}</h3>
            <span className="muted small">
              {t('timeline.bucket', { count: bucketCount })}
              {selected ? (
                <button className="ghost tiny" onClick={() => setSelectedPid(undefined)}>
                  {t('timeline.allPids')}
                </button>
              ) : null}
            </span>
          </div>
          {scte35 && (scte35.events.length > 0 || scte35.breaks.length > 0) ? (
            <div className="timeline-marker-track">
              <span className="timeline-track-label">SCTE-35</span>
              {scte35.breaks.map((entry, index) => {
              const left = position(entry.startSec);
              const end = position(entry.endSec);
              if (left === undefined || end === undefined) return null;
              return (
                <span
                  key={`break-${index}`}
                  className="scte35-break"
                  style={{ left: `${left}%`, width: `${Math.max(0.4, end - left)}%` }}
                  title={`${entry.commandName} ${entry.durationSec.toFixed(3)}s`}
                />
              );
            })}
              {scte35.events.map((event, index) => {
                const left = position(event.timeSec);
                if (left === undefined) return null;
                return (
                  <span
                    key={`event-${index}`}
                    className="scte35-marker"
                    style={{ left: `${left}%` }}
                    title={`${event.commandName}${event.eventId !== undefined ? ` event=${event.eventId}` : ''}`}
                  />
                );
              })}
            </div>
          ) : null}
          {timeline?.subtitles && timeline.subtitles.length > 0 ? (
            <div className="timeline-marker-track subtitle-track" title={t('timeline.subtitleTrack')}>
              <span className="timeline-track-label">{t('timeline.subtitleTrack')}</span>
              {timeline.subtitles.map((cue, index) => {
                const left = position(cue.start);
                const end = position(cue.end);
                if (left === undefined || end === undefined) return null;
                return (
                  <span
                    key={`sub-${index}`}
                    className={`timeline-subtitle-block ${cue.category}`}
                    style={{ left: `${left}%`, width: `${Math.max(0.35, end - left)}%` }}
                    title={`${cue.format} ${cue.pidHex} · ${formatCueTime(cue.start)} — ${formatCueTime(cue.end)}\n${cue.text}`}
                  />
                );
              })}
              {timeline.subtitlesTruncated ? (
                <span className="timeline-track-note">{t('timeline.truncatedCues')}</span>
              ) : null}
            </div>
          ) : null}
          <div className="timeline-chart">
            {buckets.map((bucket, index) => {
              const value = selected
                ? selected.series[index] ?? 0
                : bucket.bitrateBps ?? bucket.packets;
              const maximum = selected ? maxSelected : maxBitrate;
              const height = maximum > 0 ? (value / maximum) * 100 : 0;
              const time = bucketStart(index);
              const detail = selected
                ? `${selected.pidHex} · ${t('timeline.packets', { count: value })}`
                : bucket.bitrateBps !== undefined
                  ? formatBitrate(bucket.bitrateBps)
                  : t('timeline.packets', { count: bucket.packets });
              return (
                <span
                  key={index}
                  className={`timeline-bar${selected ? ' selected' : ''}`}
                  style={{ height: `${Math.max(1, height)}%` }}
                  title={`${time !== undefined ? formatCueTime(time) : `#${index + 1}`} · ${detail}`}
                />
              );
            })}
          </div>
          <div className="timeline-axis">
            <span>0:00</span>
            <span>{duration !== undefined ? formatDuration(duration) : ''}</span>
          </div>
          <div className="timeline-heatmap">
            <div className="timeline-heatmap-head">
              <span>{t('timeline.pidActivity')}</span>
              <span className="muted small">{t('timeline.pidActivityHint')}</span>
            </div>
            {timeline?.pids.map((pid) => {
              const rowMax = Math.max(...pid.series, 1);
              return (
                <button
                  type="button"
                  key={pid.pid}
                  className={`timeline-heatmap-row${selectedPid === pid.pid ? ' active' : ''}`}
                  onClick={() =>
                    setSelectedPid(selectedPid === pid.pid ? undefined : pid.pid)
                  }
                >
                  <span className="timeline-heatmap-label">
                    <span className="mono">{pid.pidHex}</span>
                    <span className="muted small">{pid.kind ?? '-'}</span>
                  </span>
                  <span
                    className="timeline-heatmap-cells"
                    style={{ gridTemplateColumns: `repeat(${bucketCount}, 1fr)` }}
                  >
                    {pid.series.map((value, index) => {
                      const time = bucketStart(index);
                      return (
                        <span
                          key={index}
                          className="timeline-heatmap-cell"
                          style={{ opacity: 0.08 + 0.92 * (value / rowMax) }}
                          title={`${pid.pidHex} · ${time !== undefined ? formatCueTime(time) : `#${index + 1}`} · ${t('timeline.packets', { count: value })}`}
                        />
                      );
                    })}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
      {scte35 && scte35.count > 0 && (
        <section className="scte35-panel">
          <h3>
            {t('timeline.marks')}{' '}
            <span className="muted small">
              {t('timeline.counts', {
                events: scte35.count,
                breaks: scte35.breaks.length,
              })}
              {scte35.truncated ? t('timeline.truncated') : ''}
            </span>
          </h3>
          <DataTable<Scte35TimelineEvent>
            storageKey="scte35-events"
            rows={scte35.events}
            rowKey={(event) =>
              `${event.pid}:${event.packet}:${event.commandName}:${event.eventId ?? ''}:${
                event.timeSec ?? ''
              }`
            }
            initialSort={{ key: 'time', dir: 'asc' }}
            columns={[
              {
                key: 'time',
                label: t('timeline.time'),
                align: 'num',
                render: (event) => (
                  <span className="mono">
                    {event.timeSec !== undefined ? `${event.timeSec.toFixed(3)}s` : '-'}
                  </span>
                ),
                sortValue: (event) => event.timeSec,
              },
              {
                key: 'pid',
                label: t('timeline.pid'),
                render: (event) => <span className="mono">{event.pidHex}</span>,
                sortValue: (event) => event.pid,
              },
              {
                key: 'command',
                label: t('timeline.command'),
                render: (event) => event.commandName,
                sortValue: (event) => event.commandName,
              },
              {
                key: 'event',
                label: t('timeline.event'),
                align: 'num',
                render: (event) => (
                  <>
                    {event.eventId ?? '-'}
                    {event.repeats !== undefined ? ` ×${event.repeats}` : ''}
                  </>
                ),
                sortValue: (event) => event.eventId,
              },
              {
                key: 'segmentation',
                label: t('timeline.segmentation'),
                render: (event) => (
                  <span className="small">{event.segmentationTypeName ?? '-'}</span>
                ),
                sortValue: (event) => event.segmentationTypeName ?? '',
              },
              {
                key: 'duration',
                label: t('timeline.duration'),
                align: 'num',
                render: (event) => {
                  const ticks = event.breakDuration ?? event.segmentationDuration;
                  return ticks !== undefined ? `${(ticks / 90_000).toFixed(3)}s` : '-';
                },
                sortValue: (event) => event.breakDuration ?? event.segmentationDuration,
              },
              {
                key: 'source',
                label: t('timeline.source'),
                render: (event) => (
                  <span className="small">
                    {event.source === 'pes'
                      ? t('timeline.sourcePes')
                      : t('timeline.sourceSection')}
                    {event.outOfNetwork ? ` · ${t('timeline.outOfNetwork')}` : ''}
                  </span>
                ),
                sortValue: (event) => event.source,
              },
            ]}
          />
        </section>
      )}
      <div className="timeline-pid-totals">
        <h3>{t('timeline.pidTotals')}</h3>
        {pids.map((pid) => (
          <div className="bar-row" key={pid.pid}>
          <span className="mono bar-label">{pid.pidHex}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(pid.packets / max) * 100}%` }} />
          </span>
          <span className="num">{pid.packets.toLocaleString()}</span>
          <span className="muted small">{pid.kind ?? '-'}</span>
        </div>
      ))}
      </div>
    </div>
  );
}
