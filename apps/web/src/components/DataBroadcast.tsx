import type { ProbeCarouselEntry, ProbeDataBroadcast } from '@tsinspect/core';
import { useT } from '../i18n';

function rec(value: number | undefined, fallback = 0): number {
  return value ?? fallback;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function entryName(entry: ProbeCarouselEntry): string {
  if (entry.path === '/') return '/';
  return entry.path.split('/').pop() ?? entry.path;
}

function entryDepth(entry: ProbeCarouselEntry): number {
  return entry.path === '/' ? 0 : entry.path.split('/').length - 1;
}

export function DataBroadcastView({
  data,
  sessionId,
}: {
  data: ProbeDataBroadcast | undefined;
  sessionId?: string;
}) {
  const t = useT();
  if (!data) {
    return (
      <section className="panel page-panel">
        <p className="muted">{t('data.empty')}</p>
      </section>
    );
  }
  const totals = {
    datagrams: data.mpe.reduce((sum, session) => sum + session.datagrams, 0),
    payload: data.mpe.reduce((sum, session) => sum + session.payloadBytes, 0),
    fecFrames: data.mpeFec.reduce((sum, item) => sum + item.frames, 0),
    blocks: data.carousels.reduce((sum, item) => sum + item.dataBlocks, 0),
    modules: data.carousels.reduce((sum, item) => sum + item.modules.length, 0),
    objects: data.carousels.reduce((sum, item) => sum + item.objects.length, 0),
  };

  return (
    <div className="data-broadcast">
      <div className="metric-strip">
        <div className="metric">
          <span>{t('data.mpe')}</span>
          <strong>{data.mpe.length}</strong>
          <small>{t('data.datagrams', { count: totals.datagrams })}</small>
        </div>
        <div className="metric">
          <span>{t('data.mpeFec')}</span>
          <strong>{data.mpeFec.length}</strong>
          <small>{t('data.frames', { count: totals.fecFrames })}</small>
        </div>
        <div className="metric">
          <span>{t('data.carousels')}</span>
          <strong>{data.carousels.length}</strong>
          <small>
            {t('data.blocks', { count: totals.blocks })} ·{' '}
            {t('data.modules', { count: totals.modules })}
          </small>
        </div>
        <div className="metric">
          <span>{t('data.applications')}</span>
          <strong>{data.applications.length}</strong>
          <small>
            {data.mhp ? 'MHP' : ''}
            {data.mhp && data.hbbtv ? ' · ' : ''}
            {data.hbbtv ? 'HbbTV' : ''}
            {!data.mhp && !data.hbbtv ? t('data.none') : ''}
          </small>
        </div>
      </div>

      <section className="panel page-panel">
        <div className="panel-head">
          <div>
            <h2>{t('data.mpeTitle')}</h2>
            <p>{t('data.mpeHint')}</p>
          </div>
        </div>
        {data.mpe.length === 0 ? (
          <p className="muted small">{t('data.none')}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>PID</th>
                  <th>{t('data.mac')}</th>
                  <th>{t('data.datagramsCol')}</th>
                  <th>{t('data.payload')}</th>
                  <th>{t('data.sections')}</th>
                  <th>IPv4</th>
                </tr>
              </thead>
              <tbody>
                {data.mpe.map((session) => (
                  <tr key={`${session.pid}:${session.macAddress}`}>
                    <td className="mono">0x{session.pid.toString(16).padStart(4, '0')}</td>
                    <td className="mono">{session.macAddress}</td>
                    <td className="num">{session.datagrams}</td>
                    <td className="num">{session.payloadBytes}</td>
                    <td className="num">
                      {session.firstSection}-{session.lastSection}
                      {session.llcSnap ? ' · LLC/SNAP' : ''}
                    </td>
                    <td className="mono small">
                      {session.ipv4
                        ? `${session.ipv4.source} → ${session.ipv4.destination}${
                            session.ipv4.multicast ? ' (mcast)' : ''
                          }`
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data.mpeFec.length > 0 ? (
        <section className="panel page-panel">
          <div className="panel-head">
            <div>
              <h2>{t('data.mpeFecTitle')}</h2>
              <p>{t('data.mpeFecHint')}</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>PID</th>
                  <th>{t('data.framesCol')}</th>
                  <th>{t('data.fullSections')}</th>
                  <th>{t('data.paddingColumns')}</th>
                  <th>{t('data.payload')}</th>
                </tr>
              </thead>
              <tbody>
                {data.mpeFec.map((item) => (
                  <tr key={item.pid}>
                    <td className="mono">0x{item.pid.toString(16).padStart(4, '0')}</td>
                    <td className="num">{item.frames}</td>
                    <td className="num">{item.sections}</td>
                    <td className="num">{item.paddingColumns}</td>
                    <td className="num">{item.payloadBytes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {data.carousels.length > 0 ? (
        <section className="panel page-panel">
          <div className="panel-head">
            <div>
              <h2>{t('data.carouselTitle')}</h2>
              <p>{t('data.carouselHint')}</p>
            </div>
          </div>
          {data.carousels.map((carousel) => (
            <div className="carousel-card" key={carousel.pid}>
              <div className="carousel-head">
                <span className="mono">PID 0x{carousel.pid.toString(16).padStart(4, '0')}</span>
                <span className="muted small">
                  DSI {carousel.serverInitiates} · DII {carousel.downloadInfos} · DDB{' '}
                  {rec(carousel.dataBlocks)} ·{' '}
                  {t('data.modulesShort', { count: carousel.modules.length })} ·{' '}
                  {t('data.objectsShort', { count: carousel.entries.length })}
                </span>
              </div>
              <p className="muted small">
                {carousel.root ?? t('data.rootUnresolved')} ·{' '}
                {t('data.carouselStatus', {
                  complete: carousel.completeModules,
                  pending: carousel.pendingModules,
                })}
                {carousel.danglingBindings > 0
                  ? ` · ${t('data.dangling', { count: carousel.danglingBindings })}`
                  : ''}
                {carousel.truncated ? ' · truncated' : ''}
              </p>
              {carousel.transactions.length > 0 ? (
                <p className="muted small mono">
                  {t('data.transactions')}: {carousel.transactions.join(', ')}
                </p>
              ) : null}
              {carousel.modules.length > 0 ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t('data.module')}</th>
                        <th>{t('data.size')}</th>
                        <th>{t('data.version')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {carousel.modules.map((module) => (
                        <tr key={module.id}>
                          <td className="mono">{module.id}</td>
                          <td className="num">{module.size}</td>
                          <td className="num">{module.version ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {carousel.entries.length > 0 ? (
                <div className="carousel-tree">
                  {carousel.entries.map((entry) => (
                    <div
                      className="tree-row"
                      key={`${carousel.pid}:${entry.path}`}
                      style={{ paddingLeft: `${entryDepth(entry) * 14}px` }}
                    >
                      <span className={`tree-kind ${entry.kind}`}>
                        {entry.kind === 'directory' ? '+' : entry.kind === 'stream' ? '*' : '-'}
                      </span>
                      <span className="mono tree-name">{entryName(entry)}</span>
                      {entry.size !== undefined ? (
                        <span className="muted small">{formatSize(entry.size)}</span>
                      ) : null}
                      {entry.contentType ? (
                        <span className="muted small mono">{entry.contentType}</span>
                      ) : null}
                      {!entry.complete && entry.kind === 'file' ? (
                        <span className="muted small">({t('data.incomplete')})</span>
                      ) : null}
                      {entry.kind === 'file' && entry.complete && sessionId ? (
                        <a
                          className="small"
                          href={`/api/sessions/${sessionId}/carousel/file?path=${encodeURIComponent(
                            entry.path,
                          )}&pid=0x${carousel.pid.toString(16).padStart(4, '0')}`}
                          download
                        >
                          {t('data.download')}
                        </a>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted small">{t('data.noObjects')}</p>
              )}
            </div>
          ))}
        </section>
      ) : null}

      <section className="panel page-panel">
        <div className="panel-head">
          <div>
            <h2>{t('data.appTitle')}</h2>
            <p>{t('data.appHint')}</p>
          </div>
        </div>
        {data.applications.length === 0 ? (
          <p className="muted small">{t('data.none')}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>PID</th>
                  <th>{t('data.appType')}</th>
                  <th>{t('data.orgId')}</th>
                  <th>{t('data.appId')}</th>
                  <th>{t('data.control')}</th>
                  <th>{t('data.name')}</th>
                  <th>URL</th>
                </tr>
              </thead>
              <tbody>
                {data.applications.map((application) => (
                  <tr
                    key={`${application.pid}:${application.organizationId}:${application.applicationId}`}
                  >
                    <td className="mono">0x{application.pid.toString(16).padStart(4, '0')}</td>
                    <td>
                      {application.applicationTypeName}
                      <span className="muted small mono">
                        {' '}
                        (0x{application.applicationType.toString(16).padStart(4, '0')})
                      </span>
                    </td>
                    <td className="mono">{application.organizationId}</td>
                    <td className="mono">{application.applicationId}</td>
                    <td className="num">{application.controlCode}</td>
                    <td>{application.name ?? '-'}</td>
                    <td className="mono small">
                      {application.urls && application.urls.length > 0
                        ? application.urls.join(' ')
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
