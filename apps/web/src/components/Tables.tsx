import { Fragment, useMemo, useState } from 'react';
import type { DescriptorInfo, ProbeService, ProbeTable } from '@tsinspect/core';
import { useT } from '../i18n';
import { formatIsoClock, hex16, humanizeField } from '../format';
import { DataTable } from './shared';

interface DescriptorMatch {
  programNumber: number;
  serviceName?: string;
  streamPid?: number;
  streamPidHex?: string;
  streamDescription?: string;
  descriptor: DescriptorInfo;
  matched: string;
}

function descriptorText(descriptor: DescriptorInfo): string {
  return [
    descriptor.name,
    descriptor.tagHex,
    descriptor.raw,
    ...Object.entries(descriptor.fields ?? {}).map(([key, value]) => `${key}=${String(value)}`),
  ]
    .join(' ')
    .toLowerCase();
}

function collectDescriptorMatches(
  services: ProbeService[],
  query: string,
): DescriptorMatch[] {
  if (!query) return [];
  const matches: DescriptorMatch[] = [];
  const push = (
    service: ProbeService,
    descriptor: DescriptorInfo,
    stream?: { pid: number; pidHex: string; description: string },
  ): void => {
    if (!descriptorText(descriptor).includes(query)) return;
    const fieldMatch = Object.entries(descriptor.fields ?? {}).find(([, value]) =>
      String(value).toLowerCase().includes(query),
    );
    matches.push({
      programNumber: service.programNumber,
      ...(service.name !== undefined ? { serviceName: service.name } : {}),
      ...(stream !== undefined
        ? {
            streamPid: stream.pid,
            streamPidHex: stream.pidHex,
            streamDescription: stream.description,
          }
        : {}),
      descriptor,
      matched: fieldMatch
        ? `${fieldMatch[0]}=${String(fieldMatch[1])}`
        : descriptor.name || descriptor.tagHex,
    });
  };
  for (const service of services) {
    for (const descriptor of service.descriptors) push(service, descriptor);
    for (const stream of service.streams) {
      for (const descriptor of stream.descriptors) push(service, descriptor, stream);
    }
  }
  return matches.slice(0, 200);
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function FieldValueNode({
  name,
  value,
  depth,
}: {
  name: string;
  value: unknown;
  depth: number;
}) {
  const isArray = Array.isArray(value);
  const isObject = !isArray && typeof value === 'object' && value !== null;
  const indent = { paddingLeft: `${depth * 14}px` };

  if (isArray) {
    if (value.every((item) => item === null || typeof item !== 'object')) {
      return (
        <div className="field-tree-row" style={indent}>
          <span className="field-tree-key">{humanizeField(name)}</span>
          <span className="field-tree-value mono">{value.map(scalarText).join(', ')}</span>
        </div>
      );
    }
    return (
      <div className="field-tree-group">
        <div className="field-tree-row" style={indent}>
          <span className="field-tree-key">{humanizeField(name)}</span>
          <span className="field-tree-count muted small">[{value.length}]</span>
        </div>
        {value.map((item, index) => (
          <FieldValueNode key={index} name={`#${index + 1}`} value={item} depth={depth + 1} />
        ))}
      </div>
    );
  }

  if (isObject) {
    return (
      <div className="field-tree-group">
        <div className="field-tree-row" style={indent}>
          <span className="field-tree-key">{humanizeField(name)}</span>
        </div>
        {Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => (
          <FieldValueNode key={childKey} name={childKey} value={childValue} depth={depth + 1} />
        ))}
      </div>
    );
  }

  return (
    <div className="field-tree-row" style={indent}>
      <span className="field-tree-key">{humanizeField(name)}</span>
      <span className="field-tree-value mono">{scalarText(value)}</span>
    </div>
  );
}

function FieldTree({ fields }: { fields: Record<string, unknown> }) {
  const entries = Object.entries(fields);
  if (entries.length === 0) return null;
  return (
    <div className="field-tree">
      {entries.map(([key, value]) => (
        <FieldValueNode key={key} name={key} value={value} depth={0} />
      ))}
    </div>
  );
}

type FieldItem = Record<string, unknown>;

