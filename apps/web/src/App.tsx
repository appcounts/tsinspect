import { useEffect, useMemo, useState } from 'react';
import { DataBroadcastView } from './components/DataBroadcast';
import { EmergencyBanner } from './components/EmergencyBanner';
import { Epg } from './components/Epg';
import { Hex } from './components/Hex';
import { Overview } from './components/Overview';
import { Pids } from './components/Pids';
import { SessionDrawer } from './components/SessionDrawer';
import { Subtitles } from './components/Subtitles';
import { Summary, Welcome } from './components/Summary';
import { Tables } from './components/Tables';
import { Timeline } from './components/Timeline';
import { Validation } from './components/Validation';
import { formatBytes, hex16 } from './format';
import { LocaleContext, type UiKey } from './i18n';
import { hashState, PAGE_SUBTITLES, SEARCHABLE, TAB_SHORT_LABELS, TABS } from './tabs';
import type { Tab } from './types';
import { useSession } from './useSession';

function TabIcon({ id }: { id: Tab }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };
  switch (id) {
    case 'services':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="6" height="6" rx="1.5" />
          <rect x="11" y="3" width="6" height="6" rx="1.5" />
          <rect x="3" y="11" width="6" height="6" rx="1.5" />
          <rect x="11" y="11" width="6" height="6" rx="1.5" />
        </svg>
      );
    case 'pids':
      return (
        <svg {...common}>
          <path d="M6 5h11M6 10h11M6 15h11" />
          <circle cx="3.2" cy="5" r=".9" fill="currentColor" stroke="none" />
          <circle cx="3.2" cy="10" r=".9" fill="currentColor" stroke="none" />
          <circle cx="3.2" cy="15" r=".9" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'tables':
      return (
        <svg {...common}>
          <rect x="2.5" y="4" width="15" height="12" rx="2" />
          <path d="M2.5 8h15M2.5 12h15M8 8v8" />
        </svg>
      );
    case 'data':
      return (
        <svg {...common}>
          <circle cx="10" cy="10" r="1.5" fill="currentColor" stroke="none" />
          <path d="M6.8 6.8a4.5 4.5 0 0 0 0 6.4M13.2 6.8a4.5 4.5 0 0 1 0 6.4M4 4a8.5 8.5 0 0 0 0 12M16 4a8.5 8.5 0 0 1 0 12" />
        </svg>
      );
    case 'epg':
      return (
        <svg {...common}>
          <rect x="3" y="4.5" width="14" height="12" rx="2" />
          <path d="M3 8.5h14M6.5 3v3M13.5 3v3" />
          <path d="M6.5 12h3M11.5 12h2" />
        </svg>
      );
    case 'subtitles':
      return (
        <svg {...common}>
          <rect x="2.5" y="4.5" width="15" height="11" rx="2" />
          <path d="M9 8.6a2.1 2.1 0 1 0 0 2.8M14.8 8.6a2.1 2.1 0 1 0 0 2.8" />
        </svg>
      );
    case 'timeline':
      return (
        <svg {...common}>
          <path d="M2.5 10h3l2-5 4 10 2-5h3.5" />
        </svg>
      );
    case 'validation':
      return (
        <svg {...common}>
          <path d="M10 3l6 2v5c0 3.2-2.4 5.6-6 7-3.6-1.4-6-3.8-6-7V5l6-2z" />
          <path d="M7.4 9.9l1.8 1.8 3.4-3.5" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M7.4 3.5L4 10l3.4 6.5M12.6 3.5L16 10l-3.4 6.5" />
        </svg>
      );
  }
}

function fieldSearchText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(fieldSearchText).join(' ');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => `${key} ${fieldSearchText(child)}`)
      .join(' ');
  }
  return String(value);
}

