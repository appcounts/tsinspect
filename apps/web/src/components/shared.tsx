import type { DescriptorInfo } from '@tsinspect/core';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import { humanizeField, readableLanguages } from '../format';
import { type UiKey, useT } from '../i18n';

const FIELD_LABEL_KEYS: Record<string, UiKey> = {
  componentTag: 'table.field.componentTag',
  languages: 'table.field.languages',
  language: 'table.field.language',
  name: 'table.field.name',
  pages: 'table.field.pages',
  services: 'table.field.services',
  subtitleTypes: 'table.field.subtitleTypes',
  teletextTypes: 'table.field.teletextTypes',
  easyReader: 'table.field.easyReader',
  wideAspectRatio: 'table.field.wideAspectRatio',
  audioTypes: 'table.field.audioTypes',
  audioDescription: 'table.field.audioDescription',
  hearingImpaired: 'table.field.hearingImpaired',
  spokenSubtitles: 'table.field.spokenSubtitles',
  audioServiceType: 'table.field.audioServiceType',
  audioServiceTypeName: 'table.field.audioServiceTypeName',
  mixType: 'table.field.mixType',
  editorialClassification: 'table.field.editorialClassification',
  editorialClassificationName: 'table.field.editorialClassificationName',
  extensionTag: 'table.field.extensionTag',
  fullService: 'table.field.fullService',
  numChannels: 'table.field.numChannels',
  privateData: 'table.field.privateData',
  dataComponentId: 'table.field.dataComponentId',
  dataComponentName: 'table.field.dataComponentName',
  preselectionCount: 'table.field.preselectionCount',
  audioRenderingIndication: 'table.field.audioRenderingIndication',
  audioRenderingIndicationName: 'table.field.audioRenderingIndicationName',
  dialogueEnhancement: 'table.field.dialogueEnhancement',
  interactivityEnabled: 'table.field.interactivityEnabled',
};

export interface Column<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number | undefined;
  align?: 'num';
  defaultHidden?: boolean;
}

