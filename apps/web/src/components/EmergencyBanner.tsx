import type { ProbeEmergency, ProbeEmergencySegment } from '@tsinspect/core';
import { useT } from '../i18n';

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${secs}` : `${mm}:${secs}`;
}

export function EmergencyBanner({ emergency }: { emergency: ProbeEmergency }) {
  const t = useT();
  const alerts = emergency.eas ?? [];
  const ewbs = emergency.ewbs;
  const services = (ewbs?.services ?? []).filter((service) => service.started);
  const ewsRegions = emergency.ews?.regions ?? [];
  const timeline = emergency.timeline ?? [];
  const active =
    timeline.length > 0 ||
    alerts.length > 0 ||
    ewbs?.activated === true ||
    services.length > 0 ||
    ewsRegions.length > 0;
  if (!active) return null;

  const levelText = (segment: ProbeEmergencySegment): string => {
    if (segment.level === undefined) return '';
    if (segment.kind === 'EWS') {
      return segment.level === 1
        ? t('overview.ewsLevel1')
        : segment.level === 2
          ? t('overview.ewsLevel2')
          : t('overview.ewsLevel3');
    }
    if (segment.kind === 'EAS') return `P${segment.level}`;
    return `L${segment.level}`;
  };
  const rangeText = (segment: ProbeEmergencySegment) =>
    `${formatClock(segment.startSec)}–${
      segment.endSec === undefined ? t('emergency.ongoing') : formatClock(segment.endSec)
    }`;

  return (
    <section className={`emergency-banner${alerts.length > 0 ? ' critical' : ' warning'}`}>
      <div className="emergency-head">
        <strong>{t('emergency.active')}</strong>
        <span>
          {alerts.length > 0 ? t('emergency.easCount', { count: alerts.length }) : ''}
          {alerts.length > 0 && services.length > 0 ? ' · ' : ''}
          {services.length > 0 ? t('emergency.ewbsCount', { count: services.length }) : ''}
          {(alerts.length > 0 || services.length > 0) && ewsRegions.length > 0 ? ' · ' : ''}
          {ewsRegions.length > 0 ? t('emergency.ewsCount', { count: ewsRegions.length }) : ''}
        </span>
      </div>
      <ul className="emergency-list">
        {timeline.slice(0, 8).map((segment, index) => (
          <li key={`${segment.kind}-${segment.startSec}-${index}`}>
            <span className="mono">{rangeText(segment)}</span>
            {` · ${segment.kind}`}
            {segment.level !== undefined ? ` · ${levelText(segment)}` : ''}
            {segment.title ? ` · ${segment.title}` : ''}
            {segment.areas ? ` · ${segment.areas}` : ''}
            {segment.detail ? ` · ${segment.detail}` : ''}
          </li>
        ))}
      </ul>
      <span className="muted small">{t('emergency.hint')}</span>
    </section>
  );
}
