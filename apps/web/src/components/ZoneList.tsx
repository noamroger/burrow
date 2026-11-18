import type { Zone } from '@burrow/shared';
import { useUpdateZone, useZones } from '../api/queries';
import { t, tPlural } from '../i18n';
import { errorMessage } from '../lib/errors';
import { EmptyState } from './EmptyState';
import { Alert } from './ui/Alert';
import { PageSpinner } from './ui/Spinner';
import { Switch } from './ui/Switch';
import { Tooltip } from './ui/Tooltip';

/** Zones visible with the token, each with an "allow Burrow to publish here" switch. */
export function ZoneList() {
  const zones = useZones();
  const update = useUpdateZone();

  if (zones.isPending) return <PageSpinner />;
  if (zones.isError)
    return (
      <Alert tone="danger" title={t('zones.loadFailed')}>
        {errorMessage(zones.error)}
      </Alert>
    );
  if (zones.data.length === 0) {
    return (
      <EmptyState icon="globe" title={t('zones.emptyTitle')}>
        {t('zones.emptyBody')}
      </EmptyState>
    );
  }

  return (
    <div className="space-y-3">
      {update.isError ? <Alert tone="danger">{errorMessage(update.error)}</Alert> : null}
      <ul className="divide-y divide-border rounded-lg border border-border">
        {zones.data.map((zone) => (
          <ZoneRow
            key={zone.id}
            zone={zone}
            busy={update.isPending && update.variables?.id === zone.id}
            onToggle={(enabled) => update.mutate({ id: zone.id, enabled })}
          />
        ))}
      </ul>
    </div>
  );
}

function ZoneRow({
  zone,
  busy,
  onToggle,
}: {
  zone: Zone;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const locked = zone.enabled && zone.hostCount > 0;
  const toggle = (
    <Switch
      checked={zone.enabled}
      onChange={onToggle}
      disabled={busy || locked}
      label={t(zone.enabled ? 'zones.disable' : 'zones.enable', { zone: zone.name })}
    />
  );
  return (
    <li className="flex items-center justify-between gap-3 px-3.5 py-3">
      <div className="min-w-0">
        <p className="truncate font-medium text-fg">{zone.name}</p>
        <p className="text-xs text-fg-muted">
          {zone.hostCount > 0
            ? tPlural('zones.hostCountOne', 'zones.hostCount', zone.hostCount)
            : zone.enabled
              ? t('zones.enabledNoHosts')
              : t('zones.disabled')}
        </p>
      </div>
      {locked ? <Tooltip content={t('zones.lockedHint')}>{toggle}</Tooltip> : toggle}
    </li>
  );
}
