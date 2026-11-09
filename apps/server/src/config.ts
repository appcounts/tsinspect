/**
 * Server-side limits. Every threshold is env-overridable; the defaults are
 * deliberately conservative so an accidental long run cannot exhaust memory.
 */

const MIB = 1024 * 1024;

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Sample size used when the client does not ask for a specific budget. */
export const DEFAULT_SAMPLE_BYTES = positiveInt('TSINSPECT_DEFAULT_SAMPLE_BYTES', 64 * MIB);

/** Hard ceiling applied to explicit byte budgets; 0 means "no limit". */
export const SAMPLE_LIMIT_BYTES = positiveInt('TSINSPECT_MAX_SAMPLE_BYTES', 256 * MIB);

/** Sessions untouched for this long are dropped. */
export const SESSION_IDLE_TIMEOUT_MS = positiveInt('TSINSPECT_SESSION_TTL_MS', 15 * 60 * 1000);

/** Raw sample bytes kept across all live sessions. */
export const SESSION_BUDGET_BYTES = positiveInt('TSINSPECT_SESSION_BUDGET_BYTES', 512 * MIB);

/** How often the idle/budget sweeper runs. */
export const SESSION_SWEEP_MS = positiveInt('TSINSPECT_SESSION_SWEEP_MS', 60 * 1000);

/**
 * Translate the client `bytes` field into the read budget for one analysis.
 * A value of 0 means "read the whole source"; explicit budgets are still
 * capped by the sample limit.
 */
export function resolveSampleBytes(requested: unknown): number {
  const fallback = Math.min(DEFAULT_SAMPLE_BYTES, SAMPLE_LIMIT_BYTES);
  if (requested === undefined || requested === null) return fallback;
  const value = Number(requested);
  if (!Number.isFinite(value)) return fallback;
  if (value <= 0) return 0;
  return Math.min(Math.floor(value), SAMPLE_LIMIT_BYTES);
}
