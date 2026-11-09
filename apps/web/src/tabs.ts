import type { Tab } from './types';
import type { UiKey } from './i18n';

export const TABS: Array<{ id: Tab; label: UiKey }> = [
  { id: 'services', label: 'tab.services' },
  { id: 'pids', label: 'tab.pids' },
  { id: 'tables', label: 'tab.tables' },
  { id: 'data', label: 'tab.data' },
  { id: 'epg', label: 'tab.epg' },
  { id: 'subtitles', label: 'tab.subtitles' },
  { id: 'timeline', label: 'tab.timeline' },
  { id: 'validation', label: 'tab.validation' },
  { id: 'hex', label: 'tab.hex' },
];

export const PAGE_SUBTITLES: Record<Tab, UiKey> = {
  services: 'overview.subtitle',
  pids: 'page.pidsSub',
  tables: 'page.tablesSub',
  data: 'page.dataSub',
  epg: 'page.epgSub',
  subtitles: 'page.subtitlesSub',
  timeline: 'page.timelineSub',
  validation: 'page.validationSub',
  hex: 'page.hexSub',
};

export const SEARCHABLE = new Set<Tab>(['services', 'pids', 'tables', 'epg', 'subtitles', 'validation']);

export const TAB_SHORT_LABELS: Record<Tab, UiKey> = {
  services: 'rail.services',
  pids: 'rail.pids',
  tables: 'rail.tables',
  data: 'rail.data',
  epg: 'rail.epg',
  subtitles: 'rail.subtitles',
  timeline: 'rail.timeline',
  validation: 'rail.validation',
  hex: 'rail.hex',
};

export function hashState(): { session?: string; tab: Tab; q: string } {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const tab = params.get('tab') as Tab | null;
  return {
    ...(params.get('session') ? { session: params.get('session') as string } : {}),
    tab: TABS.some((entry) => entry.id === tab) ? (tab as Tab) : 'services',
    q: params.get('q') ?? '',
  };
}
