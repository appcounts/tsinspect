import type { PesPacket, ProbeResult, Scte35Timeline, SubtitleReport } from '@tsinspect/core';
import { SESSION_BUDGET_BYTES, SESSION_IDLE_TIMEOUT_MS, SESSION_SWEEP_MS } from './config.js';

export interface TimelineBucket {
  startSec?: number;
  packets: number;
  bytes: number;
  bitrateBps?: number;
}

export interface TimelinePid {
  pid: number;
  pidHex: string;
  kind?: string;
  packets: number;
  series: number[];
}

export interface TimelineSubtitleCue {
  start: number;
  end: number;
  category: string;
  format: string;
  pidHex: string;
  label?: string;
  text: string;
}

export interface TimelineData {
  durationSec?: number;
  bitrateBps?: number;
  bucketSec?: number;
  buckets: TimelineBucket[];
  pids: TimelinePid[];
  subtitles?: TimelineSubtitleCue[];
  subtitlesTruncated?: boolean;
}

export interface Session {
  id: string;
  result: ProbeResult;
  data: Uint8Array;
  createdAt: number;
  scte35?: Scte35Timeline;
  subtitles?: SubtitleReport;
  dvbPes?: Map<number, PesPacket[]>;
  timeline?: Map<string, TimelineData>;
}

interface SessionEntry {
  session: Session;
  lastAccess: number;
  /** Number of in-flight requests currently holding this session. */
  pins: number;
  /** Removed from the map and waiting for its last request to finish. */
  removed: boolean;
}

const EMPTY_DATA = new Uint8Array(0);
const entries = new Map<string, SessionEntry>();
/** Deleted entries that are still pinned by a request. */
const retiring = new Map<string, SessionEntry>();

/**
 * Drop every reference the server holds to the sampled stream and the caches
 * derived from it so the garbage collector can reclaim them immediately.
 */
function dispose(entry: SessionEntry): void {
  const session = entry.session;
  session.scte35 = undefined;
  session.subtitles = undefined;
  session.dvbPes?.clear();
  session.dvbPes = undefined;
  session.timeline?.clear();
  session.timeline = undefined;
  session.data = EMPTY_DATA;
}

function retire(id: string, entry: SessionEntry): void {
  entries.delete(id);
  entry.removed = true;
  if (entry.pins > 0) {
    // A request is still reading the session; release it when that ends.
    retiring.set(id, entry);
    return;
  }
  dispose(entry);
}

function totalBytes(): number {
  let total = 0;
  for (const entry of entries.values()) total += entry.session.data.byteLength;
  return total;
}

/**
 * Evict least-recently-used idle sessions until the byte budget holds.
 * The most recently used session always survives: a single sample can be
 * larger than the whole budget, and dropping it would break every on-demand
 * request (subtitle frames, hex dumps) while the page still shows its report.
 */
function evictToBudget(protectId?: string): void {
  let total = totalBytes();
  if (total <= SESSION_BUDGET_BYTES) return;
  let keep = protectId;
  if (keep === undefined) {
    let newestId: string | undefined;
    let newestAccess = -Infinity;
    for (const [id, entry] of entries) {
      if (entry.lastAccess > newestAccess) {
        newestAccess = entry.lastAccess;
        newestId = id;
      }
    }
    keep = newestId;
  }
  const candidates = [...entries.entries()]
    .filter(([id, entry]) => id !== keep && entry.pins === 0)
    .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  for (const [id, entry] of candidates) {
    if (total <= SESSION_BUDGET_BYTES) break;
    total -= entry.session.data.byteLength;
    retire(id, entry);
  }
}

function evictIdle(now: number): void {
  for (const [id, entry] of entries) {
    if (entry.pins > 0) continue;
    if (now - entry.lastAccess < SESSION_IDLE_TIMEOUT_MS) continue;
    retire(id, entry);
  }
}

export function addSession(session: Session): void {
  entries.set(session.id, {
    session,
    lastAccess: Date.now(),
    pins: 0,
    removed: false,
  });
  // Keep at least the session that was just created.
  evictToBudget(session.id);
}

export function getSession(id: string): Session | undefined {
  const entry = entries.get(id);
  if (!entry) return undefined;
  entry.lastAccess = Date.now();
  return entry.session;
}

/** Pin a session for the duration of one request so it cannot be evicted. */
export function acquireSession(id: string): Session | undefined {
  const entry = entries.get(id);
  if (!entry) return undefined;
  entry.pins += 1;
  entry.lastAccess = Date.now();
  return entry.session;
}

export function releaseSession(id: string): void {
  const entry = entries.get(id) ?? retiring.get(id);
  if (!entry) return;
  if (entry.pins > 0) entry.pins -= 1;
  if (entry.removed && entry.pins === 0) {
    retiring.delete(id);
    dispose(entry);
  }
}

export function deleteSession(id: string): boolean {
  const entry = entries.get(id);
  if (!entry) return false;
  retire(id, entry);
  return true;
}

export function listSessions(): Session[] {
  return [...entries.values()].map((entry) => entry.session);
}

export function sweepSessions(): void {
  evictIdle(Date.now());
  evictToBudget();
}

const timer = setInterval(sweepSessions, SESSION_SWEEP_MS);
timer.unref();
