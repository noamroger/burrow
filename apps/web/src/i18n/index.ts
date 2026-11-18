/**
 * Tiny i18n helper.
 *
 * Every user-facing string goes through `t()`. V1 ships English only; adding a
 * language means adding a dictionary with the same keys (the `Messages` type
 * enforces it) and choosing it in `setLocale()`.
 *
 *   t('hosts.count', { count: 3 })  ->  "3 hosts"
 */
import { en, type MessageKey } from './en';

export type { MessageKey };
export type Messages = Record<MessageKey, string>;
export type Vars = Record<string, string | number>;

const dictionaries: Record<string, Messages> = { en };
let current: Messages = en;

/** Switch the active dictionary. Unknown locales fall back to English. */
export function setLocale(locale: string): void {
  current = dictionaries[locale] ?? en;
}

/** Translate `key`, replacing `{name}` placeholders with `vars.name`. */
export function t(key: MessageKey, vars?: Vars): string {
  const template = current[key] ?? en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** Pick the singular or plural key based on `count` (English rules). */
export function tPlural(one: MessageKey, other: MessageKey, count: number, vars?: Vars): string {
  return t(count === 1 ? one : other, { count, ...vars });
}
