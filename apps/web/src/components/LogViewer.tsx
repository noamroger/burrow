/**
 * Terminal-like viewer for cloudflared / Burrow log lines.
 *
 * Auto-scroll follows new lines while the user is at the bottom. Scrolling up
 * pauses it and shows a "Jump to latest" button; the toggle makes it explicit.
 */
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LOG_LEVELS, type LogLevel, type LogLine } from '@burrow/shared';
import type { StreamStatus } from '../hooks/useLogStream';
import { t } from '../i18n';
import { cn } from '../lib/cn';
import { formatLogTime } from '../lib/format';
import { Icon } from './Icon';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Input, Select } from './ui/Field';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };

export const LEVEL_CLASS: Record<LogLevel, string> = {
  debug: 'text-[#9b8b7d]',
  info: 'text-[#8cc7e8]',
  warn: 'text-[#f0b552]',
  error: 'text-[#f2817a]',
  fatal: 'bg-[#f2817a] px-1 text-[#1d1612]',
};

const STATUS_TONE = { live: 'success', connecting: 'info', reconnecting: 'warning' } as const;

/** Lines at or above `minLevel` whose message contains `query` (case-insensitive). */
export function filterLogLines(lines: LogLine[], minLevel: LogLevel, query: string): LogLine[] {
  const q = query.trim().toLowerCase();
  const min = LEVEL_RANK[minLevel];
  return lines.filter(
    (l) => LEVEL_RANK[l.level] >= min && (!q || l.message.toLowerCase().includes(q)),
  );
}

export interface LogViewerProps {
  lines: LogLine[];
  status?: StreamStatus;
  onClear?: () => void;
  /** Height of the scroll area (CSS value). */
  height?: string;
}

export function LogViewer({ lines, status, onClear, height = '28rem' }: LogViewerProps) {
  const uid = useId();
  const [minLevel, setMinLevel] = useState<LogLevel>('debug');
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => filterLogLines(lines, minLevel, query), [lines, minLevel, query]);

  // Stick to the bottom when following.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [visible, follow]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAtBottom(bottom);
    // Scrolling up pauses auto-scroll; scrolling back to the bottom resumes it.
    setFollow(bottom);
  }

  function jumpToBottom() {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFollow(true);
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <label htmlFor={`${uid}-level`} className="sr-only">
            {t('logs.level')}
          </label>
          <Select
            id={`${uid}-level`}
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value as LogLevel)}
            className="h-8 w-36 text-xs"
          >
            {LOG_LEVELS.filter((l) => l !== 'fatal').map((level) => (
              <option key={level} value={level}>
                {level === 'debug' ? t('logs.levelAll') : t('logs.levelAtLeast', { level })}
              </option>
            ))}
          </Select>
        </div>
        <div className="relative min-w-0 flex-1 basis-40">
          <label htmlFor={`${uid}-search`} className="sr-only">
            {t('logs.search')}
          </label>
          <Icon
            name="search"
            size={14}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-muted"
          />
          <Input
            id={`${uid}-search`}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('logs.search')}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-fg-muted select-none">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => (e.target.checked ? jumpToBottom() : setFollow(false))}
            className="size-3.5 accent-[var(--accent)]"
          />
          {t('logs.autoScroll')}
        </label>
        {status ? (
          <Badge tone={STATUS_TONE[status]} dot pulse={status === 'live'}>
            {t(`logs.status.${status}`)}
          </Badge>
        ) : null}
        {onClear ? (
          <Button variant="ghost" size="sm" onClick={onClear}>
            {t('logs.clear')}
          </Button>
        ) : null}
      </div>

      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          role="log"
          aria-live="off"
          aria-label={t('logs.title')}
          tabIndex={0}
          style={{ height }}
          className="overflow-auto bg-log-bg px-3 py-2 font-mono text-[12px] leading-[1.6] text-log-fg"
        >
          {visible.length === 0 ? (
            <p className="py-8 text-center text-[#9b8b7d]">
              {lines.length === 0 ? t('logs.empty') : t('logs.noMatch')}
            </p>
          ) : (
            visible.map((line) => (
              <div
                key={line.seq}
                data-level={line.level}
                className="flex gap-3 whitespace-pre-wrap break-all hover:bg-white/5"
              >
                <time dateTime={line.time} className="shrink-0 text-[#7d6e62] select-none">
                  {formatLogTime(line.time)}
                </time>
                <span
                  className={cn('w-11 shrink-0 font-semibold uppercase', LEVEL_CLASS[line.level])}
                >
                  {line.level}
                </span>
                {line.source === 'burrow' ? (
                  <span className="shrink-0 text-[#d9895f]">[burrow]</span>
                ) : null}
                <span className="min-w-0">{line.message}</span>
              </div>
            ))
          )}
        </div>
        {!follow && !atBottom ? (
          <Button
            size="sm"
            icon="arrowDown"
            onClick={jumpToBottom}
            className="absolute right-4 bottom-4 shadow-lg"
          >
            {t('logs.jumpToLatest')}
          </Button>
        ) : null}
      </div>
      <div className="flex justify-between border-t border-border px-3 py-1.5 text-[11px] text-fg-muted">
        <span>{t('logs.count', { shown: visible.length, total: lines.length })}</span>
        <span className="hidden sm:inline">{t('logs.bufferHint')}</span>
      </div>
    </div>
  );
}
