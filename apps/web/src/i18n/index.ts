import { createContext, useContext } from 'react';
import { zh } from './zh';
import { en } from './en';

export { zh } from './zh';
export { en } from './en';

export type Locale = 'zh' | 'en';
export type Vars = Record<string, string | number>;

export const UI = { zh, en } as const;

export type UiKey = keyof typeof UI.zh;
export type StatusValue = string | { key: UiKey; vars?: Vars };

export const LocaleContext = createContext<Locale>('zh');

export function translate(locale: Locale, key: UiKey, vars?: Vars): string {
  let text = (UI[locale] as Record<UiKey, string>)[key];
  for (const [name, value] of Object.entries(vars ?? {})) {
    text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

export function useT(): (key: UiKey, vars?: Vars) => string {
  const locale = useContext(LocaleContext);
  return (key, vars) => translate(locale, key, vars);
}

export function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem('tsinspect.locale');
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
  return 'zh';
}
