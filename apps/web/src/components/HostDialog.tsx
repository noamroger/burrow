import type { ProxyHost, Zone } from '@burrow/shared';
import { useSaveHost } from '../api/queries';
import { t } from '../i18n';
import { accessChanged, HostForm } from './HostForm';
import { Dialog } from './ui/Dialog';
import { useToast } from './ui/Toast';

/** Create (no `host`) or edit a proxy host. */
export function HostDialog({
  open,
  host,
  zones,
  onClose,
}: {
  open: boolean;
  host?: ProxyHost;
  zones: Zone[];
  onClose: () => void;
}) {
  const save = useSaveHost();
  const toast = useToast();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={host ? t('host.editTitle', { hostname: host.hostname }) : t('host.createTitle')}
      description={host ? undefined : t('host.createDescription')}
    >
      <HostForm
        // Remount on every open so the form starts from the host's values.
        key={host?.id ?? 'new'}
        host={host}
        zones={zones}
        onCancel={onClose}
        onSubmit={async (input) => {
          const saved = await save.mutateAsync({ id: host?.id, input });
          const ok = saved.sync.status !== 'error';
          const message = ok
            ? t(host ? 'host.updated' : 'host.created', { hostname: saved.hostname })
            : t('host.savedWithError', { hostname: saved.hostname });
          // Cloudflare needs a moment before a new or changed Access app answers.
          const delay = ok && accessChanged(host, saved) ? ` ${t('host.access.delayToast')}` : '';
          toast.show(message + delay, ok ? 'success' : 'danger');
          onClose();
        }}
      />
    </Dialog>
  );
}
