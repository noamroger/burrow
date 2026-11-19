/**
 * App shell: dark "soil" sidebar on desktop, top bar with a slide-in menu on
 * mobile. Pages render in <Outlet />.
 */
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { useHealth, useLogout, useMe, useTunnel } from '../api/queries';
import { t, type MessageKey } from '../i18n';
import { cn } from '../lib/cn';
import { Icon, type IconName } from './Icon';
import { Logo } from './Logo';
import { ThemeToggle } from './ThemeToggle';
import { StatusDot } from './ui/Badge';
import { IconButton } from './ui/Button';
import { tunnelTone } from './TunnelStatusBadge';

export const GITHUB_URL = 'https://github.com/noamroger/burrow';
export const SPONSOR_URL = 'https://buymeacoffee.com/noamroger';

const NAV: Array<{ to: string; label: MessageKey; icon: IconName; end?: boolean }> = [
  { to: '/', label: 'nav.hosts', icon: 'globe', end: true },
  { to: '/tunnel', label: 'nav.tunnel', icon: 'tunnel' },
  { to: '/monitoring', label: 'nav.monitoring', icon: 'activity' },
  { to: '/settings', label: 'nav.settings', icon: 'settings' },
];

export function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-screen lg:pl-64">
      <a
        href="#main"
        className="sr-only z-50 rounded bg-accent px-3 py-2 text-accent-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {t('nav.skip')}
      </a>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-white/5 bg-sidebar px-4 text-sidebar-fg lg:hidden">
        <Logo size={26} />
        <button
          type="button"
          aria-label={menuOpen ? t('nav.closeMenu') : t('nav.openMenu')}
          aria-expanded={menuOpen}
          aria-controls="sidebar"
          onClick={() => setMenuOpen((o) => !o)}
          className="-mr-2 flex size-10 items-center justify-center rounded-lg text-sidebar-fg hover:bg-sidebar-active"
        >
          <Icon name={menuOpen ? 'x' : 'menu'} size={22} />
        </button>
      </header>

      {menuOpen ? (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          aria-hidden
          onClick={() => setMenuOpen(false)}
        />
      ) : null}

      <aside
        id="sidebar"
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-sidebar text-sidebar-fg transition-transform lg:translate-x-0',
          menuOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full',
        )}
      >
        {/* Close the mobile menu after navigating. */}
        <SidebarContent onNavigate={() => setMenuOpen(false)} />
      </aside>

      <div className="flex min-h-screen flex-col lg:min-h-screen">
        <main
          id="main"
          className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
        >
          <Outlet />
        </main>
        <Footer />
      </div>
    </div>
  );
}

function SidebarContent({ onNavigate }: { onNavigate: () => void }) {
  const me = useMe();
  const tunnel = useTunnel();
  const logout = useLogout();
  const navigate = useNavigate();
  const status = tunnel.data?.tunnel?.status ?? 'unknown';

  return (
    <>
      <div className="hidden h-16 items-center px-5 lg:flex">
        <Logo />
      </div>
      <nav aria-label={t('nav.main')} className="flex-1 space-y-1 px-3 pt-4 lg:pt-2">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-sidebar-active text-sidebar-fg shadow-[inset_3px_0_0_var(--accent)]'
                  : 'text-sidebar-muted hover:bg-sidebar-active/60 hover:text-sidebar-fg',
              )
            }
          >
            <Icon name={item.icon} size={18} />
            <span className="flex-1">{t(item.label)}</span>
            {item.to === '/tunnel' && tunnel.data ? (
              <span title={t(`tunnel.status.${status}`)}>
                <StatusDot tone={tunnelTone(status)} pulse={status === 'healthy'} />
                <span className="sr-only">{t(`tunnel.status.${status}`)}</span>
              </span>
            ) : null}
          </NavLink>
        ))}
      </nav>

      <div className="space-y-3 border-t border-white/5 p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-sidebar-muted">{t('theme.label')}</span>
          <ThemeToggle />
        </div>
        {me.data ? (
          <div className="flex items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-active text-sidebar-muted">
              <Icon name="user" size={16} />
            </span>
            <span
              className="min-w-0 flex-1 truncate text-sm text-sidebar-fg"
              title={me.data.user.email}
            >
              {me.data.user.email}
            </span>
            <IconButton
              icon="logout"
              size="sm"
              label={t('nav.logout')}
              onClick={() =>
                logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) })
              }
              className="text-sidebar-muted hover:bg-sidebar-active hover:text-sidebar-fg"
            />
          </div>
        ) : null}
      </div>
    </>
  );
}

export function Footer() {
  const health = useHealth();
  return (
    <footer className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-5 text-xs text-fg-muted sm:px-6 lg:px-8">
      <span>
        {t('app.name')}{' '}
        {health.data ? <span className="tabular-nums">v{health.data.version}</span> : null}
        <span className="mx-1.5">·</span>
        {t('footer.tagline')}
      </span>
      <span className="inline-flex items-center gap-4">
        <a
          href={SPONSOR_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 hover:text-fg"
        >
          <Icon name="coffee" size={14} />
          {t('footer.sponsor')}
        </a>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 hover:text-fg"
        >
          <Icon name="github" size={14} />
          {t('footer.github')}
        </a>
      </span>
    </footer>
  );
}
