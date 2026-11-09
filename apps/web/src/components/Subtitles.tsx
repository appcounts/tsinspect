import type {
  Atsc608PreviewFrame,
  Atsc708PreviewFrame,
  ProbeResult,
  SubtitleCategory,
  SubtitleCue,
  SubtitlePreview,
  SubtitlePreviewFrame,
  SubtitleReport,
  SubtitleStreamReport,
  TextPreviewFrame,
  TextPreviewGlyph,
} from '@tsinspect/core';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { formatCueTime } from '../format';
import { type UiKey, useT } from '../i18n';
import { AccessibilityCell, DataTable } from './shared';
import { TeletextBrowser } from './TeletextBrowser';

const SUBTITLE_CATEGORY_ORDER: SubtitleCategory[] = ['teletext', 'subtitle', 'caption', 'vbi'];

const SUBTITLE_CATEGORY_LABEL: Record<SubtitleCategory, UiKey> = {
  teletext: 'subtitles.category.teletext',
  subtitle: 'subtitles.category.subtitle',
  caption: 'subtitles.category.caption',
  vbi: 'subtitles.category.vbi',
};

const SUBTITLE_CATEGORY_SHORT: Record<SubtitleCategory, UiKey> = {
  teletext: 'subtitles.category.short.teletext',
  subtitle: 'subtitles.category.short.subtitle',
  caption: 'subtitles.category.short.caption',
  vbi: 'subtitles.category.short.vbi',
};

const SUBTITLE_CATEGORY_HINT: Record<SubtitleCategory, UiKey> = {
  teletext: 'subtitles.category.hint.teletext',
  subtitle: 'subtitles.category.hint.subtitle',
  caption: 'subtitles.category.hint.caption',
  vbi: 'subtitles.category.hint.vbi',
};