function textValue(value: unknown): string | undefined {
  if (value === undefined || value === null || typeof value === 'object') return undefined;
  return String(value);
}

function itemLabel(
  fieldKey: string,
  item: FieldItem,
  index: number,
): { label: string; meta?: string } {
  switch (fieldKey) {
    case 'programs':
      return {
        label: `Program ${textValue(item.programNumber) ?? index + 1}`,
        meta: textValue(item.pmtPid),
      };
    case 'services': {
      const name = textValue(item.name);
      return {
        label: `${textValue(item.serviceId) ?? index + 1}${name !== undefined ? ` · ${name}` : ''}`,
        meta: textValue(item.provider) ?? textValue(item.type),
      };
    }
    case 'streams':
      return { label: textValue(item.pid) ?? `#${index + 1}`, meta: textValue(item.type) };
    case 'events': {
      const detail = [textValue(item.name), textValue(item.start)].filter(Boolean).join(' · ');
      return {
        label: `Event ${textValue(item.eventId) ?? index + 1}`,
        ...(detail.length > 0 ? { meta: detail } : {}),
      };
    }
    case 'transports':
      return {
        label: `TSID ${textValue(item.transportStreamId) ?? '?'}`,
        meta: `ONID ${textValue(item.originalNetworkId) ?? '?'}`,
      };
    case 'descriptors':
      return { label: textValue(item.name) ?? `#${index + 1}`, meta: textValue(item.tag) };
    case 'applications':
      return {
        label: `App ${textValue(item.applicationId) ?? index + 1}`,
        meta: textValue(item.organizationId),
      };
    case 'channels':
      return {
        label: `Channel ${textValue(item.channel) ?? index + 1}`,
        meta: textValue(item.name),
      };
    case 'tableTypes': {
      const detail = [textValue(item.name), textValue(item.pid)].filter(Boolean).join(' · ');
      return {
        label: textValue(item.type) ?? `#${index + 1}`,
        ...(detail.length > 0 ? { meta: detail } : {}),
      };
    }
    case 'devices':
      return { label: `Device ${textValue(item.deviceId) ?? index + 1}` };
    default:
      return { label: `#${index + 1}` };
  }
}

interface TreeNode {
  id: string;
  label: string;
  meta?: string;
  badge?: string;
  table?: ProbeTable;
  fields?: Record<string, unknown>;
  children: TreeNode[];
}

function tableKey(table: ProbeTable): string {
  return `${table.pid}:${table.tableId}:${table.tableIdExtension}:${table.version}:${table.sectionNumber}`;
}

function categoryFor(table: ProbeTable): { key: string; label: string } {
  if (table.tableId >= 0x4e && table.tableId <= 0x6f) return { key: 'eit', label: 'EIT' };
  return { key: `id-${table.tableId}`, label: table.name };
}

function tableLabel(table: ProbeTable, serviceName?: string): { label: string; meta: string } {
  const ext = table.tableIdExtension;
  const pid = table.pidHex;
  switch (table.tableId) {
    case 0x00:
      return { label: `PAT · TSID ${ext !== undefined ? hex16(ext) : '-'}`, meta: pid };
    case 0x02:
      return {
        label: `Program ${ext ?? '-'}${serviceName !== undefined ? ` · ${serviceName}` : ''}`,
        meta: `${pid} · v${table.version ?? '-'}`,
      };
    case 0x40:
    case 0x41:
      return { label: `${table.name} · network ${ext !== undefined ? hex16(ext) : '-'}`, meta: pid };
    case 0x42:
    case 0x46:
      return { label: `${table.name} · TSID ${ext !== undefined ? hex16(ext) : '-'}`, meta: pid };
    default:
      if (table.tableId >= 0x4e && table.tableId <= 0x6f) {
        return { label: `${table.name} · service ${ext ?? '-'}`, meta: pid };
      }
      return {
        label: `${table.name}${ext !== undefined ? ` · ${hex16(ext)}` : ''}`,
        meta: pid,
      };
  }
}

