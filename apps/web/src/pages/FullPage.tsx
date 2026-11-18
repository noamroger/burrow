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

/** Centered card on the earthy background, used by setup and login. */
export function AuthShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center px-4 py-10 sm:py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-gradient-to-b from-accent-soft to-transparent"
      />
      <div className={`relative w-full ${wide ? 'max-w-2xl' : 'max-w-md'}`}>
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <LogoMark size={52} />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('app.name')}</h1>
            <p className="text-sm text-fg-muted">{t('app.tagline')}</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
