import { useMemo, useState } from 'react';
import type { ProbePid, ProbeResult } from '@tsinspect/core';
import { useT } from '../i18n';
import { formatBytes, hex16 } from '../format';
import type { HexResponse } from '../types';

export function Hex({
  hex,
  offset,
  length,
  packet,
  pids,
  onOffset,
  onLength,
}: {
  hex: HexResponse | null;
  offset: number;
  length: number;
  packet: ProbeResult['packet'];
  pids: ProbePid[];
  onOffset: (value: number) => void;
  onLength: (value: number) => void;
}) {
  const t = useT();
  const [jumpPid, setJumpPid] = useState('');
  const lines = useMemo(() => {
    if (!hex) return [];
    const raw = hex.hex ? hex.hex.split(' ') : [];
    if (raw.length === 0) return [];
    const size = packet.size > 0 ? packet.size : 188;
    const first = packet.firstPacketOffset;
    const byteMap = new Map<number, number>();
    raw.forEach((value, index) => {
      byteMap.set(hex.offset + index, Number.parseInt(value, 16));
    });
    const pidByPacket = new Map<number, number>();
    const firstIndex = Math.max(0, Math.floor((hex.offset - first) / size));
    const lastIndex = Math.max(
      firstIndex,
      Math.floor((hex.offset + raw.length - 1 - first) / size),
    );
    for (let index = firstIndex; index <= lastIndex; index += 1) {
      const syncAbs = first + index * size + packet.syncOffset;
      const b1 = byteMap.get(syncAbs + 1);
      const b2 = byteMap.get(syncAbs + 2);
      if (b1 !== undefined && b2 !== undefined) {
        pidByPacket.set(index, ((b1 & 0x1f) << 8) | b2);
      }
    }

    const result: Array<{
      address: string;
      bytes: Array<{
        abs: number;
        hex: string;
        ascii: string;
        index?: number;
        start: boolean;
        sync: boolean;
      }>;
      note: string;
    }> = [];
    for (let i = 0; i < raw.length; i += 16) {
      const chunk = raw.slice(i, i + 16);
      const bytes = chunk.map((value, j) => {
        const abs = hex.offset + i + j;
        const relative = abs - first;
        const index = relative >= 0 ? Math.floor(relative / size) : undefined;
        const start = index !== undefined && abs === first + index * size;
        const sync =
          index !== undefined && abs === first + index * size + packet.syncOffset;
        const code = Number.parseInt(value, 16);
        return {
          abs,
          hex: value,
          ascii: code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : '.',
          index,
          start,
          sync,
        };
      });
      const indices = [
        ...new Set(
          bytes
            .map((byte) => byte.index)
            .filter((value): value is number => value !== undefined),
        ),
      ];
      const linePids = [
        ...new Set(
          indices
            .map((index) => pidByPacket.get(index))
            .filter((value): value is number => value !== undefined),
        ),
      ];
      const packetLabel =
        indices.length === 0
          ? ''
          : `#${indices[0]}${
              indices.length > 1 ? `–${indices[indices.length - 1]}` : ''
            }`;
      const pidLabel =
        linePids.length > 0 ? ` · PID ${linePids.map((pid) => hex16(pid)).join('/')}` : '';
      result.push({
        address: (hex.offset + i).toString(16).padStart(8, '0'),
        bytes,
        note: `${packetLabel}${pidLabel}`,
      });
    }
    return result;
  }, [hex, packet]);

  return (
    <div>
      <div className="hex-controls">
        <label>
          {t('hex.offset')}{' '}
          <input
            type="number"
            min={0}
            value={offset}
            onChange={(event) => onOffset(Math.max(0, Number(event.target.value) || 0))}
          />
        </label>
        <label>
          {t('hex.length')}{' '}
          <input
            type="number"
            min={1}
            max={8192}
            value={length}
            onChange={(event) => onLength(Math.min(8192, Math.max(1, Number(event.target.value) || 256)))}
          />
        </label>
        <label>
          {t('hex.jumpPid')}{' '}
          <select
            value={jumpPid}
            onChange={(event) => {
              const value = event.target.value;
              setJumpPid(value);
              const pid = pids.find((entry) => String(entry.pid) === value);
              if (pid?.firstPacketOffset !== undefined) onOffset(pid.firstPacketOffset);
            }}
          >
            <option value="">{t('hex.selectPid')}</option>
            {pids
              .filter((entry) => entry.firstPacketOffset !== undefined)
              .map((entry) => (
                <option key={entry.pid} value={entry.pid}>
                  {entry.pidHex}
                  {entry.kind ? ` · ${entry.kind}` : ''}
                </option>
              ))}
          </select>
        </label>
        <span className="muted">
          {hex
            ? t('hex.summary', {
                offset: hex.offset,
                length: hex.length,
                size: formatBytes(hex.size),
              })
            : t('hex.loading')}
        </span>
      </div>
      <div className="hex-legend muted small">
        <span className="hex-sync-swatch" /> {t('hex.legendSync')}
        <span className="hex-packet-swatch" /> {t('hex.legendPacket')}
      </div>
      {lines.length === 0 ? (
        <p className="muted">{t('hex.empty')}</p>
      ) : (
        <div className="hex-dump">
          {lines.map((line) => (
            <div className="hex-line" key={line.address}>
              <span className="hex-address">{line.address}</span>
              <span className="hex-bytes">
                {line.bytes.map((byte) => (
                  <span
                    key={byte.abs}
                    className={`hex-byte ${
                      byte.index !== undefined && byte.index % 2 === 1 ? 'odd' : ''
                    } ${byte.start ? 'start' : ''} ${byte.sync ? 'sync' : ''}`}
                    title={`0x${byte.abs.toString(16).toUpperCase()}`}
                  >
                    {byte.hex}
                  </span>
                ))}
                {Array.from({ length: 16 - line.bytes.length }).map((_, index) => (
                  <span key={`pad-${index}`} className="hex-byte pad" />
                ))}
              </span>
              <span className="hex-ascii">
                {line.bytes.map((byte) => (
                  <span
                    key={byte.abs}
                    className={byte.sync ? 'sync' : undefined}
                  >
                    {byte.ascii}
                  </span>
                ))}
              </span>
              <span className="hex-note">{line.note}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