export default function App() {
  const initial = useMemo(hashState, []);
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [query, setQuery] = useState(initial.q);
  const [selectedProgram, setSelectedProgram] = useState<number | undefined>(undefined);
  const [hexOffset, setHexOffset] = useState(0);
  const [hexLength, setHexLength] = useState(256);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const {
    locale,
    toggleLocale,
    t,
    source,
    setSource,
    bytes,
    setBytes,
    statusText,
    error,
    busy,
    picking,
    sessionId,
    result,
    hex,
    scte35,
    subtitles,
    subtitlesLoading,
    progress,
    analyze,
    cancel,
    pickSource,
    closeSession,
  } = useSession({ tab, hexOffset, hexLength, initialSession: initial.session });

  useEffect(() => {
    setSelectedProgram(result?.services[0]?.programNumber);
  }, [result]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (sessionId) next.set('session', sessionId);
    next.set('tab', tab);
    if (query) next.set('q', query);
    const value = `#${next.toString()}`;
    if (window.location.hash !== value) window.history.replaceState(null, '', value);
  }, [sessionId, tab, query]);

  const filteredPids = useMemo(() => {
    if (!result) return [];
    const q = query.trim().toLowerCase();
    if (!q) return result.pids;
    return result.pids.filter(
      (pid) =>
        pid.pidHex.toLowerCase().includes(q) ||
        String(pid.pid).includes(q) ||
        (pid.kind ?? '').toLowerCase().includes(q),
    );
  }, [result, query]);

  const filteredTables = useMemo(() => {
    if (!result) return [];
    const q = query.trim().toLowerCase();
    if (!q) return result.tables;
    return result.tables.filter(
      (table) =>
        table.name.toLowerCase().includes(q) ||
        table.pidHex.toLowerCase().includes(q) ||
        table.tableIdHex.toLowerCase().includes(q) ||
        String(table.pid).includes(q) ||
        String(table.tableId).includes(q) ||
        Object.entries(table.fields ?? {}).some(
          ([key, value]) =>
            key.toLowerCase().includes(q) || fieldSearchText(value).toLowerCase().includes(q),
        ),
    );
  }, [result, query]);

  const errors = result?.diagnostics.filter((item) => item.severity === 'error').length ?? 0;
  const warnings = result?.diagnostics.filter((item) => item.severity === 'warning').length ?? 0;
  const infos = result?.diagnostics.filter((item) => item.severity === 'info').length ?? 0;
  const healthStatus: 'pass' | 'warn' | 'fail' =
    errors > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass';
  const healthLabel = t(`validation.${healthStatus}` as UiKey);
  const navCounts: Partial<Record<Tab, number>> = result
    ? {
        services: result.services.length,
        pids: result.pids.length,
        tables: result.tables.length,
        data:
          (result.dataBroadcast?.mpe.length ?? 0) +
          (result.dataBroadcast?.carousels.length ?? 0) +
          (result.dataBroadcast?.applications.length ?? 0),
        epg: result.events.length,
        validation: errors + warnings,
      }
    : {};
  const currentTab = TABS.find((entry) => entry.id === tab) ?? (TABS[0] as (typeof TABS)[number]);
  const searchPlaceholder =
    tab === 'validation'
      ? t('search.validation')
      : tab === 'subtitles'
        ? t('search.subtitles')
        : t('search.placeholder');
  const switchTab = (next: Tab): void => {
    setTab(next);
    setQuery('');
  };

  return (
    <LocaleContext.Provider value={locale}>
      <div className="app">
        <header className="appbar">
          <div className="appbar-main">
            <div className="brand">
              <span className="brand-mark" aria-hidden="true">
                ts
              </span>
              <div className="brand-text">
                <strong>tsinspect</strong>
                <span>{t('app.subtitle')}</span>
              </div>
            </div>

            <section className="source-panel">
              <label className="panel-label" htmlFor="stream-source">
                {t('source.label')}
              </label>
              <div className="source-input-row">
                <input
                  id="stream-source"
                  className="source-input"
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void analyze();
                  }}
                  placeholder={t('source.placeholder')}
                  spellCheck={false}
                />
                <button
                  className="ghost source-browse"
                  type="button"
                  onClick={() => void pickSource()}
                  disabled={picking || busy}
                  title={t('source.browseTitle')}
                >
                  {picking ? t('source.browsing') : t('source.browse')}
                </button>
              </div>
              <div className="source-row">
                <select value={bytes} onChange={(event) => setBytes(Number(event.target.value))}>
                  <option value={16 * 1024 * 1024}>16 MiB</option>
                  <option value={64 * 1024 * 1024}>64 MiB</option>
                  <option value={256 * 1024 * 1024}>256 MiB</option>
                  <option value={0}>{t('source.all')}</option>
                </select>
                <button className="primary" onClick={() => void analyze()} disabled={busy}>
                  {busy ? t('source.analyzingButton') : t('source.analyze')}
                </button>
                {busy ? (
                  <button
                    className="ghost"
                    onClick={cancel}
                    disabled={progress?.cancelable === false}
                    title={progress?.cancelable === false ? t('progress.notCancelable') : undefined}
                  >
                    {t('source.cancel')}
                  </button>
                ) : null}
              </div>
              <span className="source-hint muted small">{t('source.hint')}</span>
            </section>

            {result && (
              <button
                type="button"
                className="session-chip"
                onClick={() => setDrawerOpen(true)}
                title={t('session.details')}
              >
                <span className={`health-dot ${healthStatus}`} />
                <span className="session-chip-text">
                  <span className="session-chip-name">{result.source.name}</span>
                  <span className="session-chip-meta">
                    {result.standard.detected} · {result.packet.size} B · {result.services.length}{' '}
                    {t('summary.services')}
                  </span>
                </span>
              </button>
            )}

            <button
              type="button"
              className="appbar-locale"
              onClick={toggleLocale}
              title={t('locale.switch')}
            >
              {locale === 'zh' ? 'EN' : '中'}
            </button>
          </div>

          {result && (
            <div className="tabbar">
              <nav className="tabs" aria-label={t('nav.section')}>
                {TABS.map((entry) => {
                  const count = navCounts[entry.id];
                  const active = tab === entry.id;
                  const badge =
                    entry.id === 'validation' && errors + warnings > 0
                      ? errors + warnings
                      : count !== undefined && count > 0
                        ? count
                        : undefined;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className={active ? 'tab-item active' : 'tab-item'}
                      aria-current={active ? 'page' : undefined}
                      title={t(entry.label)}
                      onClick={() => switchTab(entry.id)}
                    >
                      <TabIcon id={entry.id} />
                      <span className="tab-label">{t(TAB_SHORT_LABELS[entry.id])}</span>
                      {badge !== undefined ? (
                        <span
                          className={
                            entry.id === 'validation' && errors + warnings > 0
                              ? `tab-count ${healthStatus}`
                              : 'tab-count'
                          }
                        >
                          {badge > 999 ? '999+' : badge}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </nav>
              <div className="tabbar-tools">
                {SEARCHABLE.has(tab) && (
                  <input
                    className="filter global-search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={searchPlaceholder}
                    aria-label={searchPlaceholder}
                  />
                )}
                <button
                  type="button"
                  className={`health-pill ${healthStatus}`}
                  onClick={() => {
                    setTab('validation');
                    setQuery('');
                  }}
                >
                  <span className="health-dot" />
                  {healthLabel}
                </button>
              </div>
            </div>
          )}

          {(!result || busy || error) && (
            <div className="appbar-status">
              {busy && progress ? (
                <div className="analysis-progress">
                  <div className="analysis-progress-head">
                    <span>
                      {progress.phase === 'probing'
                        ? t('progress.probing', { pass: progress.pass ?? 1 })
                        : t('progress.loading')}
                    </span>
                    <span className="muted small">
                      {progress.percent !== undefined ? `${Math.round(progress.percent)}%` : ''}
                    </span>
                  </div>
                  <div className="analysis-progress-track">
                    <div
                      className={
                        progress.percent === undefined
                          ? 'analysis-progress-bar indeterminate'
                          : 'analysis-progress-bar'
                      }
                      style={
                        progress.percent !== undefined
                          ? { width: `${Math.max(2, Math.min(100, progress.percent))}%` }
                          : undefined
                      }
                    />
                  </div>
                  {progress.receivedBytes !== undefined || progress.totalBytes !== undefined ? (
                    <div className="muted small">
                      {formatBytes(progress.receivedBytes)}
                      {progress.totalBytes !== undefined
                        ? ` / ${formatBytes(progress.totalBytes)}`
                        : ''}
                    </div>
                  ) : null}
                  {progress.cancelable === false ? (
                    <div className="muted small">{t('progress.notCancelable')}</div>
                  ) : null}
                </div>
              ) : null}
              <div className={error ? 'source-status error' : 'source-status muted'}>
                {statusText}
              </div>
            </div>
          )}
        </header>

        <main className="canvas">
          <div className="canvas-head">
            <h1>{t(currentTab.label)}</h1>
            <p>{t(PAGE_SUBTITLES[tab])}</p>
          </div>
          {!result && <Welcome />}

          {result && (
            <>
              {tab === 'services' && result.emergency ? (
                <EmergencyBanner emergency={result.emergency} />
              ) : null}
              {tab === 'services' && (
                <>
                  <Summary result={result} />
                  <Overview
                    result={result}
                    query={query}
                    selectedProgram={selectedProgram}
                    sessionId={sessionId}
                    onSelect={setSelectedProgram}
                    onPid={(pid) => {
                      setTab('pids');
                      setQuery(hex16(pid));
                    }}
                    onValidation={() => {
                      setTab('validation');
                      setQuery('');
                    }}
                    errors={errors}
                    warnings={warnings}
                    healthStatus={healthStatus}
                  />
                </>
              )}

              {tab === 'pids' && (
                <section className="panel page-panel">
                  <Pids
                    pids={filteredPids}
                    total={result.pids.length}
                    onHex={(offset) => {
                      setTab('hex');
                      setQuery('');
                      setHexOffset(offset);
                    }}
                  />
                </section>
              )}
              {tab === 'tables' && (
                <section className="panel page-panel">
                  <Tables
                    tables={filteredTables}
                    total={result.tables.length}
                    services={result.services}
                    query={query}
                  />
                </section>
              )}
              {tab === 'data' && <DataBroadcastView data={result.dataBroadcast} />}
              {tab === 'epg' && <Epg result={result} query={query} />}
              {tab === 'subtitles' && (
                <Subtitles
                  result={result}
                  report={subtitles}
                  loading={subtitlesLoading}
                  query={query}
                  sessionId={sessionId}
                />
              )}
              {tab === 'timeline' && (
                <section className="panel page-panel">
                  <Timeline result={result} scte35={scte35} sessionId={sessionId} />
                </section>
              )}
              {tab === 'validation' && (
                <section className="panel page-panel">
                  <Validation result={result} query={query} />
                </section>
              )}
              {tab === 'hex' && (
                <section className="panel page-panel">
                  <Hex
                    hex={hex}
                    offset={hexOffset}
                    length={hexLength}
                    packet={result.packet}
                    pids={result.pids}
                    onOffset={setHexOffset}
                    onLength={setHexLength}
                  />
                </section>
              )}
            </>
          )}
        </main>

        {drawerOpen && result ? (
          <SessionDrawer
            result={result}
            sessionId={sessionId}
            healthStatus={healthStatus}
            errors={errors}
            warnings={warnings}
            infos={infos}
            onClose={() => setDrawerOpen(false)}
            onValidation={() => switchTab('validation')}
            onCloseSession={() => {
              closeSession();
              setDrawerOpen(false);
            }}
          />
        ) : null}
      </div>
    </LocaleContext.Provider>
  );
}
