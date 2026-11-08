import { useMemo, useState, type CSSProperties } from 'react';
import type {
  TeletextBrowse,
  TeletextLayer,
  TeletextNavigation,
  TeletextPageLink,
} from '@tsinspect/core';
import { useT, type UiKey } from '../i18n';

const PALETTE = ['#000000', '#ff4b4b', '#4bff7a', '#ffe14b', '#5b8dff', '#ff6bff', '#4bffff', '#ffffff'];

function cellStyle(fg: number, bg: number): CSSProperties {
  return {
    color: PALETTE[fg] ?? PALETTE[7],
    background: bg >= 0 ? PALETTE[bg] : 'transparent',
  };
}

function TeletextScreen({ layer }: { layer: TeletextLayer }) {
  return (
    <div className="tt-screen" role="img" aria-label="Teletext page">
      {layer.lines.map((line) => (
        <div className="tt-line" key={line.row}>
          {line.cells.map((cell, index) => (
            <span
              className={`tt-cell${cell.boxed ? ' boxed' : ''}${cell.doubleHeight ? ' double' : ''}`}
              key={index}
              style={cellStyle(cell.fg, cell.bg)}
            >
              {cell.conceal ? ' ' : cell.mosaic ? (cell.mosaicBits ? '▮' : ' ') : cell.char}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

function navigationText(
  navigation: TeletextNavigation | undefined,
  t: (key: UiKey, values?: Record<string, string | number>) => string,
): string {
  if (!navigation) return t('teletext.level1');
  const facilities = [navigation.fastext ? 'Fastext' : '', navigation.top ? 'TOP' : '']
    .filter(Boolean)
    .join(' · ');
  return `${t('teletext.level', { level: navigation.level })}${facilities ? ` · ${facilities}` : ''}`;
}

export function TeletextBrowser({ browse }: { browse: TeletextBrowse }) {
  const t = useT();
  const [selected, setSelected] = useState<string | undefined>(browse.pages[0]?.label);
  const page = useMemo(
    () => browse.pages.find((item) => item.label === selected) ?? browse.pages[0],
    [browse.pages, selected],
  );
  if (!page) return null;

  const goTo = (link: TeletextPageLink): void => {
    const target = browse.pages.find((item) => item.page === link.page);
    if (target) setSelected(target.label);
  };

  return (
    <section className="teletext-browser">
      <div className="teletext-toolbar">
        <div className="teletext-title">
          <h3>{t('teletext.browse')}</h3>
          <span className="muted small">
            {t('teletext.pages', { shown: browse.pages.length, total: browse.total })}
            {browse.truncated ? ` · ${t('teletext.truncated')}` : ''}
          </span>
        </div>
        <label className="teletext-select">
          <span className="muted small">{t('teletext.page')}</span>
          <select value={page.label} onChange={(event) => setSelected(event.target.value)}>
            {browse.pages.map((item) => (
              <option value={item.label} key={item.label}>
                {item.label}
                {item.subtitle ? ` · ${t('teletext.subtitlePage')}` : ''}
              </option>
            ))}
          </select>
        </label>
        <span className="tt-nav-badge">{navigationText(page.navigation, t)}</span>
      </div>
      <TeletextScreen layer={page.layer} />
      {page.links && page.links.length > 0 ? (
        <div className="teletext-links">
          <span className="muted small">{t('teletext.links')}</span>
          {page.links.map((link, index) => (
            <button
              type="button"
              className={`tt-link ${link.color ?? ''}`}
              key={`${link.label}:${index}`}
              title={link.label}
              onClick={() => goTo(link)}
            >
              {link.label}
            </button>
          ))}
        </div>
      ) : null}
      <p className="muted small teletext-text" aria-hidden="true">
        {page.text.replace(/\n+/g, ' ').trim()}
      </p>
    </section>
  );
}