function tableChildren(table: ProbeTable): TreeNode[] {
  const children: TreeNode[] = [];
  const key = tableKey(table);
  for (const [fieldKey, value] of Object.entries(table.fields ?? {})) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const items = value.filter(
      (item) =>
        item !== null && typeof item === 'object' && !Array.isArray(item),
    ) as FieldItem[];
    if (items.length === 0) continue;
    items.forEach((item, index) => {
      const { label, meta } = itemLabel(fieldKey, item, index);
      children.push({
        id: `${key}::${fieldKey}[${index}]`,
        label,
        ...(meta !== undefined ? { meta } : {}),
        fields: item,
        children: [],
      });
    });
  }
  return children;
}

function tableVolume(table: ProbeTable): number {
  let volume = 1;
  for (const value of Object.values(table.fields ?? {})) {
    if (Array.isArray(value)) volume += value.length;
    else if (value !== null && typeof value === 'object') volume += Object.keys(value).length;
    else volume += 1;
  }
  return volume;
}

function buildTree(
  tables: ProbeTable[],
  services: ProbeService[],
  rootLabel: string,
): TreeNode {
  const groups = new Map<
    string,
    { label: string; sortKey: number; volume: number; children: TreeNode[] }
  >();
  const serviceNames = new Map<number, string>();
  for (const service of services) {
    if (service.name !== undefined) serviceNames.set(service.programNumber, service.name);
  }
  for (const table of tables) {
    const category = categoryFor(table);
    let group = groups.get(category.key);
    if (!group) {
      group = { label: category.label, sortKey: table.tableId, volume: 0, children: [] };
      groups.set(category.key, group);
    }
    group.volume += tableVolume(table);
    const { label, meta } = tableLabel(
      table,
      table.tableIdExtension !== undefined
        ? serviceNames.get(table.tableIdExtension)
        : undefined,
    );
    group.children.push({
      id: tableKey(table),
      label,
      meta,
      ...(table.crcValid === false ? { badge: 'CRC BAD' } : {}),
      table,
      fields: table.fields,
      children: tableChildren(table),
    });
  }
  return {
    id: 'root',
    label: rootLabel,
    children: [...groups.entries()]
      .sort(
        ([, a], [, b]) => b.volume - a.volume || a.sortKey - b.sortKey,
      )
      .map(([key, group]) => ({
        id: `group:${key}`,
        label: group.label,
        badge: String(group.children.length),
        children: group.children,
      })),
  };
}

function gridText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value !== null && typeof value === 'object') return '{…}';
  return scalarText(value);
}

