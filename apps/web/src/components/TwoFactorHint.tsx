/**
 * A quiet suggestion on the hosts page to turn on two-step verification.
 * Never blocks anything; "Not now" hides it for good on this browser.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useTwoFactor } from '../api/queries';
import { t } from '../i18n';
import { Alert } from './ui/Alert';
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
    <Alert
      tone="info"
      className="mb-6"
      title={t('security.hintTitle')}
      action={
        <div className="flex flex-wrap gap-2">
          <Link
            to="/settings#security"
            className="inline-flex h-8 items-center rounded-lg bg-accent px-2.5 text-sm font-medium text-accent-fg shadow-sm hover:bg-accent-hover"
          >
            {t('security.setUp')}
          </Link>
          <Button size="sm" variant="ghost" onClick={dismiss}>
            {t('security.notNow')}
          </Button>
        </div>
      }
    >
      {t('security.hintBody')}
    </Alert>
  );
}
