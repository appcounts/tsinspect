import type { ProbeResult } from '@tsinspect/core';
import { useT } from '../i18n';
import { capabilityNames, formatBitrate, formatBytes, formatDuration } from '../format';

export function Summary({ result }: { result: ProbeResult }) {
  const t = useT();
  const caps = capabilityNames(result);
  const errors = result.diagnostics.filter((item) => item.severity === 'error').length;
  const warnings = result.diagnostics.filter((item) => item.severity === 'warning').length;
  const cards: Array<{
    name: string;
    value: string;
    sub: string;
    badges?: string[];
  }> = [
    {
      name: t('summary.standard'),
      value: result.standard.detected,
      sub: t('summary.confidence', { value: Math.round(result.standard.confidence * 100) }),
    },
    {
      name: t('summary.packet'),
      value: `${result.packet.size} B`,
      sub: t('summary.packets', { value: result.transport.packetCount.toLocaleString() }),
    },
    {
      name: t('summary.services'),
      value: String(result.services.length),
      sub: t('summary.pids', { value: result.pids.length }),
    },
    {
      name: t('summary.epg'),
      value: String(result.events.length),
      sub: t('summary.tables', { value: result.tables.length }),
    },
    {
      name: t('summary.duration'),
      value: result.transport.durationSec ? formatDuration(result.transport.durationSec) : '-',
      sub: result.transport.bitrateBps ? formatBitrate(result.transport.bitrateBps) : '',
    },
    {
      name: t('summary.capabilities'),
      value: caps.join(' · '),
      sub: t('summary.errorsWarnings', { errors, warnings }),
      badges: caps,
    },
  ];
  return (
    <>
      {!result.source.full ? (
        <div className="partial-banner" role="status">
          {result.source.size !== undefined
            ? t('session.partial', {
                sampled: formatBytes(result.source.sampledBytes),
                total: formatBytes(result.source.size),
              })
            : t('session.partialUnknown', {
                sampled: formatBytes(result.source.sampledBytes),
              })}
        </div>
      ) : null}
      <section className="cards">
        {cards.map((card) => (
          <div className="card" key={card.name}>
            <div className="name">{card.name}</div>
            {card.badges !== undefined ? (
              card.badges.length > 0 ? (
                <div className="card-badges">
                  {card.badges.map((badge) => (
                    <span className="card-badge" key={badge}>
                      {badge}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="value muted">{t('summary.none')}</div>
              )
            ) : (
              <div className="value">{card.value}</div>
            )}
            <div className="sub">{card.sub}</div>
          </div>
        ))}
      </section>
    </>
  );
}

export function Welcome() {
  const t = useT();
  return (
    <section className="welcome">
      <div className="welcome-mark">ts</div>
      <h2>{t('welcome.title')}</h2>
      <p className="muted">{t('welcome.body')}</p>
      <ul className="feature-list">
        <li>{t('welcome.feature1')}</li>
        <li>{t('welcome.feature2')}</li>
        <li>{t('welcome.feature3')}</li>
      </ul>
      <p className="welcome-hint">{t('source.hint')}</p>
    </section>
  );
}
