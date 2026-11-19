/**
 * A quiet suggestion on the hosts page to turn on two-step verification.
 * Never blocks anything; "Not now" hides it for good on this browser.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useTwoFactor } from '../api/queries';
import { t } from '../i18n';
import { Icon } from './Icon';
import { Button } from './ui/Button';

const DISMISS_KEY = 'burrow.twoFactorHintDismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function TwoFactorHint() {
  const status = useTwoFactor();
  const [dismissed, setDismissed] = useState(readDismissed);
  if (dismissed || !status.data || status.data.enabled) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode: hide for this visit only */
    }
    setDismissed(true);
  };

  return (
    <div
      role="status"
      className="mb-6 flex flex-col gap-3 rounded-xl border border-accent/20 bg-accent-soft/60 px-4 py-3.5 text-sm sm:flex-row sm:items-center"
    >
      <span className="hidden size-9 shrink-0 items-center justify-center rounded-full bg-surface text-accent sm:flex">
        <Icon name="shield" size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-fg">{t('security.hintTitle')}</p>
        <p className="text-fg-muted">{t('security.hintBody')}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Link
          to="/settings#security"
          className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg hover:bg-accent-hover"
        >
          {t('security.setUp')}
        </Link>
        <Button size="sm" variant="ghost" onClick={dismiss}>
          {t('security.notNow')}
        </Button>
      </div>
    </div>
  );
}
