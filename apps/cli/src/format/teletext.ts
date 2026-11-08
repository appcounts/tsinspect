import type { ProbeResult, TeletextPage } from '@tsinspect/core';
import { teletextCharacter } from '@tsinspect/core';

const COLOR_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

interface Cell {
  character: string;
  foreground: number;
  background: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Decode one 40-byte row into cells with the active Teletext colours. */
function rowCells(raw: Uint8Array, subset: number): Cell[] {
  let foreground = 7;
  let background = -1;
  const cells: Cell[] = [];

  for (const value of raw) {
    const code = value & 0x7f;
    if (code <= 0x07) {
      foreground = code;
      cells.push({ character: ' ', foreground, background });
    } else if (code >= 0x10 && code <= 0x17) {
      foreground = code - 0x10;
      cells.push({ character: ' ', foreground, background });
    } else if (code === 0x1c) {
      background = 0;
      cells.push({ character: ' ', foreground, background });
    } else if (code === 0x1d) {
      background = foreground;
      cells.push({ character: ' ', foreground, background });
    } else if (code < 0x20) {
      cells.push({ character: ' ', foreground, background });
    } else {
      cells.push({ character: teletextCharacter(code, subset), foreground, background });
    }
  }

  return cells;
}

function renderRowCells(cells: Cell[]): string {
  let html = '';
  let index = 0;
  while (index < cells.length) {
    const first = cells[index] as Cell;
    let text = '';
    while (
      index < cells.length &&
      (cells[index] as Cell).foreground === first.foreground &&
      (cells[index] as Cell).background === first.background
    ) {
      text += (cells[index] as Cell).character;
      index += 1;
    }

    const classes: string[] = [];
    if (first.foreground !== 7) classes.push(`fg-${COLOR_NAMES[first.foreground]}`);
    if (first.background >= 0) classes.push(`bg-${COLOR_NAMES[first.background]}`);
    const escaped = escapeHtml(text);
    html += classes.length > 0 ? `<span class="${classes.join(' ')}">${escaped}</span>` : escaped;
  }
  return html;
}

function renderPage(page: TeletextPage): string {
  const rows = page.rows
    .map((text, index) => {
      const raw = page.rowData[index];
      const content =
        raw !== undefined
          ? renderRowCells(rowCells(raw, page.subset))
          : escapeHtml(text);
      return `<div class="ttx-row">${content}</div>`;
    })
    .join('');

  return `<section class="ttx-page">
    <h2>${escapeHtml(page.label)}${
      page.subtitle ? ' <span class="ttx-tag">subtitle</span>' : ''
    }${page.startTime !== undefined ? ` <span class="ttx-time">${page.startTime.toFixed(3)}s</span>` : ''}</h2>
    <div class="ttx">${rows}</div>
  </section>`;
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2rem 1.25rem 4rem;
  background: var(--bg, #ffffff);
  color: var(--fg, #1b1b1f);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 900px; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1rem; margin: 1.5rem 0 .4rem; }
.muted { color: var(--muted, #62626b); }
.ttx-page { margin: 1.25rem 0; }
.ttx-tag { font-size: 11px; font-weight: 600; color: #ffcc00; text-transform: uppercase; }
.ttx-time { font-size: 12px; font-weight: 400; color: var(--muted, #62626b); }
.ttx {
  background: #000000;
  color: #ffffff;
  border: 1px solid #333333;
  border-radius: 6px;
  padding: .75rem 1rem;
  overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 15px;
  line-height: 1.2;
  letter-spacing: .02em;
}
.ttx-row { white-space: pre; min-height: 1.2em; }
.fg-black { color: #000000; }
.fg-red { color: #ff5555; }
.fg-green { color: #55ff55; }
.fg-yellow { color: #ffff55; }
.fg-blue { color: #5599ff; }
.fg-magenta { color: #ff55ff; }
.fg-cyan { color: #55ffff; }
.fg-white { color: #ffffff; }
.bg-black { background: #000000; }
.bg-red { background: #ff5555; color: #000; }
.bg-green { background: #55ff55; color: #000; }
.bg-yellow { background: #ffff55; color: #000; }
.bg-blue { background: #5599ff; color: #000; }
.bg-magenta { background: #ff55ff; color: #000; }
.bg-cyan { background: #55ffff; color: #000; }
.bg-white { background: #ffffff; color: #000; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #151519; --fg: #ececf1; --muted: #a0a0aa; }
}
`;

export function formatTeletextHtml(
  result: ProbeResult,
  pid: number,
  pages: TeletextPage[],
): string {
  const pidHex = `0x${pid.toString(16).padStart(4, '0').toUpperCase()}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(result.source.name)} - Teletext ${pidHex}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>Teletext ${pidHex}</h1>
  <p class="muted">${escapeHtml(result.source.name)} &middot; tsinspect ${escapeHtml(
    result.tool.version,
  )} &middot; ${pages.length} page(s)</p>
  ${pages.map(renderPage).join('\n')}
</main>
</body>
</html>`;
}
