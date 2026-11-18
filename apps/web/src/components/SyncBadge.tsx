import type { ProxyHost } from '@burrow/shared';
import { t, type MessageKey } from '../i18n';
import { formatDateTime } from '../lib/format';
import { Badge, type Tone } from './ui/Badge';
import { Tooltip } from './ui/Tooltip';

const LOOK: Record<
  ProxyHost['sync']['status'],
  { tone: Tone; label: MessageKey; hint: MessageKey }
> = {
  synced: { tone: 'success', label: 'sync.synced', hint: 'sync.syncedHint' },
  pending: { tone: 'info', label: 'sync.pending', hint: 'sync.pendingHint' },
  drift: { tone: 'warning', label: 'sync.drift', hint: 'sync.driftHint' },
  error: { tone: 'danger', label: 'sync.error', hint: 'sync.errorHint' },
};

/**
 * Sync status of a host with Cloudflare. Hover or focus shows the details:
 * the error message for `error`/`drift`, the last sync time otherwise.
 */
export function SyncBadge({ sync }: { sync: ProxyHost['sync'] }) {
  const look = LOOK[sync.status];
  const details = (
    <span className="block space-y-1">
      <span className="block">{sync.error ?? t(look.hint)}</span>
      {sync.lastSyncedAt ? (
        <span className="block opacity-70">
          {t('sync.lastSynced', { time: formatDateTime(sync.lastSyncedAt) })}
        </span>
      ) : null}
    </span>
  );
  return (
    <Tooltip content={details}>
      <Badge tone={look.tone} dot pulse={sync.status === 'pending'}>
        {t(look.label)}
        {sync.status === 'error' || sync.status === 'drift' ? (
          <span className="sr-only">: {sync.error}</span>
        ) : null}
      </Badge>
    </Tooltip>
  );
}
