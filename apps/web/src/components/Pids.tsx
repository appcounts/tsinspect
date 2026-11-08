import type { ProbePid } from '@tsinspect/core';
import { useT } from '../i18n';
import { formatBytes } from '../format';
import { DataTable } from './shared';

export function Pids({
  pids,
  total,
  onHex,
}: {
  pids: ProbePid[];
  total: number;
  onHex: (offset: number) => void;
}) {
  const t = useT();
  return (
    <DataTable
      storageKey="pids"
      rows={pids}
      rowKey={(row) => row.pid}
      toolbar={
        <span className="muted small">{t('pids.showing', { shown: pids.length, total })}</span>
      }
      columns={[
        {
          key: 'pid',
          label: t('pids.pid'),
          render: (row) => <span className="mono">{row.pidHex}</span>,
          sortValue: (row) => row.pid,
        },
        {
          key: 'kind',
          label: t('pids.kind'),
          render: (row) => row.kind ?? '-',
          sortValue: (row) => row.kind ?? '',
        },
        {
          key: 'packets',
          label: t('pids.packets'),
          align: 'num',
          render: (row) => row.packets.toLocaleString(),
          sortValue: (row) => row.packets,
        },
        {
          key: 'payload',
          label: t('pids.payload'),
          align: 'num',
          render: (row) => formatBytes(row.payloadBytes),
          sortValue: (row) => row.payloadBytes,
        },
        {
          key: 'pcr',
          label: t('pids.pcr'),
          align: 'num',
          render: (row) => row.pcrCount,
          sortValue: (row) => row.pcrCount,
        },
        {
          key: 'ccErrors',
          label: t('pids.ccErrors'),
          align: 'num',
          render: (row) => <span className={row.ccErrors ? 'bad' : undefined}>{row.ccErrors}</span>,
          sortValue: (row) => row.ccErrors,
        },
        {
          key: 'tei',
          label: t('pids.tei'),
          align: 'num',
          render: (row) => row.tei,
          sortValue: (row) => row.tei,
        },
        {
          key: 'scrambled',
          label: t('pids.scrambled'),
          align: 'num',
          render: (row) => row.scrambled,
          sortValue: (row) => row.scrambled,
        },
        {
          key: 'hex',
          label: '',
          align: 'num',
          render: (row) => (
            <button
              className="ghost tiny"
              disabled={row.firstPacketOffset === undefined}
              onClick={() => onHex(row.firstPacketOffset ?? 0)}
            >
              {t('pids.viewHex')}
            </button>
          ),
        },
      ]}
    />
  );
}
