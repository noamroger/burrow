/**
 * Shown on the hosts page when Cloudflare differs from Burrow (someone
 * edited a route, a DNS record or an Access app in the dashboard).
 */
import { useState } from 'react';
import type { DriftItem } from '@burrow/shared';
import { useCheckDrift, useDrift, useResolveDrift } from '../api/queries';
import { t, type MessageKey } from '../i18n';
import { errorMessage } from '../lib/errors';
import { Alert } from './ui/Alert';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { useToast } from './ui/Toast';

const SHOWN = 5;

export function DriftAlert() {
  const drift = useDrift();
  const check = useCheckDrift();
  const resolve = useResolveDrift();
  const toast = useToast();
  const [confirm, setConfirm] = useState<'revert' | 'keep' | null>(null);

  const items = drift.data?.items ?? [];
  if (items.length === 0) return null;
  const pending = resolve.isPending ? resolve.variables : null;

  const run = (strategy: 'revert' | 'keep') =>
    resolve.mutate(strategy, {
      onSuccess: (report) => {
        setConfirm(null);
        toast.show(
          report.items.length === 0
            ? t(strategy === 'keep' ? 'drift.kept' : 'drift.reverted')
            : t('drift.body', { count: report.items.length }),
          report.items.length === 0 ? 'success' : 'danger',
        );
      },
      onError: (error) => toast.show(errorMessage(error), 'danger'),
    });

  return (
    <Alert tone="warning" title={t('drift.title')} className="mb-6">
      <p>{t('drift.body', { count: items.length })}</p>
      <DriftList items={items} />
      <div className="flex flex-wrap gap-2 pt-2">
        <Button size="sm" icon="sync" onClick={() => setConfirm('revert')} disabled={!!pending}>
          {t('drift.revert')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setConfirm('keep')}
          disabled={!!pending}
        >
          {t('drift.keep')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={check.isPending}
          onClick={() =>
            check.mutate(undefined, {
              onError: (error) => toast.show(errorMessage(error), 'danger'),
            })
          }
        >
          {t('drift.checkAgain')}
        </Button>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        tone="primary"
        title={t(confirm === 'keep' ? 'drift.keepTitle' : 'drift.revertTitle')}
        description={t(confirm === 'keep' ? 'drift.keepBody' : 'drift.revertBody')}
        confirmLabel={t(confirm === 'keep' ? 'drift.keep' : 'drift.revert')}
        loading={pending !== null}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && run(confirm)}
      >
        {confirm === 'keep' ? <DriftList items={items} showKeepable /> : null}
      </ConfirmDialog>
    </Alert>
  );
}

function DriftList({ items, showKeepable }: { items: DriftItem[]; showKeepable?: boolean }) {
  const shown = items.slice(0, SHOWN);
  return (
    <ul className="space-y-1.5 py-1">
      {shown.map((item, i) => (
        <li key={`${item.kind}-${item.target}-${i}`} className="text-sm">
          <span className="font-medium">{t(`drift.kind.${item.kind}` as MessageKey)}</span>
          <span className="text-fg-muted"> · {item.target}</span>
          {showKeepable ? (
            <Badge tone={item.keepable ? 'success' : 'neutral'} className="ml-2">
              {t(item.keepable ? 'drift.keepable' : 'drift.notKeepable')}
            </Badge>
          ) : null}
          <span className="block text-xs text-fg-muted">{item.detail}</span>
        </li>
      ))}
      {items.length > SHOWN ? (
        <li className="text-xs text-fg-muted">
          {t('drift.more', { count: items.length - SHOWN })}
        </li>
      ) : null}
    </ul>
  );
}
