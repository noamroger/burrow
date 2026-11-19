/**
 * Proxy hosts: the main screen. Lists every published service with its sync
 * status (Cloudflare side) and origin health (container → service).
 */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { isNonHttpService, serviceProtocol, type ProxyHost, type SyncResult } from '@burrow/shared';
import {
  useCheckHost,
  useDeleteHost,
  useHosts,
  useRunSync,
  useSaveHost,
  useTunnel,
  useTunnels,
  useZones,
} from '../api/queries';
import { DriftAlert } from '../components/DriftAlert';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { HealthIndicator } from '../components/HealthIndicator';
import { HostDialog } from '../components/HostDialog';
import { initialValues, toInput } from '../components/HostForm';
import { Icon } from '../components/Icon';
import { MaintenanceDialog } from '../components/MaintenanceDialog';
import { SyncBadge } from '../components/SyncBadge';
import { SyncResultPanel } from '../components/SyncResultPanel';
import { TunnelStatusBadge } from '../components/TunnelStatusBadge';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Input } from '../components/ui/Field';
import { PageSpinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import { useToast } from '../components/ui/Toast';
import { useNow } from '../hooks/useNow';
import { t, tPlural } from '../i18n';
import { cn } from '../lib/cn';
import { errorMessage } from '../lib/errors';
import { formatDateTime, formatRelative } from '../lib/format';

export function filterHosts(hosts: ProxyHost[], query: string): ProxyHost[] {
  const q = query.trim().toLowerCase();
  if (!q) return hosts;
  return hosts.filter(
    (h) =>
      h.hostname.includes(q) ||
      h.service.toLowerCase().includes(q) ||
      h.path.toLowerCase().includes(q),
  );
}

export function HostsPage() {
  const hosts = useHosts();
  const zones = useZones();
  const tunnel = useTunnel();
  const sync = useRunSync();
  const toast = useToast();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<ProxyHost | undefined>();
  const [creating, setCreating] = useState(() => params.get('new') === '1');
  const [deleting, setDeleting] = useState<ProxyHost | undefined>();
  const [maintaining, setMaintaining] = useState<ProxyHost | undefined>();
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  const enabledZones = useMemo(() => zones.data?.filter((z) => z.enabled) ?? [], [zones.data]);
  const list = useMemo(
    () => [...(hosts.data ?? [])].sort((a, b) => a.hostname.localeCompare(b.hostname)),
    [hosts.data],
  );
  const visible = useMemo(() => filterHosts(list, query), [list, query]);

  const attention = list.filter(
    (h) => h.sync.status === 'error' || h.sync.status === 'drift',
  ).length;
  const up = list.filter((h) => h.health.state === 'up').length;

  function closeCreate() {
    setCreating(false);
    if (params.has('new')) setParams({}, { replace: true });
  }

  async function runSync() {
    try {
      setSyncResult(await sync.mutateAsync());
    } catch (error) {
      toast.show(errorMessage(error), 'danger');
    }
  }

  const canCreate = enabledZones.length > 0;

  return (
    <>
      <PageHeader
        title={t('hosts.title')}
        description={t('hosts.description')}
        actions={
          <>
            <Button variant="secondary" icon="sync" onClick={runSync} loading={sync.isPending}>
              {t('hosts.syncNow')}
            </Button>
            <Button icon="plus" onClick={() => setCreating(true)} disabled={!canCreate}>
              {t('hosts.add')}
            </Button>
          </>
        }
      />

      <DriftAlert />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t('hosts.stats.tunnel')}>
          {tunnel.data?.tunnel ? (
            <TunnelStatusBadge status={tunnel.data.tunnel.status} />
          ) : (
            <span className="text-fg-muted">—</span>
          )}
        </Stat>
        <Stat label={t('hosts.stats.hosts')}>
          <span className="text-2xl font-semibold tabular-nums">{list.length}</span>
        </Stat>
        <Stat label={t('hosts.stats.attention')}>
          <span
            className={cn('text-2xl font-semibold tabular-nums', attention > 0 && 'text-danger')}
          >
            {attention}
          </span>
        </Stat>
        <Stat label={t('hosts.stats.origins')}>
          <span className="text-2xl font-semibold tabular-nums">
            {up}
            <span className="text-base font-normal text-fg-muted"> / {list.length}</span>
          </span>
        </Stat>
      </div>

      <div className="space-y-4">
        {syncResult ? (
          <SyncResultPanel result={syncResult} onDismiss={() => setSyncResult(null)} />
        ) : null}

        {zones.isSuccess && !canCreate ? (
          <Alert tone="warning" title={t('hosts.noZonesTitle')}>
            {t('hosts.noZonesBody')} <Link to="/settings">{t('hosts.noZonesLink')}</Link>
          </Alert>
        ) : null}

        <Card>
          {hosts.isPending ? (
            <PageSpinner />
          ) : hosts.isError ? (
            <div className="p-4">
              <Alert tone="danger" title={t('hosts.loadFailed')}>
                {errorMessage(hosts.error)}
              </Alert>
            </div>
          ) : list.length === 0 ? (
            <EmptyState
              icon="globe"
              title={t('hosts.emptyTitle')}
              action={
                canCreate ? (
                  <Button icon="plus" onClick={() => setCreating(true)}>
                    {t('hosts.addFirst')}
                  </Button>
                ) : null
              }
            >
              <p>{t('hosts.emptyBody')}</p>
              <p className="mt-3 inline-flex flex-wrap items-center justify-center gap-2 rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs text-fg">
                <span>nas.example.com</span>
                <Icon name="arrowDown" size={12} className="-rotate-90 text-accent" />
                <span>{t('hosts.emptyTunnel')}</span>
                <Icon name="arrowDown" size={12} className="-rotate-90 text-accent" />
                <span>http://192.168.1.20:5000</span>
              </p>
            </EmptyState>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
                <div className="relative w-full sm:max-w-xs">
                  <Icon
                    name="search"
                    className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-muted"
                  />
                  <label htmlFor="host-search" className="sr-only">
                    {t('hosts.search')}
                  </label>
                  <Input
                    id="host-search"
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('hosts.search')}
                    className="pl-9"
                  />
                </div>
                <p className="text-xs text-fg-muted" aria-live="polite">
                  {query
                    ? t('hosts.filtered', { shown: visible.length, total: list.length })
                    : tPlural('hosts.countOne', 'hosts.count', list.length)}
                </p>
              </div>
              {visible.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-fg-muted">
                  {t('hosts.noMatch', { query })}
                </p>
              ) : (
                <HostTable
                  hosts={visible}
                  now={now}
                  onEdit={setEditing}
                  onDelete={setDeleting}
                  onMaintenance={setMaintaining}
                />
              )}
            </>
          )}
        </Card>
      </div>

      <HostDialog open={creating} zones={enabledZones} onClose={closeCreate} />
      <HostDialog
        open={!!editing}
        host={editing}
        zones={enabledZones}
        onClose={() => setEditing(undefined)}
      />
      <DeleteHostDialog host={deleting} onClose={() => setDeleting(undefined)} />
      <MaintenanceDialog host={maintaining} onClose={() => setMaintaining(undefined)} />
    </>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3 shadow-sm">
      <p className="text-xs font-medium text-fg-muted">{label}</p>
      <div className="mt-1 flex h-8 items-center">{children}</div>
    </div>
  );
}

