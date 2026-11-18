import type { SyncResult } from '@burrow/shared';
import { t, tPlural } from '../i18n';
import { formatRelative } from '../lib/format';
import { Icon } from './Icon';
import { Alert } from './ui/Alert';
import { IconButton } from './ui/Button';

/** Summary of a reconciliation run (POST /api/sync). */
export function SyncResultPanel({
  result,
  onDismiss,
}: {
  result: SyncResult;
  onDismiss: () => void;
}) {
  const failed = result.actions.filter((a) => !a.ok);
  const title =
    result.actions.length === 0
      ? t('sync.result.inSync')
      : result.ok
        ? tPlural('sync.result.appliedOne', 'sync.result.applied', result.actions.length)
        : tPlural('sync.result.failedOne', 'sync.result.failed', failed.length);

  return (
    <Alert
      tone={result.ok ? 'success' : 'danger'}
      title={title}
      action={
        <IconButton
          icon="x"
          size="sm"
          label={t('common.dismiss')}
          onClick={onDismiss}
          className="-my-1"
        />
      }
    >
      {result.actions.length > 0 ? (
        <ul className="mt-1 space-y-1">
          {result.actions.map((a, i) => (
            <li key={`${a.kind}-${a.target}-${i}`} className="flex items-start gap-2 text-xs">
              <Icon
                name={a.ok ? 'check' : 'x'}
                size={13}
                className={a.ok ? 'mt-px text-success' : 'mt-px text-danger'}
              />
              <span>
                <code className="font-mono text-fg">{a.kind}</code> {a.target}
                {a.error ? <span className="block text-danger">{a.error}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {result.finishedAt ? (
        <p className="mt-1 text-xs">
          {t('sync.result.finished', { time: formatRelative(result.finishedAt) })}
        </p>
      ) : null}
    </Alert>
  );
}
