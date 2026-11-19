/** Turn maintenance mode on or off for one host, with its own page if wanted. */
import { useId, useState } from 'react';
import { maintenancePageSchema, type MaintenancePage, type ProxyHost } from '@burrow/shared';
import { useHostMaintenance, useMaintenancePage } from '../api/queries';
import { t } from '../i18n';
import { errorMessage } from '../lib/errors';
import { fieldErrors } from '../lib/zod';
import { MaintenancePageEditor } from './MaintenancePageEditor';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Checkbox, describedBy, Field, Input } from './ui/Field';
import { useToast } from './ui/Toast';

/** ISO → value of a datetime-local input (local time). */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function MaintenanceDialog({ host, onClose }: { host?: ProxyHost; onClose: () => void }) {
  return (
    <Dialog
      open={!!host}
      onClose={onClose}
      size="lg"
      title={host ? t('maintenance.dialogTitle', { hostname: host.hostname }) : ''}
      description={t('maintenance.dialogDescription')}
    >
      {host ? <MaintenanceForm key={host.id} host={host} onClose={onClose} /> : null}
    </Dialog>
  );
}

function MaintenanceForm({ host, onClose }: { host: ProxyHost; onClose: () => void }) {
  const uid = useId();
  const defaultPage = useMaintenancePage();
  const save = useHostMaintenance();
  const toast = useToast();
  const [until, setUntil] = useState(toLocalInput(host.maintenance.until));
  const [custom, setCustom] = useState<MaintenancePage | null>(host.maintenance.page);
  const active = host.maintenance.enabled;

  const parsed = custom ? maintenancePageSchema.safeParse(custom) : null;
  const errors = parsed && !parsed.success ? fieldErrors(parsed.error) : {};
  const untilIso = until ? new Date(until).toISOString() : null;

  function submit(enabled: boolean) {
    save.mutate(
      { id: host.id, input: { enabled, until: enabled ? untilIso : null, page: custom } },
      {
        onSuccess: () => {
          toast.show(
            t(enabled ? 'maintenance.onToast' : 'maintenance.offToast', {
              hostname: host.hostname,
            }),
            'success',
          );
          onClose();
        },
      },
    );
  }

  return (
    <div className="space-y-5">
      {save.isError ? <Alert tone="danger">{errorMessage(save.error)}</Alert> : null}
      <Field
        id={`${uid}-until`}
        label={t('maintenance.until')}
        aside={t('common.optional')}
        hint={t('maintenance.untilHint')}
      >
        <Input
          id={`${uid}-until`}
          type="datetime-local"
          value={until}
          onChange={(e) => setUntil(e.target.value)}
          aria-describedby={describedBy(`${uid}-until`, { hint: true })}
        />
      </Field>
      <Checkbox
        id={`${uid}-custom`}
        checked={!!custom}
        disabled={!defaultPage.data}
        onChange={(e) => setCustom(e.target.checked ? (defaultPage.data ?? null) : null)}
        label={t('maintenance.customPage')}
        description={t('maintenance.customPageHint')}
      />
      {custom ? (
        <MaintenancePageEditor
          value={custom}
          onChange={setCustom}
          hostname={host.hostname}
          until={untilIso}
          errors={errors}
        />
      ) : null}
      <div className="sticky -bottom-5 -mx-5 -mb-5 flex flex-col-reverse gap-2 border-t border-border bg-surface px-5 py-3.5 sm:flex-row sm:justify-end sm:rounded-b-2xl">
        <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
          {t('common.cancel')}
        </Button>
        {active ? (
          <Button variant="secondary" loading={save.isPending} onClick={() => submit(false)}>
            {t('maintenance.turnOff')}
          </Button>
        ) : null}
        <Button
          loading={save.isPending}
          disabled={!!custom && !parsed?.success}
          onClick={() => submit(true)}
        >
          {active ? t('maintenance.update') : t('maintenance.turnOn')}
        </Button>
      </div>
    </div>
  );
}
