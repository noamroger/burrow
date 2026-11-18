import { t, type MessageKey } from '../i18n';
import { cn } from '../lib/cn';
import { passwordStrength } from '../lib/password';

/** Four-segment strength meter shown under new-password fields. */
const STRENGTH_LABEL: MessageKey[] = [
  'password.strength0',
  'password.strength1',
  'password.strength2',
  'password.strength3',
  'password.strength4',
];
const STRENGTH_COLOR = ['bg-border', 'bg-danger', 'bg-warning', 'bg-success', 'bg-success'];

export function PasswordStrength({ password }: { password: string }) {
  const score = passwordStrength(password);
  return (
    <div className="space-y-1" aria-live="polite">
      <div className="flex gap-1" aria-hidden>
        {[1, 2, 3, 4].map((n) => (
          <span
            key={n}
            className={cn(
              'h-1 flex-1 rounded-full',
              n <= score ? STRENGTH_COLOR[score] : 'bg-border',
            )}
          />
        ))}
      </div>
      <p className="text-xs text-fg-muted">
        {password
          ? t('password.strength', { label: t(STRENGTH_LABEL[score]!) })
          : t('password.rule')}
      </p>
    </div>
  );
}
