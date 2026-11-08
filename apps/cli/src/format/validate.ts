import type { Diagnostic, ProbeResult, Severity } from '@tsinspect/core';
import { formatBytes, hex16 } from '@tsinspect/core';

export interface ValidationOptions {
  /** Treat warnings as validation failures. */
  strict?: boolean;
}

export interface ValidationSummary {
  errors: number;
  warnings: number;
  infos: number;
  ok: boolean;
}

export function summarizeDiagnostics(
  diagnostics: Diagnostic[],
  options: ValidationOptions = {},
): ValidationSummary {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;
  const infos = diagnostics.filter((diagnostic) => diagnostic.severity === 'info').length;
  return {
    errors,
    warnings,
    infos,
    ok: errors === 0 && (!options.strict || warnings === 0),
  };
}

const LABEL_WIDTH = 13;
const SEVERITIES: Severity[] = ['error', 'warning', 'info'];

export function formatValidationText(
  result: ProbeResult,
  options: ValidationOptions = {},
): string {
  const summary = summarizeDiagnostics(result.diagnostics, options);
  const lines: string[] = [];
  lines.push(`tsinspect ${result.tool.version} - MPEG-TS validation`);
  lines.push('');
  lines.push(label('Source', result.source.name));
  lines.push(label('Standard', result.standard.detected));
  lines.push(
    label(
      'Input',
      `${formatBytes(result.source.sampledBytes)} sampled${
        result.source.size !== undefined ? ` of ${formatBytes(result.source.size)}` : ''
      }`,
    ),
  );
  lines.push(
    label(
      'Result',
      `${validationStatus(summary, options)} (${summary.errors} error(s), ${summary.warnings} warning(s), ${summary.infos} info)`,
    ),
  );

  for (const severity of SEVERITIES) {
    const diagnostics = result.diagnostics.filter(
      (diagnostic) => diagnostic.severity === severity,
    );
    lines.push('');
    lines.push(sectionTitle(`${severity.toUpperCase()} (${diagnostics.length})`));
    if (diagnostics.length === 0) {
      lines.push('  None.');
      continue;
    }
    for (const diagnostic of diagnostics) {
      const location: string[] = [];
      if (diagnostic.pid !== undefined) location.push(`PID ${hex16(diagnostic.pid)}`);
      if (diagnostic.packet !== undefined) location.push(`packet ${diagnostic.packet}`);
      if (diagnostic.tableId !== undefined) {
        location.push(`table 0x${diagnostic.tableId.toString(16).padStart(2, '0').toUpperCase()}`);
      }
      lines.push(
        `  ${diagnostic.code.padEnd(22)}${
          location.length > 0 ? `[${location.join(', ')}] ` : ''
        }${diagnostic.message}`,
      );
    }
  }

  return lines.join('\n');
}

export function formatValidationJson(
  result: ProbeResult,
  options: ValidationOptions = {},
): string {
  return JSON.stringify(
    {
      schemaVersion: result.schemaVersion,
      tool: result.tool,
      source: result.source,
      standard: result.standard,
      capabilities: result.capabilities,
      summary: {
        ...summarizeDiagnostics(result.diagnostics, options),
        status: validationStatus(summarizeDiagnostics(result.diagnostics, options), options),
      },
      diagnostics: result.diagnostics,
    },
    null,
    2,
  );
}

function label(name: string, value: string): string {
  return `${name.padEnd(LABEL_WIDTH)}${value}`;
}

function validationStatus(
  summary: ValidationSummary,
  options: ValidationOptions,
): 'PASS' | 'WARN' | 'FAIL' {
  if (summary.errors > 0) return 'FAIL';
  if (summary.warnings > 0) return options.strict ? 'FAIL' : 'WARN';
  return 'PASS';
}

function sectionTitle(title: string): string {
  return `${title}\n${'-'.repeat(title.length)}`;
}