export function Subtitles({
  result,
  report,
  loading,
  query,
  sessionId,
}: {
  result: ProbeResult;
  report: SubtitleReport | null;
  loading: boolean;
  query: string;
  sessionId?: string;
}) {
  const t = useT();
  const [selectedProgram, setSelectedProgram] = useState<number | undefined>(undefined);
  const [category, setCategory] = useState<'all' | SubtitleCategory>('all');

  useEffect(() => {
    setSelectedProgram(report?.services[0]?.programNumber);
    setCategory('all');
  }, [report]);

  if (loading) {
    return (
      <section className="panel page-panel">
        <p className="muted">{t('subtitles.loading')}</p>
      </section>
    );
  }
  if (!report || report.services.length === 0) {
    return (
      <section className="panel page-panel">
        <p className="muted">{t('subtitles.none')}</p>
      </section>
    );
  }

  const q = query.trim().toLowerCase();
  const allStreams = report.services.flatMap((service) => service.streams);
  const categoryCount = (target: SubtitleCategory): number =>
    allStreams.filter((stream) => stream.category === target).length;
  const categoryMatches = (stream: SubtitleStreamReport): boolean =>
    category === 'all' || stream.category === category;
  const streamMatchesQuery = (stream: SubtitleStreamReport): boolean =>
    `${stream.pidHex} ${stream.format} ${stream.formatName}`.toLowerCase().includes(q) ||
    stream.cues.some(
      (cue) => cue.text.toLowerCase().includes(q) || (cue.label ?? '').toLowerCase().includes(q),
    );

  const visibleServices = report.services.filter((service) => {
    const streams = service.streams.filter(categoryMatches);
    if (streams.length === 0) return false;
    if (!q) return true;
    const serviceMatches =
      (service.name ?? '').toLowerCase().includes(q) || String(service.programNumber).includes(q);
    return serviceMatches || streams.some(streamMatchesQuery);
  });
  const service =
    visibleServices.find((entry) => entry.programNumber === selectedProgram) ?? visibleServices[0];
  const streams = service
    ? service.streams
        .filter(categoryMatches)
        .map((stream) => {
          if (!q) return stream;
          const cues = stream.cues.filter(
            (cue) =>
              cue.text.toLowerCase().includes(q) || (cue.label ?? '').toLowerCase().includes(q),
          );
          const metadata = `${stream.pidHex} ${stream.format} ${stream.formatName}`
            .toLowerCase()
            .includes(q);
          return cues.length > 0 || metadata
            ? { ...stream, cues, cueCount: cues.length }
            : undefined;
        })
        .filter((stream): stream is SubtitleStreamReport => stream !== undefined)
    : [];
  const groups = SUBTITLE_CATEGORY_ORDER.filter(
    (target) => category === 'all' || target === category,
  )
    .map((target) => ({
      category: target,
      streams: streams.filter((stream) => stream.category === target),
    }))
    .filter((group) => group.streams.length > 0);

  return (
    <>
      <div className="subtitle-filter" role="group" aria-label={t('subtitles.filter.hint')}>
        <button
          className={category === 'all' ? 'active' : ''}
          aria-pressed={category === 'all'}
          onClick={() => setCategory('all')}
        >
          {t('subtitles.filter.all')}
          <span className="filter-count">{allStreams.length}</span>
        </button>
        {SUBTITLE_CATEGORY_ORDER.map((target) => {
          const count = categoryCount(target);
          if (count === 0) return null;
          return (
            <button
              key={target}
              className={category === target ? 'active' : ''}
              aria-pressed={category === target}
              onClick={() => setCategory(target)}
            >
              {t(SUBTITLE_CATEGORY_SHORT[target])}
              <span className="filter-count">{count}</span>
            </button>
          );
        })}
        <span className="muted small subtitle-filter-hint">{t('subtitles.filter.hint')}</span>
      </div>

      <div className="subtitles-grid">
        <section className="panel service-panel">
          <div className="panel-head">
            <div>
              <h2>{t('overview.services')}</h2>
              <p>{t('subtitles.serviceHint')}</p>
            </div>
            <span className="count-pill">{visibleServices.length}</span>
          </div>
          <div className="service-list">
            {visibleServices.length === 0 ? (
              <p className="muted small">{t('subtitles.noMatches')}</p>
            ) : (
              visibleServices.map((entry) => {
                const count = entry.streams.reduce((sum, stream) => sum + stream.cueCount, 0);
                const bitmapFrames = entry.streams.reduce(
                  (sum, stream) =>
                    sum + (stream.preview?.kind === 'bitmap' ? stream.preview.frames.length : 0),
                  0,
                );
                const breakdown = SUBTITLE_CATEGORY_ORDER.map((target) => ({
                  target,
                  count: entry.streams.filter((stream) => stream.category === target).length,
                }))
                  .filter((item) => item.count > 0)
                  .map((item) => `${t(SUBTITLE_CATEGORY_SHORT[item.target])} ${item.count}`)
                  .join(' · ');
                return (
                  <button
                    key={entry.programNumber}
                    className={`service-item ${
                      service?.programNumber === entry.programNumber ? 'active' : ''
                    }`}
                    onClick={() => setSelectedProgram(entry.programNumber)}
                  >
                    <span className="service-name">
                      {entry.name || t('services.unnamed')}
                      <span className="service-number">#{entry.programNumber}</span>
                    </span>
                    <span className="service-meta">
                      {[
                        breakdown,
                        t('subtitles.cues', { count }),
                        bitmapFrames > 0
                          ? t('subtitles.bitmapFrames', { count: bitmapFrames })
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </section>

        <div className="subtitle-panels">
          {groups.length === 0 ? (
            <section className="panel page-panel">
              <p className="muted">{q ? t('subtitles.noMatches') : t('subtitles.emptyCues')}</p>
            </section>
          ) : (
            groups.map((group) => (
              <section className="subtitle-group" key={group.category}>
                <div className="subtitle-group-head">
                  <h3>{t(SUBTITLE_CATEGORY_LABEL[group.category])}</h3>
                  <span className={`subtitle-kind ${group.category}`}>
                    {t(SUBTITLE_CATEGORY_SHORT[group.category])}
                  </span>
                  <span className="muted small">
                    {t('subtitles.streams', { count: group.streams.length })}
                  </span>
                </div>
                <p className="muted small subtitle-group-hint">
                  {t(SUBTITLE_CATEGORY_HINT[group.category])}
                </p>
                <div className="subtitle-group-cards">
                  {group.streams.map((stream) => (
                    <SubtitleStreamCard
                      key={`${stream.pid}:${stream.format}:${stream.mode ?? ''}:${stream.channel ?? ''}:${stream.service ?? ''}`}
                      stream={stream}
                      result={result}
                      sessionId={sessionId}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </>
  );
}

const TELETEXT_COLORS = [
  '#000000',
  '#ff5555',
  '#55ff55',
  '#ffff55',
  '#5599ff',
  '#ff55ff',
  '#55ffff',
  '#ffffff',
];

interface BitmapFrameRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  palette: string;
  pixels: string;
}

interface BitmapFrameResponse {
  frame: {
    width: number;
    height: number;
    window?: { x: number; y: number; width: number; height: number };
    regions: BitmapFrameRegion[];
  } | null;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseHexColor(value: string): [number, number, number] {
  const clean = value.replace(/^#/, '');
  if (clean.length === 3) {
    const r = clean.charAt(0);
    const g = clean.charAt(1);
    const b = clean.charAt(2);
    return [Number.parseInt(r + r, 16), Number.parseInt(g + g, 16), Number.parseInt(b + b, 16)];
  }
  return [
    Number.parseInt(clean.slice(0, 2), 16) || 0,
    Number.parseInt(clean.slice(2, 4), 16) || 0,
    Number.parseInt(clean.slice(4, 6), 16) || 0,
  ];
}

function SubtitlePreviewPlayer({
  preview,
  sessionId,
  pid,
}: {
  preview: SubtitlePreview;
  sessionId?: string;
  pid: number;
}) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frames = preview.frames;
  const first = frames[0];
  const last = frames[frames.length - 1];
  const start = first?.start ?? 0;
  const end = last?.end ?? start + 5;
  const [time, setTime] = useState(start);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [bitmap, setBitmap] = useState<BitmapFrameResponse['frame']>(null);

  useEffect(() => {
    setTime(start);
    setPlaying(false);
    setBitmap(null);
  }, [preview, start]);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setTime((previous) => {
        const next = previous + 0.1 * rate;
        return next >= end ? start : next;
      });
    }, 100);
    return () => window.clearInterval(id);
  }, [playing, start, end, rate]);

  const frame =
    frames.find((entry) => time >= entry.start && time < entry.end) ??
    (time >= end ? last : undefined);

  // ARIB FLC flashing blinks at 1 Hz while playing. Keep the paused frame
  // fully visible so scrubbing does not land on a hidden phase.
  const flashHidden = playing && Math.floor(time / 0.5) % 2 === 1;

  useEffect(() => {
    if (preview.kind !== 'bitmap' || !sessionId) {
      setBitmap(null);
      return;
    }
    const controller = new AbortController();
    api<BitmapFrameResponse>(
      `/api/sessions/${sessionId}/subtitles/frame?pid=${pid}&time=${time.toFixed(3)}`,
      { signal: controller.signal },
    )
      .then((response) => {
        if (!controller.signal.aborted) setBitmap(response.frame);
      })
      .catch(() => {
        if (!controller.signal.aborted) setBitmap(null);
      });
    return () => controller.abort();
  }, [preview.kind, sessionId, pid, time]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);

    if (preview.kind === 'atsc608') {
      const atscFrame = frame as Atsc608PreviewFrame | undefined;
      const rows = atscFrame?.rows ?? [];
      const gridHeight = Math.min(canvas.height, (canvas.width * 3) / 4);
      const gridWidth = (gridHeight * 4) / 3;
      const offsetX = (canvas.width - gridWidth) / 2;
      const offsetY = (canvas.height - gridHeight) / 2;
      const cellWidth = gridWidth / 32;
      const cellHeight = gridHeight / 15;
      context.textBaseline = 'top';
      context.textAlign = 'left';
      for (const row of rows) {
        const y = offsetY + row.row * cellHeight;
        for (let column = 0; column < row.cells.length; column += 1) {
          const cell = row.cells[column];
          if (!cell || cell.char === ' ') continue;
          const x = offsetX + column * cellWidth;
          if (cell.background) {
            context.fillStyle = cell.background;
            context.fillRect(x, y, cellWidth + 0.5, cellHeight + 0.5);
          }
          context.fillStyle = cell.color ?? '#ffffff';
          context.font = `${cell.italics ? 'italic ' : ''}600 ${Math.floor(
            cellHeight * 0.9,
          )}px "Courier New", ui-monospace, monospace`;
          context.fillText(cell.char, x, y, cellWidth);
          if (cell.underline) {
            context.fillRect(x, y + cellHeight * 0.88, cellWidth, Math.max(1, cellHeight * 0.06));
          }
        }
      }
      return;
    }

    if (preview.kind === 'atsc708') {
      const atscFrame = frame as Atsc708PreviewFrame | undefined;
      const windows = atscFrame?.windows ?? [];
      for (const window of windows) {
        const fillOpacity = window.fillOpacity ?? 0;
        if (window.fillColor && fillOpacity !== 3) {
          context.save();
          context.globalAlpha = fillOpacity === 2 ? 0.6 : 1;
          context.fillStyle = window.fillColor;
          context.fillRect(window.x, window.y, window.width, window.height);
          context.restore();
        }
        const cellWidth = window.width / Math.max(1, window.columnCount);
        const cellHeight = window.height / Math.max(1, window.rowCount);
        context.textBaseline = 'top';
        context.textAlign = 'left';
        for (let row = 0; row < window.rows.length; row += 1) {
          const cells = window.rows[row] ?? [];
          for (let column = 0; column < cells.length; column += 1) {
            const cell = cells[column];
            if (!cell || cell.char === ' ') continue;
            const x = window.x + column * cellWidth;
            const y = window.y + row * cellHeight;
            if (cell.bg && cell.bg !== '#000000') {
              context.fillStyle = cell.bg;
              context.fillRect(x, y, cellWidth + 0.5, cellHeight + 0.5);
            }
            context.fillStyle = cell.fg ?? '#ffffff';
            context.font = `${cell.italics ? 'italic ' : ''}600 ${Math.floor(
              cellHeight * 0.85,
            )}px "Segoe UI", system-ui, sans-serif`;
            context.fillText(cell.char, x, y, cellWidth);
            if (cell.underline) {
              context.fillRect(x, y + cellHeight * 0.86, cellWidth, Math.max(1, cellHeight * 0.07));
            }
          }
        }
        if (window.borderType) {
          context.strokeStyle = window.borderColor ?? '#ffffff';
          context.lineWidth = 1;
          context.strokeRect(window.x, window.y, window.width, window.height);
        }
      }
      return;
    }

    if (preview.kind === 'text') {
      const textFrame = frame as TextPreviewFrame | undefined;
      const styledLines = textFrame?.styledLines ?? [];
      const fontFamily =
        '"Segoe UI", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", system-ui, sans-serif';
      const fontMetrics = preview.metrics;
      const display = textFrame?.display;
      const planeWidth = display?.planeWidth ?? fontMetrics?.planeWidth ?? canvas.width;
      const planeHeight = display?.planeHeight ?? fontMetrics?.planeHeight ?? canvas.height;
      const scaleX = canvas.width / planeWidth;
      const scaleY = canvas.height / planeHeight;
      const hasFontMetrics = display?.fontHeight !== undefined || fontMetrics !== undefined;
      const glyphWidth = (display?.fontWidth ?? fontMetrics?.fontWidth ?? 36) * scaleX;
      const glyphHeight = (display?.fontHeight ?? fontMetrics?.fontHeight ?? 36) * scaleY;
      const gapX = (display?.horizontalSpacing ?? fontMetrics?.horizontalSpacing ?? 4) * scaleX;
      const gapY = (display?.verticalSpacing ?? fontMetrics?.verticalSpacing ?? 24) * scaleY;
      const baseFont = hasFontMetrics
        ? glyphHeight
        : Math.max(12, Math.round(canvas.height * 0.05));
      const cellWidth = hasFontMetrics ? glyphWidth + gapX : baseFont;
      const cellHeight = hasFontMetrics ? glyphHeight + gapY : baseFont * 1.25;
      const vertical = display?.vertical === true;

      const metricsDisplay = fontMetrics?.display;
      const displayX =
        display?.x !== undefined ? display.x * scaleX : (metricsDisplay?.x ?? 0) * scaleX;
      const displayY =
        display?.y !== undefined ? display.y * scaleY : (metricsDisplay?.y ?? 0) * scaleY;
      const displayWidth =
        display?.width !== undefined
          ? display.width * scaleX
          : metricsDisplay?.width !== undefined
            ? metricsDisplay.width * scaleX
            : canvas.width;
      const displayHeight =
        display?.height !== undefined
          ? display.height * scaleY
          : metricsDisplay?.height !== undefined
            ? metricsDisplay.height * scaleY
            : canvas.height;

      const glyphMap = new Map<string, TextPreviewGlyph>();
      for (const glyph of textFrame?.drcs ?? []) glyphMap.set(glyph.char, glyph);

      const glyphImageCache = new Map<string, HTMLCanvasElement>();
      const glyphImage = (glyph: TextPreviewGlyph, color: string): HTMLCanvasElement => {
        const key = `${glyph.char}|${color}`;
        const cached = glyphImageCache.get(key);
        if (cached) return cached;
        const pixels = decodeBase64(glyph.pixels);
        const [r, g, b] = parseHexColor(color);
        const image = new ImageData(glyph.width, glyph.height);
        for (let i = 0; i < glyph.width * glyph.height; i += 1) {
          const alpha = pixels[i] ?? 0;
          image.data[i * 4] = r;
          image.data[i * 4 + 1] = g;
          image.data[i * 4 + 2] = b;
          image.data[i * 4 + 3] = alpha;
        }
        const offscreen = document.createElement('canvas');
        offscreen.width = glyph.width;
        offscreen.height = glyph.height;
        offscreen.getContext('2d')?.putImageData(image, 0, 0);
        glyphImageCache.set(key, offscreen);
        return offscreen;
      };

      const runFont = (run: TextPreviewFrame['styledLines'][number]['runs'][number]): string => {
        const fontSize = baseFont * (run.style.heightScale ?? 1);
        const weight = run.style.bold ? '700' : '600';
        const italic = run.style.italic ? 'italic ' : '';
        return `${italic}${weight} ${fontSize}px ${fontFamily}`;
      };

      type PreviewLine = TextPreviewFrame['styledLines'][number];
      type PreviewRun = PreviewLine['runs'][number];
      const renderLines: PreviewLine[] =
        styledLines.length > 0
          ? styledLines
          : (textFrame?.lines ?? []).map((text) => ({ runs: [{ text, style: {} }] }));

      if (vertical && renderLines.length > 0) {
        const columnPitch = glyphWidth + gapY;
        const charPitch = glyphHeight + gapX;
        const areaRight = displayX + displayWidth;
        const areaTop = displayY;

        const drawVerticalChar = (
          char: string,
          centerX: number,
          centerY: number,
          run: PreviewRun,
        ): void => {
          if (run.style.conceal) return;
          if (flashHidden && run.style.flash) return;
          const color = run.style.color ?? '#ffffff';
          const ornamentColor = run.style.ornamentColor ?? 'rgba(0, 0, 0, 0.85)';
          const ornament = run.style.ornament ?? 'none';
          const glyph = glyphMap.get(char);
          // Vertical writing flows top-to-bottom, but glyphs stay upright so
          // the characters remain readable.
          context.save();
          context.translate(centerX, centerY);
          context.scale(run.style.widthScale ?? 1, 1);
          if (glyph) {
            const drawGlyph = (tint: string, dx: number, dy: number): void => {
              context.drawImage(
                glyphImage(glyph, tint),
                -glyphWidth / 2 + dx,
                -glyphHeight / 2 + dy,
                glyphWidth,
                glyphHeight,
              );
            };
            if (ornament === 'outline') {
              // Keep the border at least 2 device pixels: the preview canvas is
              // downscaled in the page, where a 1px outline disappears.
              const edge = Math.max(2, glyphWidth * 0.08);
              for (const [dx, dy] of [
                [-edge, 0],
                [edge, 0],
                [0, -edge],
                [0, edge],
                [-edge, -edge],
                [edge, -edge],
                [-edge, edge],
                [edge, edge],
              ] as const) {
                drawGlyph(ornamentColor, dx, dy);
              }
            } else if (ornament === 'shadow') {
              drawGlyph(ornamentColor, glyphWidth * 0.08, glyphHeight * 0.1);
            }
            drawGlyph(color, 0, 0);
          } else {
            context.font = runFont(run);
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.lineJoin = 'round';
            if (ornament === 'outline') {
              const edge = Math.max(2, baseFont * 0.1);
              context.fillStyle = ornamentColor;
              for (const [dx, dy] of [
                [-edge, 0],
                [edge, 0],
                [0, -edge],
                [0, edge],
                [-edge, -edge],
                [edge, -edge],
                [-edge, edge],
                [edge, edge],
              ] as const) {
                context.fillText(char, dx, dy);
              }
            } else if (ornament === 'shadow') {
              context.fillStyle = ornamentColor;
              context.fillText(char, baseFont * 0.08, baseFont * 0.1);
            }
            if (ornament === 'hollow') {
              context.lineWidth = Math.max(1.5, baseFont * 0.09);
              context.strokeStyle = color;
              context.strokeText(char, 0, 0);
            } else {
              context.fillStyle = color;
              context.fillText(char, 0, 0);
            }
          }
          context.restore();
        };

        renderLines.forEach((line, index) => {
          // APS row selects the column; vertical columns run right to left.
          const columnIndex = line.row ?? index;
          const columnLeft =
            line.x !== undefined
              ? line.x * scaleX
              : areaRight - glyphWidth - columnIndex * columnPitch;
          const centerX = columnLeft + glyphWidth / 2;
          let cursorY =
            line.y !== undefined ? line.y * scaleY : areaTop + (line.column ?? 0) * charPitch;

          for (const run of line.runs) {
            for (const char of run.text) {
              if (char === ' ' || char === '\t') {
                cursorY += charPitch;
                continue;
              }
              if (run.style.background) {
                context.fillStyle = run.style.background;
                // Fill the full column cell so neighbouring columns tile.
                context.fillRect(columnLeft - gapY, cursorY, columnPitch, charPitch);
              }
              drawVerticalChar(char, centerX, cursorY + glyphHeight / 2, run);
              if (run.style.underline && !(flashHidden && run.style.flash)) {
                const thickness = Math.max(2, glyphHeight * 0.08);
                context.fillStyle = run.style.color ?? '#ffffff';
                context.fillRect(
                  columnLeft + glyphWidth - thickness,
                  cursorY,
                  thickness,
                  charPitch,
                );
              }
              cursorY += charPitch;
            }
          }
        });
        return;
      }

      if (styledLines.length === 0) {
        const lines = textFrame?.lines ?? [];
        if (lines.length === 0) return;
        const baseY = displayY + displayHeight - baseFont * 0.8;
        context.font = `600 ${baseFont}px ${fontFamily}`;
        context.textAlign = 'center';
        context.textBaseline = 'bottom';
        context.lineJoin = 'round';
        lines.forEach((line, index) => {
          const y = baseY - (lines.length - 1 - index) * cellHeight;
          context.lineWidth = Math.max(2, baseFont * 0.12);
          context.strokeStyle = 'rgba(0, 0, 0, 0.9)';
          context.fillStyle = '#ffffff';
          context.strokeText(line, displayX + displayWidth / 2, y);
          context.fillText(line, displayX + displayWidth / 2, y);
        });
        return;
      }

      const lineMetrics = styledLines.map((line) => {
        const fontSize = Math.max(
          baseFont,
          ...line.runs.map((run) => baseFont * (run.style.heightScale ?? 1)),
        );
        // ARIB places every character in a fixed cell, so a line's width is
        // the character count times the cell pitch, not the summed glyph
        // widths of the proportional font.
        const width = line.runs.reduce(
          (sum, run) => sum + [...run.text].length * cellWidth * (run.style.widthScale ?? 1),
          0,
        );
        return {
          line,
          fontSize,
          height: Math.max(cellHeight, fontSize * 1.25),
          width,
        };
      });

      const explicitPosition = lineMetrics.some(
        (metric) => metric.line.y !== undefined || metric.line.row !== undefined,
      );
      const totalHeight = lineMetrics.reduce((sum, metric) => sum + metric.height, 0);
      let stackTop = displayY + displayHeight - totalHeight;

      for (const metric of lineMetrics) {
        const { line, fontSize, height, width } = metric;
        let baseline =
          line.y !== undefined
            ? line.y * scaleY
            : explicitPosition
              ? displayY + fontSize
              : stackTop + fontSize;
        if (line.row !== undefined) {
          baseline = displayY + (line.row + 1) * cellHeight - 1;
        }

        let x =
          line.x !== undefined
            ? line.x * scaleX
            : line.column !== undefined
              ? displayX + line.column * cellWidth
              : displayX + (displayWidth - width) / 2;

        for (const run of line.runs) {
          const runSize = baseFont * (run.style.heightScale ?? 1);
          const widthScale = run.style.widthScale ?? 1;
          const advance = [...run.text].length * cellWidth * widthScale;
          const runStart = x;
          const color = run.style.color ?? '#ffffff';
          const ornamentColor = run.style.ornamentColor ?? 'rgba(0, 0, 0, 0.85)';
          const ornament = run.style.ornament ?? 'none';
          const flashOff = flashHidden && run.style.flash === true;

          if (run.style.background) {
            context.fillStyle = run.style.background;
            // The raster background covers the whole character cell (including
            // the spacing) so adjacent rows tile without gaps and the underline
            // stays inside the coloured band.
            context.fillRect(x, baseline - glyphHeight, advance, height);
          }

          if (!run.style.conceal) {
            for (const char of run.text) {
              const glyph = glyphMap.get(char);
              const cellCenter = x + (cellWidth * widthScale) / 2;
              context.save();
              // Flashing runs blink by drawing transparent during the off phase.
              if (flashOff) context.globalAlpha = 0;
              context.translate(cellCenter, baseline);
              context.scale(widthScale, 1);
              if (glyph) {
                const glyphWidth = runSize * (glyph.width / glyph.height);
                const drawGlyph = (tint: string, offsetX: number, offsetY: number): void => {
                  context.drawImage(
                    glyphImage(glyph, tint),
                    -glyphWidth / 2 + offsetX,
                    -runSize + offsetY,
                    glyphWidth,
                    runSize,
                  );
                };
                if (ornament === 'outline') {
                  const edge = Math.max(2, runSize * 0.08);
                  for (const [dx, dy] of [
                    [-edge, 0],
                    [edge, 0],
                    [0, -edge],
                    [0, edge],
                    [-edge, -edge],
                    [edge, -edge],
                    [-edge, edge],
                    [edge, edge],
                  ] as const) {
                    drawGlyph(ornamentColor, dx, dy);
                  }
                } else if (ornament === 'shadow') {
                  drawGlyph(ornamentColor, runSize * 0.08, runSize * 0.1);
                }
                drawGlyph(color, 0, 0);
              } else {
                context.font = runFont(run);
                context.textAlign = 'center';
                context.textBaseline = 'alphabetic';
                context.lineJoin = 'round';
                if (ornament === 'outline') {
                  const edge = Math.max(2, runSize * 0.1);
                  context.fillStyle = ornamentColor;
                  for (const [dx, dy] of [
                    [-edge, 0],
                    [edge, 0],
                    [0, -edge],
                    [0, edge],
                    [-edge, -edge],
                    [edge, -edge],
                    [-edge, edge],
                    [edge, edge],
                  ] as const) {
                    context.fillText(char, dx, dy);
                  }
                } else if (ornament === 'shadow') {
                  context.fillStyle = ornamentColor;
                  context.fillText(char, runSize * 0.08, runSize * 0.1);
                }
                if (ornament === 'hollow') {
                  context.lineWidth = Math.max(1.5, runSize * 0.09);
                  context.strokeStyle = color;
                  context.strokeText(char, 0, 0);
                } else {
                  context.fillStyle = color;
                  context.fillText(char, 0, 0);
                }
              }
              context.restore();
              x += cellWidth * widthScale;
            }

            if (run.style.underline && !flashOff) {
              context.fillStyle = color;
              context.fillRect(
                runStart,
                baseline + runSize * 0.12,
                advance,
                Math.max(2, runSize * 0.08),
              );
            }
          } else {
            x += advance;
          }
        }

        if (!explicitPosition) stackTop += height;
      }
      return;
    }

    if (preview.kind === 'teletext') {
      const layer = (frame as SubtitlePreviewFrame | undefined)?.layer;
      if (!layer || layer.kind !== 'teletext') return;

      // A Teletext page is a full-screen text layer with a black page background.
      context.fillStyle = '#000000';
      context.fillRect(0, 0, canvas.width, canvas.height);

      const cellWidth = canvas.width / layer.columns;
      const cellHeight = canvas.height / layer.rows;
      for (const line of layer.lines) {
        for (let column = 0; column < line.cells.length; column += 1) {
          const cell = line.cells[column];
          if (!cell) continue;
          const x = column * cellWidth;
          const y = line.row * cellHeight;
          const height = cell.doubleHeight ? cellHeight * 2 : cellHeight;
          const background = cell.bg >= 0 ? cell.bg : cell.boxed ? 0 : -1;
          if (background >= 0) {
            context.fillStyle = TELETEXT_COLORS[background] ?? '#000000';
            context.fillRect(x, y, cellWidth + 0.5, height + 0.5);
          }
          if (cell.conceal) continue;
          if (cell.mosaic && cell.mosaicBits !== undefined) {
            const blockWidth = cellWidth / 2;
            const blockHeight = height / 3;
            context.fillStyle = TELETEXT_COLORS[cell.fg] ?? '#ffffff';
            for (let bit = 0; bit < 6; bit += 1) {
              if ((cell.mosaicBits & (1 << (5 - bit))) !== 0) {
                context.fillRect(
                  x + (bit % 2) * blockWidth,
                  y + Math.floor(bit / 2) * blockHeight,
                  blockWidth + 0.5,
                  blockHeight + 0.5,
                );
              }
            }
          } else if (cell.char !== ' ') {
            context.fillStyle = TELETEXT_COLORS[cell.fg] ?? '#ffffff';
            context.font = `${Math.floor(height * 0.92)}px ui-monospace, SFMono-Regular, Consolas, monospace`;
            context.textBaseline = 'top';
            context.fillText(cell.char, x, y, cellWidth);
          }
        }
      }
      return;
    }

    if (!bitmap) return;
    context.save();
    if (bitmap.window) {
      context.beginPath();
      context.rect(bitmap.window.x, bitmap.window.y, bitmap.window.width, bitmap.window.height);
      context.clip();
    }
    for (const region of bitmap.regions) {
      const palette = decodeBase64(region.palette);
      const pixels = decodeBase64(region.pixels);
      const image = context.createImageData(region.width, region.height);
      for (let index = 0; index < region.width * region.height; index += 1) {
        const code = pixels[index] ?? 0;
        const p = code * 4;
        image.data[index * 4] = palette[p] ?? 0;
        image.data[index * 4 + 1] = palette[p + 1] ?? 0;
        image.data[index * 4 + 2] = palette[p + 2] ?? 0;
        image.data[index * 4 + 3] = palette[p + 3] ?? 0;
      }
      context.putImageData(image, region.x, region.y);
    }
    context.restore();
  }, [frame, preview, bitmap, flashHidden]);

  if (frames.length === 0) return null;

  return (
    <div className="subtitle-preview">
      <div className="subtitle-preview-head">
        <span>{t('subtitles.preview.title')}</span>
        <span className="muted small">
          {preview.width}×{preview.height}
          {preview.kind === 'teletext' && frame && 'label' in frame && frame.label
            ? ` · ${t('subtitles.preview.page', { value: frame.label })}`
            : ''}
          {preview.truncated ? ` · ${t('subtitles.preview.truncated')}` : ''}
        </span>
      </div>
      <div
        className={`subtitle-preview-stage${
          preview.kind === 'text' || preview.kind === 'atsc608' || preview.kind === 'atsc708'
            ? ' text-layer'
            : ''
        }`}
        style={{ aspectRatio: `${preview.width} / ${preview.height}` }}
      >
        <canvas ref={canvasRef} width={preview.width} height={preview.height} />
      </div>
      {preview.kind === 'text' ? (
        <p className="muted small subtitle-preview-note">{t('subtitles.preview.textOnly')}</p>
      ) : null}
      <div className="subtitle-preview-controls">
        <button className="ghost tiny" onClick={() => setPlaying((value) => !value)}>
          {playing ? t('subtitles.preview.pause') : t('subtitles.preview.play')}
        </button>
        <span
          className="subtitle-preview-rates"
          role="group"
          aria-label={t('subtitles.preview.rate')}
        >
          {[1, 2, 4].map((value) => (
            <button
              key={value}
              className={`ghost tiny ${rate === value ? 'active' : ''}`}
              aria-pressed={rate === value}
              onClick={() => setRate(value)}
            >
              {value}x
            </button>
          ))}
        </span>
        <input
          type="range"
          min={start}
          max={Math.max(end, start + 0.1)}
          step={0.05}
          value={time}
          onChange={(event) => {
            setPlaying(false);
            setTime(Number(event.target.value));
          }}
          aria-label={t('subtitles.preview.title')}
        />
        <span className="mono small nowrap">{formatCueTime(time)}</span>
      </div>
    </div>
  );
}

function SubtitleStreamCard({
  stream,
  result,
  sessionId,
}: {
  stream: SubtitleStreamReport;
  result: ProbeResult;
  sessionId?: string;
}) {
  const t = useT();
  const source = result.services
    .flatMap((service) => service.streams)
    .find((entry) => entry.pid === stream.pid);
  const pageIds = stream.pageIds?.map(
    (value) => `0x${value.toString(16).padStart(4, '0').toUpperCase()}`,
  );

  return (
    <section className="panel subtitle-stream">
      <div className="subtitle-stream-head">
        <div>
          <h2>
            <span className={`subtitle-kind ${stream.category}`}>
              {t(SUBTITLE_CATEGORY_SHORT[stream.category])}
            </span>{' '}
            {t(`subtitles.format.${stream.format}` as UiKey)}
            {stream.mode ? ` · ${stream.mode === '608' ? 'CEA-608' : 'CEA-708'}` : ''}{' '}
            <span className="soft-badge">PID {stream.pidHex}</span>
          </h2>
          <p>
            {t('subtitles.cues', { count: stream.cueCount })}
            {stream.preview?.kind === 'bitmap'
              ? ` · ${t('subtitles.bitmapFrames', { count: stream.preview.frames.length })}`
              : ''}
            {stream.truncated ? ` · ${t('subtitles.truncated')}` : ''}
          </p>
        </div>
        <AccessibilityCell descriptors={source?.descriptors ?? []} kind={source?.es?.kind} />
      </div>

      <div className="subtitle-meta">
        {stream.mode ? (
          <span className="cap-badge">{t('subtitles.mode', { value: stream.mode })}</span>
        ) : null}
        {stream.channel ? <span className="cap-badge">CC{stream.channel}</span> : null}
        {stream.service ? <span className="cap-badge">Service {stream.service}</span> : null}
        {stream.segmentCount !== undefined ? (
          <span className="cap-badge">
            {t('subtitles.segments', { count: stream.segmentCount })}
          </span>
        ) : null}
        {pageIds && pageIds.length > 0 ? (
          <span className="cap-badge">{t('subtitles.pages', { value: pageIds.join(', ') })}</span>
        ) : null}
        {stream.unitCount !== undefined ? (
          <span className="cap-badge">{t('subtitles.units', { count: stream.unitCount })}</span>
        ) : null}
        {stream.dtvccBytes !== undefined ? (
          <span className="cap-badge">
            {t('subtitles.dtvccBytes', { count: stream.dtvccBytes })}
          </span>
        ) : null}
        {stream.captionLanguages && stream.captionLanguages.length > 0 ? (
          <span className="cap-badge" title={t('subtitles.languages')}>
            {stream.captionLanguages.map((language) => language.code).join(', ')}
          </span>
        ) : null}
      </div>

      {stream.note ? <p className="muted small subtitle-note">{stream.note}</p> : null}
      {stream.preview ? (
        <SubtitlePreviewPlayer preview={stream.preview} sessionId={sessionId} pid={stream.pid} />
      ) : (
        <p className="muted small subtitle-note">{t('subtitles.preview.pending')}</p>
      )}

      {stream.browse ? <TeletextBrowser browse={stream.browse} /> : null}

      {stream.cues.length > 0 ? (
        <div className="subtitle-cues">
          <DataTable<SubtitleCue>
            storageKey={`subtitles-${stream.pid}-${stream.format}`}
            rows={stream.cues}
            rowKey={(cue) => `${cue.start}:${cue.end}:${cue.label ?? ''}:${cue.text}`}
            initialSort={{ key: 'start', dir: 'asc' }}
            columns={[
              {
                key: 'start',
                label: t('subtitles.start'),
                align: 'num',
                render: (cue) => <span className="mono">{formatCueTime(cue.start)}</span>,
                sortValue: (cue) => cue.start,
              },
              {
                key: 'end',
                label: t('subtitles.end'),
                align: 'num',
                render: (cue) => <span className="mono">{formatCueTime(cue.end)}</span>,
                sortValue: (cue) => cue.end,
              },
              {
                key: 'page',
                label: t('subtitles.page'),
                render: (cue) => <span className="mono">{cue.label ?? '-'}</span>,
                sortValue: (cue) => cue.label ?? '',
              },
              {
                key: 'text',
                label: t('subtitles.text'),
                render: (cue) => <span className="subtitle-text">{cue.text}</span>,
                sortValue: (cue) => cue.text,
              },
            ]}
          />
        </div>
      ) : null}
    </section>
  );
}
