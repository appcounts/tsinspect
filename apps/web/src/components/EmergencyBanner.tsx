import type { ProbeEmergency } from '@tsinspect/core';
import { useT } from '../i18n';

function areaCodes(codes: number[]): string {
  return (
    codes.map((code) => `0x${code.toString(16).padStart(3, '0').toUpperCase()}`).join(', ') ||
    '-'
  );
}

export function EmergencyBanner({ emergency }: { emergency: ProbeEmergency }) {
  const t = useT();
  const alerts = emergency.eas ?? [];
  const ewbs = emergency.ewbs;
  const services = (ewbs?.services ?? []).filter((service) => service.started);
  const active = alerts.length > 0 || ewbs?.activated === true || services.length > 0;
  if (!active) return null;

  return (
    <section className={`emergency-banner${alerts.length > 0 ? ' critical' : ' warning'}`}>
      <div className="emergency-head">
        <strong>{t('emergency.active')}</strong>
        <span>
          {alerts.length > 0 ? t('emergency.easCount', { count: alerts.length }) : ''}
          {alerts.length > 0 && services.length > 0 ? ' · ' : ''}
          {services.length > 0 ? t('emergency.ewbsCount', { count: services.length }) : ''}
        </span>
      </div>
      <ul className="emergency-list">
        {alerts.slice(0, 3).map((alert) => (
          <li key={`${alert.pid}:${alert.eventId}:${alert.sequenceNumber}`}>
            <span className="mono">{alert.eventCode}</span>
            {alert.alertText ? ` · ${alert.alertText}` : ''}
            {` · ${t('overview.easLine', {
              code: alert.eventCode,
              originator: alert.originatorCode,
              priority: alert.priority,
              remaining: alert.timeRemainingSec,
            })}`}
          </li>
        ))}
        {services.slice(0, 4).map((service) => (
          <li key={service.serviceId}>
            {t('overview.ewbsServiceLine', {
              service: service.serviceId,
              level: service.signalLevel,
              areas: areaCodes(service.areaCodes),
            })}
          </li>
        ))}
      </ul>
      <span className="muted small">{t('emergency.hint')}</span>
    </section>
  );
}
