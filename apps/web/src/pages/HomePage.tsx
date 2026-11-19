/**
 * The homepage (`/home`): the exposed services as tiles, grouped, with their
 * status. Public or for the signed-in admin (Settings › Homepage). Lives
 * outside the admin layout and calls nothing but `/api/home`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { HomeData, HomeService } from '@burrow/shared';
import { isApiError } from '../api/client';
import { useHome } from '../api/queries';
import { Icon } from '../components/Icon';
import { LogoMark } from '../components/Logo';
import { ThemeToggle } from '../components/ThemeToggle';
import { Spinner } from '../components/ui/Spinner';
import { t } from '../i18n';
import { cn } from '../lib/cn';
import { errorMessage } from '../lib/errors';

const LAMP: Record<NonNullable<HomeService['state']>, string> = {
  up: 'bg-success shadow-[0_0_0_3px_var(--success-soft)]',
  down: 'bg-danger shadow-[0_0_0_3px_var(--danger-soft)]',
  maintenance: 'bg-warning shadow-[0_0_0_3px_var(--warning-soft)]',
  unknown: 'bg-fg-muted/50',
};

export function HomePage() {
  const home = useHome();

  useEffect(() => {
    if (home.data) document.title = home.data.title;
  }, [home.data]);

  return (
    <div className="min-h-dvh bg-bg text-fg">
      {home.data ? (
        <HomeView data={home.data} />
      ) : (
        <div className="grid min-h-dvh place-items-center px-4 text-center">
          {home.isError ? (
            <div className="max-w-sm space-y-3">
              <LogoMark size={44} className="mx-auto" />
              <p className="font-medium">
                {isApiError(home.error, 'NOT_FOUND') ? t('home.off') : errorMessage(home.error)}
              </p>
            </div>
          ) : (
            <Spinner size={22} label={t('common.loading')} />
          )}
        </div>
      )}
    </div>
  );
}

function HomeView({ data }: { data: HomeData }) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);

  // `/` focuses the search, as on most dashboards.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key !== '/' || target?.closest('input, textarea, select')) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const all = data.groups.flatMap((g) => g.services);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data.groups;
    return data.groups
      .map((g) => ({
        ...g,
        services: g.services.filter((s) =>
          [s.title, s.description, s.url, g.name].some((v) => v.toLowerCase().includes(q)),
        ),
      }))
      .filter((g) => g.services.length > 0);
  }, [data.groups, query]);
  const up = all.filter((s) => s.state === 'up').length;
  const down = all.filter((s) => s.state === 'down').length;

  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-8 sm:px-8 sm:py-12">
      <header className="flex flex-wrap items-start gap-x-6 gap-y-5">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <LogoMark size={40} className="shrink-0" />
          <div className="min-w-0">
            <h1 className="truncate text-3xl font-semibold">{data.title}</h1>
            {data.subtitle ? (
              <p className="truncate text-sm text-fg-muted">{data.subtitle}</p>
            ) : null}
          </div>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <label className="relative flex-1 sm:w-64 sm:flex-none">
            <span className="sr-only">{t('home.search')}</span>
            <Icon
              name="search"
              size={15}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-muted"
            />
            <input
              ref={search}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('home.search')}
              className="h-9 w-full rounded-lg border border-border bg-surface pr-8 pl-9 text-sm text-fg placeholder:text-fg-muted focus:border-accent focus:ring-2 focus:ring-ring/40 focus:outline-none"
            />
            <kbd className="pointer-events-none absolute hidden sm:block top-1/2 right-2.5 -translate-y-1/2 rounded border border-border px-1 font-mono text-[10px] text-fg-muted">
              /
            </kbd>
          </label>
          <ThemeToggle />
        </div>
      </header>

      {data.showStatus && all.length > 0 ? (
        <p className="mt-6 flex items-center gap-2 text-sm text-fg-muted" aria-live="polite">
          <span className={cn('size-2 rounded-full', down > 0 ? LAMP.down : LAMP.up)} aria-hidden />
          {down > 0
            ? t('home.someDown', { count: down, total: all.length })
            : t('home.allUp', { up, total: all.length })}
        </p>
      ) : null}

      <main className="mt-8 flex-1 space-y-10">
        {all.length === 0 ? (
          <p className="py-16 text-center text-sm text-fg-muted">{t('home.empty')}</p>
        ) : groups.length === 0 ? (
          <p className="py-16 text-center text-sm text-fg-muted">
            {t('home.noMatch', { query: query.trim() })}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.name} aria-labelledby={`group-${group.name}`}>
              <div className="mb-3 flex items-center gap-3">
                <h2 id={`group-${group.name}`} className="text-base font-semibold text-fg">
                  {group.name}
                </h2>
                <span className="h-px flex-1 bg-border" aria-hidden />
                <span className="text-xs text-fg-muted tabular-nums">{group.services.length}</span>
              </div>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {group.services.map((s) => (
                  <li key={s.id}>
                    <Tile service={s} />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </main>

      <footer className="mt-14 flex items-center justify-center gap-2 text-xs text-fg-muted">
        <LogoMark size={14} />
        <span>
          {t('home.poweredBy')}{' '}
          <a
            href="https://github.com/noamroger/burrow"
            className="font-medium text-fg hover:text-accent"
            rel="noreferrer"
          >
            Burrow
          </a>
        </span>
      </footer>
    </div>
  );
}

function Tile({ service }: { service: HomeService }) {
  const host = service.url.replace(/^https:\/\//, '');
  return (
    <a
      href={service.url}
      rel="noreferrer"
      className="group relative flex h-full items-center gap-3.5 rounded-xl border border-border bg-surface p-3.5 transition-colors hover:border-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <ServiceIcon service={service} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium text-fg group-hover:text-accent">
            {service.title}
          </span>
          {service.state ? (
            <span
              className={cn('ml-auto size-2 shrink-0 rounded-full', LAMP[service.state])}
              role="img"
              aria-label={t(`home.state.${service.state}`)}
              title={t(`home.state.${service.state}`)}
            />
          ) : null}
        </span>
        {service.description ? (
          <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-fg-muted">
            {service.description}
          </span>
        ) : null}
        <span className="mt-1 block truncate font-mono text-[11px] text-fg-muted/80">{host}</span>
      </span>
    </a>
  );
}

function ServiceIcon({ service }: { service: HomeService }) {
  const [failed, setFailed] = useState(false);
  if (service.icon && !failed) {
    return (
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-2 p-2">
        <img
          src={service.icon}
          alt=""
          className="size-full object-contain"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <span
      className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent-soft font-display text-base font-semibold text-accent"
      aria-hidden
    >
      {service.monogram}
    </span>
  );
}
