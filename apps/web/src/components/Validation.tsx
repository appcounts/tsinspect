import { useContext, useMemo, useState } from 'react';
import type { ProbeResult, Severity } from '@tsinspect/core';
import { LocaleContext, UI, useT, type Locale, type UiKey } from '../i18n';
import { hex16 } from '../format';
import { DataTable } from './shared';

function diagnosticText(locale: Locale, code: string): { title?: string; description?: string } {
  const table = UI[locale] as Record<string, string>;
  return {
    title: table[`diag.${code}.title`],
    description: table[`diag.${code}.desc`],
  };
}

export function Validation({ result, query }: { result: ProbeResult; query: string }) {
  const t = useT();
  const locale = useContext(LocaleContext);
  const [strict, setStrict] = useState(false);
  const [severity, setSeverity] = useState<'all' | Severity>('all');

  const counts = useMemo(
    () => ({
      error: result.diagnostics.filter((item) => item.severity === 'error').length,
      warning: result.diagnostics.filter((item) => item.severity === 'warning').length,
      info: result.diagnostics.filter((item) => item.severity === 'info').length,
    }),
    [result.diagnostics],
  );

  const diagnostics = useMemo(() => {
    const q = query.trim().toLowerCase();
    return result.diagnostics.filter((item) => {
      if (severity !== 'all' && item.severity !== severity) return false;
      if (!q) return true;
      const explanation = diagnosticText(locale, item.code);
      return (
        item.code.toLowerCase().includes(q) ||
        item.message.toLowerCase().includes(q) ||
        (item.pid !== undefined && hex16(item.pid).toLowerCase().includes(q)) ||
        (explanation.title ?? '').toLowerCase().includes(q) ||
        (explanation.description ?? '').toLowerCase().includes(q)
      );
    });
  }, [result.diagnostics, query, severity, locale]);

  const failed = counts.error > 0 || (strict && counts.warning > 0);
  const status: 'pass' | 'warn' | 'fail' = failed
    ? 'fail'
    : counts.warning > 0
      ? 'warn'
      : 'pass';
  const message = failed
    ? counts.error > 0
      ? t('validation.failMessage')
      : t('validation.warnMessage')
    : status === 'warn'
      ? t('validation.warnMessage')
      : t('validation.okMessage');

  return (
    <div>
      <p className="muted small validation-hint">{t('validation.hint')}</p>
      <section className={`validation-status ${status}`}>
        <div className="validation-state">{t(`validation.${status}` as UiKey)}</div>
        <div className="validation-counts">
          <span className="badge error">{t('validation.errors')} {counts.error}</span>
          <span className="badge warning">{t('validation.warnings')} {counts.warning}</span>
          <span className="badge info">{t('validation.infos')} {counts.info}</span>
        </div>
        <label className="validation-strict">
          <input
            type="checkbox"
            checked={strict}
            onChange={(event) => setStrict(event.target.checked)}
          />
          {t('validation.strict')}
        </label>
      </section>
      <p className={status === 'fail' ? 'error' : status === 'warn' ? 'muted' : 'ok'}>
        {message}
      </p>

      <div className="severity-filter">
        {(['all', 'error', 'warning', 'info'] as const).map((value) => (
          <button
            key={value}
            className={severity === value ? 'active' : ''}
            onClick={() => setSeverity(value)}
          >
            {value === 'all' ? t('validation.all') : t(`validation.severity.${value}`)}
            {value !== 'all' ? ` ${counts[value]}` : ` ${result.diagnostics.length}`}
          </button>
        ))}
      </div>

      <DataTable
        storageKey="validation"
        rows={diagnostics}
        initialSort={{ key: 'severity', dir: 'asc' }}
        rowKey={(diagnostic) =>
          `${diagnostic.severity}:${diagnostic.code}:${diagnostic.pid ?? ''}:${
            diagnostic.packet ?? ''
          }:${diagnostic.tableId ?? ''}:${diagnostic.message}`
        }
        toolbar={
          <span className="muted small">
            {t('validation.showing', {
              shown: diagnostics.length,
              total: result.diagnostics.length,
            })}
          </span>
        }
        empty={<span className="muted">{t('validation.empty')}</span>}
        columns={[
          {
            key: 'severity',
            label: t('validation.severity'),
            render: (diagnostic) => (
              <span className={`badge ${diagnostic.severity}`}>
                {t(`validation.severity.${diagnostic.severity}`)}
              </span>
            ),
            sortValue: (diagnostic) =>
              diagnostic.severity === 'error' ? 0 : diagnostic.severity === 'warning' ? 1 : 2,
          },
          {
            key: 'code',
            label: t('validation.code'),
            render: (diagnostic) => <span className="mono">{diagnostic.code}</span>,
            sortValue: (diagnostic) => diagnostic.code,
          },
          {
            key: 'explanation',
            label: t('validation.explanation'),
            render: (diagnostic) => {
              const explanation = diagnosticText(locale, diagnostic.code);
              if (explanation.title === undefined) {
                return <span className="muted">-</span>;
              }
              return (
                <span className="diag-explain">
                  <span className="diag-explain-title">{explanation.title}</span>
                  {explanation.description !== undefined ? (
                    <span className="muted small">{explanation.description}</span>
                  ) : null}
                </span>
              );
            },
            sortValue: (diagnostic) => diagnosticText(locale, diagnostic.code).title ?? '',
          },
          {
            key: 'message',
            label: t('validation.message'),
            render: (diagnostic) => diagnostic.message,
            sortValue: (diagnostic) => diagnostic.message,
          },
          {
            key: 'location',
            label: t('validation.location'),
            render: (diagnostic) => {
              const location = [
                diagnostic.pid !== undefined ? `PID ${hex16(diagnostic.pid)}` : '',
                diagnostic.packet !== undefined
                  ? t('validation.packet', { value: diagnostic.packet })
                  : '',
                diagnostic.tableId !== undefined
                  ? t('validation.table', {
                      value: `0x${diagnostic.tableId
                        .toString(16)
                        .padStart(2, '0')
                        .toUpperCase()}`,
                    })
                  : '',
              ]
                .filter(Boolean)
                .join(' · ');
              return <span className="mono small">{location || '-'}</span>;
            },
            sortValue: (diagnostic) =>
              `${diagnostic.pid ?? ''}:${diagnostic.packet ?? ''}:${diagnostic.tableId ?? ''}`,
          },
        ]}
      />
    </div>
  );
}
