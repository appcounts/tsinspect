import { useEffect } from 'react';
import type { ProbeResult } from '@tsinspect/core';
import { useT, type UiKey } from '../i18n';
import { formatBitrate, formatBytes, formatDuration, hex16 } from '../format';

export function SessionDrawer({
  result,
  sessionId,
  healthStatus,
  errors,
  warnings,
  infos,
  onClose,
  onValidation,
  onCloseSession,
}: {
  result: ProbeResult;
  sessionId: string | undefined;
  healthStatus: 'pass' | 'warn' | 'fail';
  errors: number;
  warnings: number;
  infos: number;
  onClose: () => void;
  onValidation: () => void;
  onCloseSession: () => void;
}) {
  const t = useT();
  const healthLabel = t(`validation.${healthStatus}` as UiKey);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={t('session.details')}>
        <header className="drawer-head">
          <span>{t('session.details')}</span>
          <button
            type="button"
            className="drawer-close"
            onClick={onClose}
            aria-label={t('drawer.close')}
          >
            ×
          </button>
        </header>
        <div className="drawer-body">
          <section className="session-card">
            <div className="panel-label">{t('session.label')}</div>
            <div className="session-name" title={result.source.name}>
              {result.source.name}
            </div>
            <div className="session-meta">
              {result.standard.detected} · {result.packet.size} B · {result.services.length}{' '}
              {t('summary.services')}
            </div>
            {!result.source.full ? (
              <div className="session-partial">
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
            <button
              className="ghost session-close"
              onClick={() => {
                onCloseSession();
                onClose();
              }}
            >
              {t('session.close')}
            </button>
          </section>

          <section className="context-card">
            <div className="panel-label">{t('context.title')}</div>
            <dl className="context-grid">
              <div>
                <dt>{t('summary.standard')}</dt>
                <dd>{result.standard.detected}</dd>
              </div>
              <div>
                <dt>{t('summary.packet')}</dt>
                <dd>{result.packet.size} B</dd>
              </div>
              <div>
                <dt>{t('summary.services')}</dt>
                <dd>{result.services.length}</dd>
              </div>
              <div>
                <dt>{t('context.pids')}</dt>
                <dd>{result.pids.length}</dd>
              </div>
              {result.transport.tsid !== undefined ? (
                <div>
                  <dt>{t('context.tsid')}</dt>
                  <dd>{hex16(result.transport.tsid)}</dd>
                </div>
              ) : null}
              {result.transport.networkId !== undefined ? (
                <div>
                  <dt>{t('context.onid')}</dt>
                  <dd>{hex16(result.transport.networkId)}</dd>
                </div>
              ) : null}
              {result.transport.bitrateBps !== undefined ? (
                <div>
                  <dt>{t('context.bitrate')}</dt>
                  <dd>{formatBitrate(result.transport.bitrateBps)}</dd>
                </div>
              ) : null}
              {result.transport.durationSec !== undefined ? (
                <div>
                  <dt>{t('summary.duration')}</dt>
                  <dd>{formatDuration(result.transport.durationSec)}</dd>
                </div>
              ) : null}
            </dl>
          </section>

          <button
            type="button"
            className={`context-health ${healthStatus}`}
            onClick={() => {
              onValidation();
              onClose();
            }}
          >
            <span className="context-health-top">
              <span className="panel-label">{t('context.health')}</span>
              <span className={`health-pill ${healthStatus}`}>
                <span className="health-dot" />
                {healthLabel}
              </span>
            </span>
            <span className="context-health-counts">
              <span>
                <strong>{errors}</strong>
                {t('validation.errors')}
              </span>
              <span>
                <strong>{warnings}</strong>
                {t('validation.warnings')}
              </span>
              <span>
                <strong>{infos}</strong>
                {t('validation.infos')}
              </span>
            </span>
          </button>

          {sessionId ? (
            <div className="drawer-export">
              <span className="panel-label">{t('sidebar.export')}</span>
              <span className="export-links">
                <a href={`/api/sessions/${sessionId}/export?format=json`} download>
                  {t('export.json')}
                </a>
                <a href={`/api/sessions/${sessionId}/export?format=html`} download>
                  {t('export.html')}
                </a>
              </span>
            </div>
          ) : null}
        </div>
      </aside>
    </>
  );
}