/* ------------------------------- table ------------------------------- */

interface RowProps {
  host: ProxyHost;
  now: number;
  onEdit: (host: ProxyHost) => void;
  onDelete: (host: ProxyHost) => void;
  onMaintenance: (host: ProxyHost) => void;
}

function HostTable({
  hosts,
  now,
  onEdit,
  onDelete,
  onMaintenance,
}: {
  hosts: ProxyHost[];
  now: number;
  onEdit: RowProps['onEdit'];
  onDelete: RowProps['onDelete'];
  onMaintenance: RowProps['onMaintenance'];
}) {
  return (
    <>
      {/* Desktop / tablet: table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-fg-muted">
            <tr className="border-b border-border">
              <th scope="col" className="px-4 py-2.5 font-medium">
                {t('hosts.col.hostname')}
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                {t('hosts.col.service')}
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                {t('hosts.col.sync')}
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                {t('hosts.col.origin')}
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                {t('hosts.col.enabled')}
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                <span className="sr-only">{t('hosts.col.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {hosts.map((host) => (
              <tr
                key={host.id}
                className={cn('align-middle hover:bg-surface-2/50', !host.enabled && 'opacity-60')}
              >
                <td className="max-w-64 px-4 py-3">
                  <HostnameLink host={host} />
                </td>
                <td className="max-w-64 px-4 py-3">
                  <code
                    className="block truncate font-mono text-xs text-fg-muted"
                    title={host.service}
                  >
                    {host.service}
                  </code>
                </td>
                <td className="px-4 py-3">
                  <SyncBadge sync={host.sync} />
                </td>
                <td className="px-4 py-3">
                  <HealthIndicator health={host.health} now={now} />
                </td>
                <td className="px-4 py-3">
                  <EnabledSwitch host={host} />
                </td>
                <td className="px-4 py-3">
                  <RowActions
                    host={host}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onMaintenance={onMaintenance}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: cards */}
      <ul className="divide-y divide-border md:hidden">
        {hosts.map((host) => (
          <li
            key={host.id}
            className={cn('space-y-2.5 px-4 py-3.5', !host.enabled && 'opacity-60')}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <HostnameLink host={host} />
              </div>
              <EnabledSwitch host={host} />
            </div>
            <code className="block truncate font-mono text-xs text-fg-muted">{host.service}</code>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <SyncBadge sync={host.sync} />
                <HealthIndicator health={host.health} now={now} />
              </div>
              <RowActions
                host={host}
                onEdit={onEdit}
                onDelete={onDelete}
                onMaintenance={onMaintenance}
              />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function HostnameLink({ host }: { host: ProxyHost }) {
  const tunnels = useTunnels();
  const several = (tunnels.data?.length ?? 0) > 1;
  const path = host.path.replace(/^\^/, '').replace(/\$$/, '');
  return (
    <div className="min-w-0">
      <a
        href={`https://${host.hostname}${path.startsWith('/') && !/[\\*+?()[\]|]/.test(path) ? path : ''}`}
        target="_blank"
        rel="noreferrer"
        className="group inline-flex max-w-full items-center gap-1.5 font-medium text-fg hover:text-accent"
      >
        <span className="truncate">{host.hostname}</span>
        {host.access.enabled ? (
          <span
            className="inline-flex shrink-0 text-accent"
            title={t('hosts.protected', {
              count: host.access.emails.length + host.access.emailDomains.length,
            })}
          >
            <Icon name="shield" size={13} />
            <span className="sr-only">{t('hosts.protectedSr')}</span>
          </span>
        ) : null}
        <Icon
          name="externalLink"
          size={13}
          className="shrink-0 text-fg-muted group-hover:text-accent"
        />
        <span className="sr-only">{t('common.opensNewTab')}</span>
      </a>
      {host.path ? (
        <p className="mt-0.5 truncate font-mono text-xs text-fg-muted" title={t('hosts.pathTitle')}>
          {t('hosts.pathLabel')} {host.path}
        </p>
      ) : null}
      {isNonHttpService(host.service) ? (
        <p className="mt-1">
          <Badge tone="accent">
            {serviceProtocol(host.service).toUpperCase()}
            {host.access.browserRendering ? ` · ${t('hosts.inBrowser')}` : ''}
          </Badge>
        </p>
      ) : null}
      {host.maintenance.enabled ? (
        <p className="mt-1">
          <Badge tone="warning" dot>
            {t('hosts.inMaintenance')}
          </Badge>
        </p>
      ) : null}
      {host.expiresAt ? (
        <p className="mt-1" title={formatDateTime(host.expiresAt)}>
          <Badge tone="warning">
            {t('hosts.expires', { when: formatRelative(host.expiresAt) })}
          </Badge>
        </p>
      ) : null}
      {host.source === 'docker' ? (
        <p className="mt-1" title={t('hosts.managedByDocker', { name: host.sourceRef ?? '?' })}>
          <Badge tone="info">{t('hosts.fromDocker', { name: host.sourceRef ?? '?' })}</Badge>
        </p>
      ) : null}
      {several && host.tunnelName ? (
        <p className="mt-0.5 truncate text-xs text-fg-muted">
          {t('hosts.viaTunnel', { name: host.tunnelName })}
        </p>
      ) : null}
    </div>
  );
}

function EnabledSwitch({ host }: { host: ProxyHost }) {
  const save = useSaveHost();
  const toast = useToast();
  return (
    <Switch
      checked={save.isPending ? !host.enabled : host.enabled}
      disabled={save.isPending || host.source === 'docker'}
      label={t(host.enabled ? 'hosts.disable' : 'hosts.enable', { hostname: host.hostname })}
      onChange={(enabled) =>
        save.mutate(
          { id: host.id, input: { ...toInput(initialValues(host, [])), enabled } },
          { onError: (error) => toast.show(errorMessage(error), 'danger') },
        )
      }
    />
  );
}

function RowActions({ host, onEdit, onDelete, onMaintenance }: Omit<RowProps, 'now'>) {
  const check = useCheckHost();
  const toast = useToast();
  return (
    <div className="flex items-center justify-end gap-0.5">
      <IconButton
        icon="activity"
        size="sm"
        label={t('hosts.checkNow', { hostname: host.hostname })}
        loading={check.isPending}
        onClick={() =>
          check.mutate(host.id, {
            onSuccess: (health) =>
              toast.show(
                health.state === 'up'
                  ? t('hosts.checkUp', { hostname: host.hostname, ms: health.latencyMs ?? '?' })
                  : t('hosts.checkDown', {
                      hostname: host.hostname,
                      error: health.error ?? health.state,
                    }),
                health.state === 'up' ? 'success' : 'danger',
              ),
            onError: (error) => toast.show(errorMessage(error), 'danger'),
          })
        }
      />
      <IconButton
        icon="coffee"
        size="sm"
        label={t('hosts.maintenance', { hostname: host.hostname })}
        onClick={() => onMaintenance(host)}
        className={host.maintenance.enabled ? 'text-warning' : undefined}
      />
      {host.source === 'docker' ? null : (
        <>
          <IconButton
            icon="pencil"
            size="sm"
            label={t('hosts.edit', { hostname: host.hostname })}
            onClick={() => onEdit(host)}
          />
          <IconButton
            icon="trash"
            size="sm"
            label={t('hosts.delete', { hostname: host.hostname })}
            onClick={() => onDelete(host)}
            className="hover:text-danger"
          />
        </>
      )}
    </div>
  );
}

function DeleteHostDialog({ host, onClose }: { host?: ProxyHost; onClose: () => void }) {
  const remove = useDeleteHost();
  const toast = useToast();
  return (
    <ConfirmDialog
      open={!!host}
      title={t('hosts.deleteTitle')}
      description={host ? t('hosts.deleteBody', { hostname: host.hostname }) : undefined}
      confirmLabel={t('hosts.deleteConfirm')}
      loading={remove.isPending}
      onCancel={onClose}
      onConfirm={() =>
        host &&
        remove.mutate(host.id, {
          onSuccess: () => {
            toast.show(t('hosts.deleted', { hostname: host.hostname }));
            onClose();
          },
          onError: (error) => toast.show(errorMessage(error), 'danger'),
        })
      }
    >
      {remove.isError ? <Alert tone="danger">{errorMessage(remove.error)}</Alert> : null}
    </ConfirmDialog>
  );
}
