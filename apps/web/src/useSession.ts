import { useEffect, useRef, useState } from 'react';
import type { ProbeResult, Scte35Timeline, SubtitleReport } from '@tsinspect/core';
import {
  initialLocale,
  translate,
  type Locale,
  type StatusValue,
  type UiKey,
  type Vars,
} from './i18n';
import { formatBytes } from './format';
import { api } from './api';
import type {
  AnalysisMessage,
  AnalysisProgress,
  HexResponse,
  SessionResponse,
  Tab,
} from './types';

export interface SessionController {
  locale: Locale;
  toggleLocale: () => void;
  t: (key: UiKey, vars?: Vars) => string;
  source: string;
  setSource: (value: string) => void;
  bytes: number;
  setBytes: (value: number) => void;
  statusText: string;
  error: boolean;
  busy: boolean;
  picking: boolean;
  sessionId: string | undefined;
  result: ProbeResult | null;
  hex: HexResponse | null;
  scte35: Scte35Timeline | null;
  subtitles: SubtitleReport | null;
  subtitlesLoading: boolean;
  progress: AnalysisProgress | null;
  analyze: () => Promise<void>;
  cancel: () => void;
  pickSource: () => Promise<void>;
  closeSession: () => void;
}

export function useSession({
  tab,
  hexOffset,
  hexLength,
  initialSession,
}: {
  tab: Tab;
  hexOffset: number;
  hexLength: number;
  initialSession?: string;
}): SessionController {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const t = (key: UiKey, vars?: Vars) => translate(locale, key, vars);
  const [source, setSource] = useState('');
  const [bytes, setBytes] = useState(64 * 1024 * 1024);
  const [status, setStatus] = useState<StatusValue | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>(initialSession);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [hex, setHex] = useState<HexResponse | null>(null);
  const [scte35, setScte35] = useState<Scte35Timeline | null>(null);
  const [subtitles, setSubtitles] = useState<SubtitleReport | null>(null);
  const [subtitlesLoading, setSubtitlesLoading] = useState(false);
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem('tsinspect.locale', locale);
    } catch {
      // Ignore storage failures.
    }
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    document.title = t('app.documentTitle');
  }, [locale]);

  const setMessage = (message: StatusValue, isError = false) => {
    setStatus(message);
    setError(isError);
  };
  const statusText =
    typeof status === 'string'
      ? status
      : status
        ? t(status.key, status.vars)
        : t('status.idle');

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setMessage({ key: 'status.loadingSession' });
    api<SessionResponse>(`/api/sessions/${sessionId}`)
      .then((response) => {
        if (cancelled) return;
        setResult(response.result);
        const source = response.result.source;
        const name = source.name;
        const standard = response.result.standard.detected;
        if (source.full) {
          setMessage({ key: 'status.loaded', vars: { name, standard } });
        } else if (source.size !== undefined) {
          setMessage({
            key: 'status.loadedPartial',
            vars: {
              name,
              standard,
              sampled: formatBytes(source.sampledBytes),
              total: formatBytes(source.size),
            },
          });
        } else {
          setMessage({
            key: 'status.loadedPartialUnknown',
            vars: { name, standard, sampled: formatBytes(source.sampledBytes) },
          });
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setMessage(reason instanceof Error ? reason.message : String(reason), true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (tab !== 'hex' || !sessionId) return;
    let cancelled = false;
    api<HexResponse>(
      `/api/sessions/${sessionId}/hex?offset=${hexOffset}&length=${hexLength}`,
    )
      .then((response) => {
        if (!cancelled) setHex(response);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setMessage(reason instanceof Error ? reason.message : String(reason), true);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, sessionId, hexOffset, hexLength]);

  useEffect(() => {
    if (tab !== 'timeline' || !sessionId || !result?.capabilities.scte35) {
      setScte35(null);
      return;
    }
    let cancelled = false;
    api<Scte35Timeline>(`/api/sessions/${sessionId}/scte35`)
      .then((response) => {
        if (!cancelled) setScte35(response);
      })
      .catch(() => {
        if (!cancelled) setScte35(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, sessionId, result?.capabilities.scte35]);

  useEffect(() => {
    if (tab !== 'subtitles' || !sessionId) return;
    let cancelled = false;
    setSubtitlesLoading(true);
    api<SubtitleReport>(`/api/sessions/${sessionId}/subtitles`)
      .then((response) => {
        if (!cancelled) setSubtitles(response);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setSubtitles(null);
          const detail = reason instanceof Error ? reason.message : String(reason);
          setMessage(`${t('subtitles.loadFailed')} ${detail}`, true);
        }
      })
      .finally(() => {
        if (!cancelled) setSubtitlesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, sessionId]);

  async function pickSource(): Promise<void> {
    if (picking) return;
    setPicking(true);
    try {
      const response = await api<{ path: string | null }>('/api/system/pick-file', {
        method: 'POST',
      });
      if (response.path) setSource(response.path);
    } catch {
      setMessage({ key: 'source.pickFailed' }, true);
    } finally {
      setPicking(false);
    }
  }

  async function analyze() {
    if (!source.trim()) {
      setMessage({ key: 'status.enterSource' }, true);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(false);
    setProgress({ phase: 'loading', percent: 0 });
    setMessage({ key: 'status.analyzing' });
    try {
      const response = await fetch('/api/sessions?stream=1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: source.trim(), bytes }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${response.status} ${response.statusText}`);
      }
      if (!response.body) throw new Error('This browser cannot stream the analysis progress.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;
      while (!completed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line) continue;
          const message = JSON.parse(line) as AnalysisMessage;
          if (message.type === 'progress') {
            setProgress(message);
          } else if (message.type === 'result') {
            completed = true;
            setSessionId(message.id);
            setResult(null);
            setHex(null);
            setScte35(null);
            setSubtitles(null);
            setSubtitlesLoading(false);
            await reader.cancel().catch(() => undefined);
            break;
          } else if (message.type === 'error') {
            throw new Error(message.error);
          }
        }
      }
      if (!completed) throw new Error('The analysis ended without a result.');
    } catch (reason) {
      if (controller.signal.aborted) {
        setMessage({ key: 'status.cancelled' });
      } else {
        setMessage(reason instanceof Error ? reason.message : String(reason), true);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setProgress(null);
      setBusy(false);
    }
  }

  function closeSession(): void {
    const id = sessionId;
    setSessionId(undefined);
    setResult(null);
    setHex(null);
    setScte35(null);
    setSubtitles(null);
    setSubtitlesLoading(false);
    setStatus(null);
    setError(false);
    if (id) {
      // The server drops the sample and its derived caches; failure here only
      // means the idle timeout will reclaim it.
      void fetch(`/api/sessions/${id}`, { method: 'DELETE' }).catch(() => undefined);
    }
  }

  return {
    locale,
    toggleLocale: () => setLocale(locale === 'zh' ? 'en' : 'zh'),
    t,
    source,
    setSource,
    bytes,
    setBytes,
    statusText,
    error,
    busy,
    picking,
    sessionId,
    result,
    hex,
    scte35,
    subtitles,
    subtitlesLoading,
    progress,
    analyze,
    cancel: () => abortRef.current?.abort(),
    pickSource,
    closeSession,
  };
}