function compareValues(a: string | number | undefined, b: string | number | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export function DataTable<T>({
  storageKey,
  columns,
  rows,
  rowKey,
  toolbar,
  empty,
  initialSort,
  rowClassName,
  expand,
  onRowClick,
}: {
  storageKey: string;
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string | number;
  toolbar?: ReactNode;
  empty?: ReactNode;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  rowClassName?: (row: T) => string;
  /** Optional per-row detail panel shown below the row. */
  expand?: { render: (row: T) => ReactNode; label: string };
  /** Makes the whole row clickable; interactive children keep their own clicks. */
  onRowClick?: (row: T) => void;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const t = useT();
  const defaults = columns.filter((column) => column.defaultHidden).map((column) => column.key);
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(`tsinspect.table.${storageKey}.hidden`);
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const valid = parsed.filter(
            (key): key is string =>
              typeof key === 'string' && columns.some((column) => column.key === key),
          );
          if (valid.length < columns.length) return valid;
        }
      }
    } catch {
      // Ignore storage failures.
    }
    return defaults;
  });
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(
    initialSort ?? null,
  );

  useEffect(() => {
    try {
      localStorage.setItem(`tsinspect.table.${storageKey}.hidden`, JSON.stringify(hidden));
    } catch {
      // Ignore storage failures.
    }
  }, [hidden, storageKey]);

  const visible = columns.filter((column) => !hidden.includes(column.key));
  const sorted = sort
    ? (() => {
        const column = columns.find((candidate) => candidate.key === sort.key);
        if (!column?.sortValue) return rows;
        const direction = sort.dir === 'asc' ? 1 : -1;
        return [...rows].sort(
          (a, b) => compareValues(column.sortValue?.(a), column.sortValue?.(b)) * direction,
        );
      })()
    : rows;

  const toggleSort = (key: string): void => {
    setSort((previous) =>
      previous?.key === key
        ? { key, dir: previous.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' },
    );
  };

  const toggleColumn = (key: string): void => {
    setHidden((previous) =>
      previous.includes(key) ? previous.filter((item) => item !== key) : [...previous, key],
    );
  };

  const toggleExpanded = (key: string): void => {
    setExpanded((previous) =>
      previous.includes(key) ? previous.filter((item) => item !== key) : [...previous, key],
    );
  };

  return (
    <>
      <div className="table-toolbar">
        <div className="table-toolbar-left">{toolbar}</div>
        <details className="column-menu">
          <summary>
            {t('table.columns')}{' '}
            <span>
              {visible.length}/{columns.length}
            </span>
          </summary>
          <div className="column-popover">
            {columns.map((column) => {
              const isHidden = hidden.includes(column.key);
              return (
                <label key={column.key}>
                  <input
                    type="checkbox"
                    checked={!isHidden}
                    disabled={!isHidden && visible.length === 1}
                    onChange={() => toggleColumn(column.key)}
                  />
                  {column.label}
                </label>
              );
            })}
            <button className="ghost tiny" onClick={() => setHidden(defaults)}>
              {t('table.resetColumns')}
            </button>
          </div>
        </details>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {expand ? <th className="expand-head" aria-label={expand.label} /> : null}
              {visible.map((column) => {
                const active = sort?.key === column.key;
                return (
                  <th
                    key={column.key}
                    className={column.align === 'num' ? 'num' : undefined}
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    {column.sortValue ? (
                      <button
                        className={`sort-button ${active ? sort.dir : ''}`}
                        onClick={() => toggleSort(column.key)}
                      >
                        {column.label}
                        <span className="sort-arrow" aria-hidden>
                          {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      </button>
                    ) : (
                      column.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={Math.max(1, visible.length + (expand ? 1 : 0))} className="empty-cell">
                  {empty ?? t('table.empty')}
                </td>
              </tr>
            ) : (
              sorted.map((row) => {
                const key = String(rowKey(row));
                const isExpanded = expanded.includes(key);
                return (
                  <Fragment key={key}>
                    <tr
                      className={[rowClassName?.(row) ?? '', onRowClick ? 'row-clickable' : '']
                        .filter(Boolean)
                        .join(' ')}
                      tabIndex={onRowClick ? 0 : undefined}
                      onClick={
                        onRowClick
                          ? (event) => {
                              const target = event.target as HTMLElement | null;
                              if (target?.closest('button, a, input, summary, details')) return;
                              onRowClick(row);
                            }
                          : undefined
                      }
                      onKeyDown={
                        onRowClick
                          ? (event) => {
                              if (event.key !== 'Enter' && event.key !== ' ') return;
                              if (event.target !== event.currentTarget) return;
                              event.preventDefault();
                              onRowClick(row);
                            }
                          : undefined
                      }
                    >
                      {expand ? (
                        <td className="expand-cell">
                          <button
                            className={`expand-toggle${isExpanded ? ' open' : ''}`}
                            type="button"
                            aria-expanded={isExpanded}
                            aria-label={expand.label}
                            title={expand.label}
                            onClick={() => toggleExpanded(key)}
                          >
                            ▸
                          </button>
                        </td>
                      ) : null}
                      {visible.map((column) => (
                        <td key={column.key} className={column.align === 'num' ? 'num' : undefined}>
                          {column.render(row)}
                        </td>
                      ))}
                    </tr>
                    {expand && isExpanded ? (
                      <tr className="table-expand-row">
                        <td colSpan={visible.length + 1}>{expand.render(row)}</td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function streamAccessibility(descriptors: DescriptorInfo[]): {
  audioDescription: boolean;
  spokenSubtitles: boolean;
  hearingImpaired: boolean;
  easyReader: boolean;
  wideAspectRatio: boolean;
  language?: string;
  audioServiceType?: string;
} {
  let audioDescription = false;
  let spokenSubtitles = false;
  let hearingImpaired = false;
  let easyReader = false;
  let wideAspectRatio = false;
  let language: string | undefined;
  let fallbackLanguage: string | undefined;
  let audioServiceType: string | undefined;
  for (const descriptor of descriptors) {
    const fields = descriptor.fields ?? {};
    if (fields.audioDescription === true) audioDescription = true;
    if (fields.spokenSubtitles === true) spokenSubtitles = true;
    if (fields.hearingImpaired === true) hearingImpaired = true;
    if (fields.easyReader === true) easyReader = true;
    if (fields.wideAspectRatio === true) wideAspectRatio = true;
    if (audioServiceType === undefined && typeof fields.audioServiceTypeName === 'string') {
      const name = fields.audioServiceTypeName.trim();
      if (name.length > 0) audioServiceType = name;
    }
    const names = [
      fields.audioServiceTypeName,
      fields.editorialClassificationName,
      fields.audioTypes,
    ]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    if (names.includes('audio description') || names.includes('visually impaired')) {
      audioDescription = true;
    }
    if (names.includes('spoken subtitles')) spokenSubtitles = true;
    if (names.includes('hearing impaired')) hearingImpaired = true;
    if (language === undefined && typeof fields.language === 'string') {
      language = fields.language;
    }
    if (fallbackLanguage === undefined && typeof fields.languages === 'string') {
      fallbackLanguage = fields.languages.split(',')[0]?.trim();
    }
    if (fallbackLanguage === undefined) {
      const pages =
        typeof fields.pages === 'string'
          ? fields.pages
          : typeof fields.services === 'string'
            ? fields.services
            : undefined;
      if (pages) {
        const match = /(?:^|,\s*)([a-z]{3})\b/i.exec(pages);
        if (match?.[1]) fallbackLanguage = match[1];
      }
    }
  }
  return {
    audioDescription,
    spokenSubtitles,
    hearingImpaired,
    easyReader,
    wideAspectRatio,
    ...(audioServiceType !== undefined ? { audioServiceType } : {}),
    ...(language !== undefined
      ? { language }
      : fallbackLanguage !== undefined
        ? { language: fallbackLanguage }
        : {}),
  };
}

export function AccessibilityCell({
  descriptors,
  kind,
}: {
  descriptors: DescriptorInfo[];
  kind?: string;
}) {
  const t = useT();
  const traits = streamAccessibility(descriptors);
  const badges: Array<{ key: string; label: string }> = [];
  // ATSC audio_service_type names the track's purpose; "visually impaired"
  // is echoed verbatim so the PID is recognisable at a glance.
  if (traits.audioServiceType && /visually impaired/i.test(traits.audioServiceType)) {
    badges.push({ key: 'audio-description', label: traits.audioServiceType });
  } else if (traits.audioDescription) {
    badges.push({ key: 'audio-description', label: t('audio.audioDescription') });
  }
  if (traits.spokenSubtitles) {
    badges.push({ key: 'spoken-subtitles', label: t('audio.spokenSubtitles') });
  }
  if (traits.hearingImpaired) {
    badges.push({
      key: 'hearing-impaired',
      label: kind === 'subtitle' ? t('audio.hearingImpairedSubtitle') : t('audio.hearingImpaired'),
    });
  }
  if (traits.easyReader) {
    badges.push({ key: 'easy-reader', label: t('audio.easyReader') });
  }
  if (traits.wideAspectRatio) {
    badges.push({ key: 'wide-aspect', label: t('audio.wideAspectRatio') });
  }
  if (traits.language) {
    badges.push({ key: 'language', label: readableLanguages(traits.language) });
  }
  if (badges.length === 0) return <span className="muted">—</span>;
  return (
    <div className="trait-list">
      {badges.map((badge) => (
        <span className={`trait-badge ${badge.key}`} key={badge.key}>
          {badge.label}
        </span>
      ))}
    </div>
  );
}

export function DescriptorCell({ descriptors }: { descriptors: DescriptorInfo[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handleKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (descriptors.length === 0) {
    return <span className="muted">{t('table.descriptorEmpty')}</span>;
  }

  return (
    <>
      <button
        className="descriptor-trigger"
        onClick={() => setOpen(true)}
        title={t('table.descriptorsTitle')}
      >
        {t('table.descriptors', { count: descriptors.length })}
      </button>
      {open ? (
        <div className="descriptor-modal-backdrop" onClick={() => setOpen(false)}>
          <div
            className="descriptor-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('table.descriptorsTitle')}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="descriptor-modal-head">
              <div>
                <h2>{t('table.descriptorsTitle')}</h2>
                <p className="muted small">
                  {t('table.descriptors', { count: descriptors.length })}
                </p>
              </div>
              <button className="ghost tiny" onClick={() => setOpen(false)} autoFocus>
                {t('table.close')}
              </button>
            </div>
            <div className="descriptor-modal-body">
              <ul className="descriptor-list">
                {descriptors.map((descriptor, index) => {
                  const fields = Object.entries(descriptor.fields ?? {}).filter(
                    ([, value]) => value !== undefined,
                  );
                  return (
                    <li key={`${descriptor.tag}-${index}`}>
                      <div className="descriptor-name">
                        <span>{descriptor.name}</span>
                        <span className="descriptor-tag">{descriptor.tagHex}</span>
                      </div>
                      {fields.length > 0 ? (
                        <dl className="descriptor-fields">
                          {fields.map(([key, value]) => (
                            <div className="descriptor-field" key={key}>
                              <dt>
                                {descriptor.tag === 0x52 && key === 'componentTag'
                                  ? t('table.field.streamIdentifier')
                                  : FIELD_LABEL_KEYS[key]
                                    ? t(FIELD_LABEL_KEYS[key])
                                    : humanizeField(key)}
                              </dt>
                              <dd>
                                {typeof value === 'boolean'
                                  ? value
                                    ? t('table.yes')
                                    : t('table.no')
                                  : (key === 'language' || key === 'languages') &&
                                      typeof value === 'string'
                                    ? readableLanguages(value)
                                    : String(value)}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      ) : null}
                      {descriptor.raw ? (
                        <details className="descriptor-raw">
                          <summary>{t('table.raw')}</summary>
                          <code>{descriptor.raw}</code>
                        </details>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
