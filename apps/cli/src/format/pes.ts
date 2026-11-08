import type { PesStreamIndex, ProbeResult } from '@tsinspect/core';
import { hex16 } from '@tsinspect/core';

export function formatPesText(result: ProbeResult, streams: PesStreamIndex[]): string {
  const lines: string[] = [];
  lines.push(`tsinspect ${result.tool.version} - PES stream index`);
  lines.push('');
  lines.push(`Source       ${result.source.name}`);
  lines.push(`Standard     ${result.standard.detected}`);
  lines.push('');
  lines.push(`PES STREAMS (${streams.length})`);
  lines.push('-----------------');
  if (streams.length === 0) {
    lines.push('  None.');
    return lines.join('\n');
  }

  const rows = streams.map((stream) => {
    const kind = result.pids.find((pid) => pid.pid === stream.pid)?.kind ?? '-';
    const first =
      stream.firstPtsSeconds !== undefined ? stream.firstPtsSeconds.toFixed(3) : '-';
    const last = stream.lastPtsSeconds !== undefined ? stream.lastPtsSeconds.toFixed(3) : '-';
    return [
      hex16(stream.pid),
      kind,
      stream.streamName,
      String(stream.packets),
      first,
      last,
    ];
  });

  const headers = ['PID', 'Kind', 'PES stream', 'PES', 'First PTS', 'Last PTS'];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  lines.push(
    `  ${headers.map((header, index) => header.padEnd(widths[index] ?? 0)).join('  ')}`,
  );
  lines.push(
    `  ${widths.map((width) => '-'.repeat(width)).join('  ')}`,
  );
  for (const row of rows) {
    lines.push(
      `  ${row.map((value, index) => value.padEnd(widths[index] ?? 0)).join('  ')}`,
    );
  }
  return lines.join('\n');
}
