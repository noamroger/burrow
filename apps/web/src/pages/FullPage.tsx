import type { ReactNode } from 'react';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { LogoMark } from '../components/Logo';
import { t } from '../i18n';
import { errorMessage } from '../lib/errors';

export function FullPageSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center text-fg-muted">
      <Spinner size={28} label={t('common.loading')} />
    </div>
  );
}

export function FullPageError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4 text-center">
        <LogoMark size={48} className="mx-auto" />
        <Alert tone="danger" title={t('errors.serverUnreachable')}>
          {errorMessage(error)}
        </Alert>
        <Button onClick={onRetry} icon="restart">
          {t('common.retry')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Layered hills along the bottom of the setup and sign-in screens, with a
 * burrow entrance and its lamp. Decorative only.
 */
function Hillside() {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 1440 320"
      preserveAspectRatio="xMidYMax slice"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-40 w-full sm:h-64"
    >
      <path d="M0 196C240 124 470 150 720 172s480-70 720-14v162H0z" fill="var(--soil-1)" />
      <path d="M0 248c300-58 540-36 820-18s420-28 620 2v88H0z" fill="var(--soil-2)" />
      <path d="M0 292c360-30 720-34 1440 0v28H0z" fill="var(--soil-3)" />
      <path d="M1016 296c30-58 140-58 170 0z" fill="var(--soil-3)" />
      <path d="M1074 296v-14a27 27 0 0 1 54 0v14z" fill="var(--sidebar)" />
      <circle cx="1101" cy="284" r="4" fill="var(--lamp)" />
    </svg>
  );
}

/** Centered card above the hillside, used by setup and login. */
export function AuthShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center overflow-hidden px-4 pt-10 pb-44 sm:pt-16 sm:pb-72">
      <Hillside />
      <div className={`relative w-full ${wide ? 'max-w-2xl' : 'max-w-md'}`}>
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <LogoMark size={56} />
          <div>
            <h1 className="text-3xl font-semibold text-fg">{t('app.name')}</h1>
            <p className="mt-0.5 text-fg-muted">{t('app.tagline')}</p>
          </div>
        </div>
        <div className="[&>section]:shadow-[0_1px_2px_rgb(42_31_24/0.06),0_12px_32px_-12px_rgb(42_31_24/0.18)]">
          {children}
        </div>
      </div>
    </div>
  );
}