function ObjectGrid({ rows }: { rows: FieldItem[] }) {
  if (rows.length === 0) return null;
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{humanizeField(column)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column} className="mono small">
                  {gridText(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NodeDetail({ node }: { node: TreeNode | undefined }) {
  const t = useT();
  if (node === undefined) {
    return <p className="muted small">{t('tables.treeSelect')}</p>;
  }
  if (node.table === undefined) {
    return (
      <div>
        <header className="psi-detail-head">
          <h2>{node.label}</h2>
          {node.meta !== undefined ? <span className="muted small mono">{node.meta}</span> : null}
        </header>
        {node.fields !== undefined ? (
          <FieldTree fields={node.fields} />
        ) : (
          <p className="muted small">{t('tables.treeSelect')}</p>
        )}
      </div>
    );
  }

  const table = node.table;
  const entries = Object.entries(table.fields ?? {});
  const scalars = entries.filter(([, value]) => value === null || typeof value !== 'object');
  const objects = entries.filter(
    ([, value]) => value !== null && typeof value === 'object' && !Array.isArray(value),
  );
  const lists = entries.filter(
    ([, value]) =>
      Array.isArray(value) && value.some((item) => item !== null && typeof item === 'object'),
  );

  return (
    <div>
      <header className="psi-detail-head">
        <h2>{node.label}</h2>
        {node.meta !== undefined ? <span className="muted small mono">{node.meta}</span> : null}
      </header>
      <dl className="psi-meta-grid">
        <div>
          <dt>{t('tables.pid')}</dt>
          <dd className="mono">{table.pidHex}</dd>
        </div>
        <div>
          <dt>{t('tables.id')}</dt>
          <dd className="mono">{table.tableIdHex}</dd>
        </div>
        <div>
          <dt>{t('tables.extension')}</dt>
          <dd className="mono">
            {table.tableIdExtension !== undefined ? hex16(table.tableIdExtension) : '-'}
          </dd>
        </div>
        <div>
          <dt>{t('tables.version')}</dt>
          <dd>{table.version ?? '-'}</dd>
        </div>
        <div>
          <dt>{t('tables.section')}</dt>
          <dd>
            {table.sectionNumber !== undefined
              ? `${table.sectionNumber}/${table.lastSectionNumber ?? '-'}`
              : '-'}
          </dd>
        </div>
        <div>
          <dt>{t('tables.crc')}</dt>
          <dd>
            {table.crcValid === undefined ? (
              '-'
            ) : table.crcValid ? (
              <span className="ok">ok</span>
            ) : (
              <span className="bad">BAD</span>
            )}
          </dd>
        </div>
        <div>
          <dt>{t('tables.count')}</dt>
          <dd>{table.occurrences}</dd>
        </div>
        <div>
          <dt>{t('tables.repeat')}</dt>
          <dd>
            {table.repeatIntervalSec !== undefined
              ? `${table.repeatIntervalSec.toFixed(2)} s`
              : '-'}
          </dd>
        </div>
      </dl>
      {lists.map(([key, value]) => (
        <section className="psi-grid-section" key={key}>
          <h3>
            {humanizeField(key)}{' '}
            <span className="muted small">[{Array.isArray(value) ? value.length : 0}]</span>
          </h3>
          <ObjectGrid rows={value as FieldItem[]} />
        </section>
      ))}
      {scalars.length + objects.length > 0 ? (
        <section className="psi-grid-section">
          <h3>{t('tables.fields')}</h3>
          <FieldTree fields={Object.fromEntries([...scalars, ...objects])} />
        </section>
      ) : null}
    </div>
  );
}

export function Tables({
  tables,
  total,
  services = [],
  query = '',
}: {
  tables: ProbeTable[];
  total: number;
  services?: ProbeService[];
  query?: string;
}) {
  const t = useT();
  const [view, setView] = useState<'tree' | 'table'>('tree');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['root']));
  const q = query.trim().toLowerCase();
  const visibleTables = useMemo(
    () => tables.filter((table) => !table.name.startsWith('Unknown')),
    [tables],
  );
  const descriptorMatches = useMemo(
    () => collectDescriptorMatches(services, q),
    [services, q],
  );
  const tree = useMemo(
    () => buildTree(visibleTables, services, t('tables.treeRoot')),
    [visibleTables, services, t],
  );
  const nodeIndex = useMemo(() => {
    const index = new Map<string, TreeNode>();
    const walk = (node: TreeNode): void => {
      index.set(node.id, node);
      node.children.forEach(walk);
    };
    walk(tree);
    return index;
  }, [tree]);
  const firstTableId = useMemo(() => {
    const walk = (node: TreeNode): string | undefined => {
      if (node.table !== undefined) return node.id;
      for (const child of node.children) {
        const found = walk(child);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    const pat = visibleTables.find((table) => table.tableId === 0x00);
    if (pat !== undefined) return tableKey(pat);
    return walk(tree) ?? 'root';
  }, [tree, visibleTables]);
  const activeNode = nodeIndex.get(selectedId ?? '') ?? nodeIndex.get(firstTableId);
  const expandableIds = useMemo(
    () =>
      [...nodeIndex.values()]
        .filter((node) => node.children.length > 0)
        .map((node) => node.id),
    [nodeIndex],
  );
  const allExpanded =
    expandableIds.length > 0 && expandableIds.every((id) => expanded.has(id));
  const toggleAll = (): void => {
    setExpanded(allExpanded ? new Set(['root']) : new Set(expandableIds));
  };
  const toggleNode = (id: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const renderTree = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => {
      const open = node.children.length > 0 && expanded.has(node.id);
      return (
        <Fragment key={node.id}>
          <div
            className={`psi-tree-row${activeNode?.id === node.id ? ' selected' : ''}`}
            style={{ paddingLeft: `${depth * 16 + 4}px` }}
            onClick={() => setSelectedId(node.id)}
          >
            <button
              type="button"
              className="psi-tree-toggle"
              disabled={node.children.length === 0}
              onClick={(event) => {
                event.stopPropagation();
                toggleNode(node.id);
              }}
            >
              {node.children.length === 0 ? '·' : open ? '▾' : '▸'}
            </button>
            <span className="psi-tree-label">{node.label}</span>
            {node.badge !== undefined ? (
              <span className="psi-tree-badge muted small">{node.badge}</span>
            ) : null}
            {node.meta !== undefined ? (
              <span className="psi-tree-meta muted small mono">{node.meta}</span>
            ) : null}
          </div>
          {open ? renderTree(node.children, depth + 1) : null}
        </Fragment>
      );
    });

  return (
    <>
      {q ? (
        <div className="descriptor-search panel-inset">
          <div className="panel-head compact">
            <div>
              <h2>{t('tables.descriptorMatches', { count: descriptorMatches.length })}</h2>
              <p>{t('tables.descriptorSearchHint')}</p>
            </div>
          </div>
          {descriptorMatches.length === 0 ? (
            <p className="muted small">{t('tables.noDescriptorMatches')}</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('tables.service')}</th>
                    <th>{t('tables.stream')}</th>
                    <th>{t('tables.descriptor')}</th>
                    <th>{t('tables.match')}</th>
                  </tr>
                </thead>
                <tbody>
                  {descriptorMatches.map((match, index) => (
                    <tr key={`${match.programNumber}:${match.streamPid ?? 'service'}:${match.descriptor.tag}:${index}`}>
                      <td>
                        {match.serviceName ?? match.programNumber}
                        <span className="muted small"> #{match.programNumber}</span>
                      </td>
                      <td className="mono">
                        {match.streamPidHex ?? '-'}
                        <span className="muted small">
                          {match.streamDescription ? ` · ${match.streamDescription}` : ''}
                        </span>
                      </td>
                      <td>
                        {match.descriptor.name}
                        <span className="muted small mono"> ({match.descriptor.tagHex})</span>
                      </td>
                      <td className="mono small">{match.matched}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
      <div className="tables-toolbar">
        <span className="muted small">
          {t('tables.showing', { shown: visibleTables.length, total })}
        </span>
        <div className="segmented">
          <button
            type="button"
            className={view === 'tree' ? 'active' : ''}
            onClick={() => setView('tree')}
          >
            {t('tables.viewTree')}
          </button>
          <button
            type="button"
            className={view === 'table' ? 'active' : ''}
            onClick={() => setView('table')}
          >
            {t('tables.viewTable')}
          </button>
        </div>
      </div>
      {view === 'tree' ? (
        <div className="psi-tree-layout">
          <aside className="psi-tree-pane">
            <div className="psi-tree-toolbar">
              <div className="psi-tree-hint muted small">{t('tables.treeHint')}</div>
              <button
                type="button"
                className="ghost tiny psi-tree-expand"
                disabled={expandableIds.length === 0}
                onClick={toggleAll}
              >
                {allExpanded ? t('tables.collapseAll') : t('tables.expandAll')}
              </button>
            </div>
            <div className="psi-tree">{renderTree([tree], 0)}</div>
          </aside>
          <div className="psi-tree-detail-pane">
            <NodeDetail node={activeNode} />
          </div>
        </div>
      ) : (
      <DataTable
        storageKey="tables"
        rows={visibleTables}
        rowKey={(row) =>
          `${row.pid}:${row.tableId}:${row.tableIdExtension}:${row.version}:${row.sectionNumber}`
        }
        expand={{
          label: t('tables.expand'),
          render: (row) => (
            <div className="table-field-detail">
              <div className="field-tree-title">{t('tables.fields')}</div>
              <FieldTree fields={row.fields ?? {}} />
            </div>
          ),
        }}
        columns={[
          {
            key: 'pid',
            label: t('tables.pid'),
            render: (row) => <span className="mono">{row.pidHex}</span>,
            sortValue: (row) => row.pid,
          },
          {
            key: 'name',
            label: t('tables.table'),
            render: (row) => row.name,
            sortValue: (row) => row.name,
          },
          {
            key: 'tableId',
            label: t('tables.id'),
            render: (row) => <span className="mono">{row.tableIdHex}</span>,
            sortValue: (row) => row.tableId,
          },
          {
            key: 'extension',
            label: t('tables.extension'),
            render: (row) => (
              <span className="mono">
                {row.tableIdExtension !== undefined ? hex16(row.tableIdExtension) : '-'}
              </span>
            ),
            sortValue: (row) => row.tableIdExtension,
          },
          {
            key: 'version',
            label: t('tables.version'),
            align: 'num',
            render: (row) => row.version ?? '-',
            sortValue: (row) => row.version,
          },
          {
            key: 'section',
            label: t('tables.section'),
            align: 'num',
            render: (row) =>
              row.sectionNumber !== undefined
                ? `${row.sectionNumber}/${row.lastSectionNumber ?? '-'}`
                : '-',
            sortValue: (row) => row.sectionNumber,
          },
          {
            key: 'crc',
            label: t('tables.crc'),
            render: (row) =>
              row.crcValid === undefined ? (
                '-'
              ) : row.crcValid ? (
                <span className="ok">ok</span>
              ) : (
                <span className="bad">BAD</span>
              ),
            sortValue: (row) =>
              row.crcValid === undefined ? undefined : row.crcValid ? 1 : 0,
          },
          {
            key: 'count',
            label: t('tables.count'),
            align: 'num',
            render: (row) => row.occurrences,
            sortValue: (row) => row.occurrences,
          },
          {
            key: 'repeat',
            label: t('tables.repeat'),
            align: 'num',
            render: (row) =>
              row.repeatIntervalSec !== undefined ? row.repeatIntervalSec.toFixed(2) : '-',
            sortValue: (row) => row.repeatIntervalSec,
          },
          {
            key: 'versions',
            label: t('tables.versions'),
            render: (row) =>
              row.versions !== undefined && row.versions.length > 0 ? row.versions.join(', ') : '-',
          },
          {
            key: 'missing',
            label: t('tables.missing'),
            render: (row) =>
              row.missingSections !== undefined && row.missingSections.length > 0
                ? row.missingSections.join(', ')
                : '-',
          },
          {
            key: 'firstPacket',
            label: t('tables.firstPacket'),
            align: 'num',
            render: (row) => row.firstPacket,
            sortValue: (row) => row.firstPacket,
          },
          {
            key: 'details',
            label: t('tables.details'),
            render: (row) => {
              if (row.tableId === 0x70 || row.tableId === 0x73) {
                const source = String(row.fields?.source ?? row.name);
                const utc = row.fields?.utc !== undefined ? String(row.fields.utc) : '';
                const offset =
                  row.fields?.localTimeOffset !== undefined
                    ? String(row.fields.localTimeOffset)
                    : undefined;
                const nextOffset =
                  row.fields?.nextTimeOffset !== undefined
                    ? String(row.fields.nextTimeOffset)
                    : undefined;
                const change =
                  row.fields?.timeOfChange !== undefined
                    ? String(row.fields.timeOfChange)
                    : undefined;
                const hint =
                  row.tableId === 0x70
                    ? t('overview.tdtHint')
                    : offset
                      ? change
                        ? t('overview.totHint', {
                            change: formatIsoClock(change),
                            offset: nextOffset ?? offset,
                          })
                        : t('overview.totHintNoChange', { offset })
                      : t('overview.totHintNoOffset');
                return (
                  <span className="mono small table-details" title={hint}>
                    {source}
                    {utc ? ` · ${formatIsoClock(utc)}` : ''}
                    {offset ? ` · ${offset}` : ''}
                    {nextOffset ? ` → ${nextOffset}` : ''}
                    {change ? ` · ${formatIsoClock(change)}` : ''}
                  </span>
                );
              }
              if (!row.fields) return '-';
              const summary = Object.entries(row.fields)
                .filter(([key, value]) => key !== 'source' && typeof value !== 'object')
                .slice(0, 3)
                .map(([key, value]) => `${key}=${String(value)}`)
                .join(' · ');
              return summary ? (
                <span className="mono small table-details" title={summary}>
                  {summary}
                </span>
              ) : (
                '-'
              );
            },
          },
        ]}
      />
      )}
    </>
  );
}
