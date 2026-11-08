import type { ProbeResult } from '@tsinspect/core';

export type Tab =
  | 'services'
  | 'pids'
  | 'tables'
  | 'data'
  | 'epg'
  | 'subtitles'
  | 'timeline'
  | 'validation'
  | 'hex';

export interface SessionResponse {
  id: string;
  result: ProbeResult;
}

export interface AnalysisProgress {
  phase: 'loading' | 'probing';
  receivedBytes?: number;
  totalBytes?: number;
  percent?: number;
  pass?: number;
  packets?: number;
  totalPackets?: number;
  cancelable?: boolean;
}

export type AnalysisMessage =
  | ({ type: 'progress' } & AnalysisProgress)
  | { type: 'result'; id: string; summary: Record<string, unknown> }
  | { type: 'error'; error: string };

export interface HexResponse {
  offset: number;
  length: number;
  hex: string;
  ascii: string;
  size: number;
}
