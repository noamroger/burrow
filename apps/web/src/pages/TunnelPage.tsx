/**
 * Tunnels: pick a tunnel, see its Cloudflare-side status and connectors, its
 * local cloudflared supervisor and settings, and the live log stream.
 * Tunnels can be created or imported from the account here.
 */
import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type { TunnelSummary } from '@burrow/shared';
import {
  useDeleteTunnel,
  useTunnelControl,
  useTunnelInfo,
  useTunnels,
  useUpdateTunnel,
} from '../api/queries';
import { LogViewer } from '../components/LogViewer';
import { CreateTunnelDialog, ImportTunnelDialog } from '../components/TunnelDialogs';
import { Badge, StatusDot } from '../components/ui/Badge';
import { Checkbox } from '../components/ui/Field';
import { Switch } from '../components/ui/Switch';
import { tunnelTone } from '../components/TunnelStatusBadge';
import { cn } from '../lib/cn';
import { PageHeader } from '../components/PageHeader';
import { SupervisorBadge, TunnelStatusBadge } from '../components/TunnelStatusBadge';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { PageSpinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';
import { useLogStream } from '../hooks/useLogStream';
import { useNow } from '../hooks/useNow';
import { t } from '../i18n';
import { errorMessage } from '../lib/errors';
import { formatDateTime, formatRelative, formatUptime } from '../lib/format';

export function TunnelPage() {
  const tunnels = useTunnels();
  const [params, setParams] = useSearchParams();
  const list = tunnels.data ?? [];
  const selected =
    list.find((x) => String(x.id) === params.get('tunnel')) ??
    list.find((x) => x.isDefault) ??
    list[0];
  const select = (id: number) => setParams({ tunnel: String(id) }, { replace: true });

  const tunnel = useTunnelInfo(selected?.id);
  const action = useTunnelControl();
  const toast = useToast();
  const logs = useLogStream();
  const now = useNow(5_000);
  const [confirmStop, setConfirmStop] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  // With several tunnels, only show the selected tunnel's cloudflared lines.
  const lines =
    list.length > 1 && selected
      ? logs.lines.filter((l) => !l.tunnel || l.tunnel === selected.name)
      : logs.lines;

  const run = (kind: 'start' | 'stop' | 'restart') =>
    selected &&
    action.mutate(
      { id: selected.id, action: kind },
      {
        onSuccess: () => {
          toast.show(t(`tunnel.action.${kind}Sent`), 'info');
          setConfirmStop(false);
        },
        onError: (error) => toast.show(errorMessage(error), 'danger'),
      },
    );

  const supervisor = tunnel.data?.supervisor;
  const running =
    supervisor &&
    (supervisor.state === 'running' ||
      supervisor.state === 'starting' ||
      supervisor.state === 'backoff');
  const pending = action.isPending ? action.variables?.action : undefined;

  return (
    <>
      <PageHeader
        title={t('tunnel.title')}
        description={t('tunnel.description')}
        actions={
          <>
            <Button variant="secondary" icon="download" onClick={() => setImporting(true)}>
              {t('tunnels.import')}
            </Button>
            <Button variant="secondary" icon="plus" onClick={() => setCreating(true)}>
              {t('tunnels.add')}
            </Button>
          </>
        }
      />

      {list.length > 1 ? (
        <TunnelPicker tunnels={list} selectedId={selected?.id} onSelect={select} />
      ) : null}

      {selected && supervisor && supervisor.state !== 'disabled' ? (
        <div className="mb-4 flex flex-wrap justify-end gap-2">
          {running ? (
            <Button
              variant="secondary"
              icon="stop"
              onClick={() => setConfirmStop(true)}
              disabled={action.isPending}
            >
              {t('tunnel.stop')}
            </Button>
          ) : (
            <Button
              variant="secondary"
              icon="play"
              onClick={() => run('start')}
              loading={pending === 'start'}
              disabled={action.isPending}
            >
              {t('tunnel.start')}
            </Button>
          )}
          <Button
            icon="restart"
            onClick={() => run('restart')}
            loading={pending === 'restart'}
            disabled={action.isPending}
          >
            {t('tunnel.restart')}
          </Button>
        </div>
      ) : null}

      {tunnels.isPending || (selected && tunnel.isPending) ? (
        <PageSpinner />
      ) : tunnels.isError || tunnel.isError ? (
        <Alert tone="danger" title={t('tunnel.loadFailed')}>
          {errorMessage(tunnels.error ?? tunnel.error)}
        </Alert>
      ) : !selected || !tunnel.data ? (
        <p className="text-sm text-fg-muted">{t('tunnel.noTunnel')}</p>
      ) : (
        <div className="space-y-6">
          {supervisor?.state === 'disabled' ? (
            <Alert tone="info" title={t('supervisor.disabled')}>
              {selected.runConnector ? t('tunnel.disabledHint') : t('tunnels.notRunHint')}
            </Alert>
          ) : null}
          {supervisor?.state === 'backoff' && supervisor.nextRetryAt ? (
            <Alert tone="warning" title={t('tunnel.backoffTitle')}>
              {t('tunnel.backoffBody', {
                code: supervisor.lastExitCode ?? '?',
                time: formatRelative(supervisor.nextRetryAt, now),
              })}
            </Alert>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title={t('tunnel.cloudflare')}
                actions={
                  tunnel.data.tunnel ? (
                    <TunnelStatusBadge status={tunnel.data.tunnel.status} />
                  ) : null
                }
              />
              <CardBody>
                {tunnel.data.tunnel ? (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
                    <Item label={t('tunnel.name')}>{tunnel.data.tunnel.name}</Item>
                    <Item label={t('tunnel.id')}>
                      <code className="font-mono text-xs break-all">{tunnel.data.tunnel.id}</code>
                    </Item>
                    <Item label={t('tunnel.created')}>
                      <span title={formatDateTime(tunnel.data.tunnel.createdAt)}>
                        {formatRelative(tunnel.data.tunnel.createdAt, now)}
                      </span>
                    </Item>
                    <Item label={t('tunnel.connectors')}>{tunnel.data.connectors.length}</Item>
                  </dl>
                ) : (
                  <p className="text-sm text-fg-muted">{t('tunnel.noTunnel')}</p>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title={t('tunnel.supervisor')}
                actions={supervisor ? <SupervisorBadge state={supervisor.state} /> : null}
              />
              <CardBody>
                {supervisor ? (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
                    <Item label={t('tunnel.version')}>
                      <code className="font-mono text-xs">
                        {supervisor.cloudflaredVersion ?? '—'}
                      </code>
                    </Item>
                    <Item label={t('tunnel.uptime')}>
                      {supervisor.state === 'running'
                        ? formatUptime(supervisor.startedAt, now)
                        : '—'}
                    </Item>
                    <Item label={t('tunnel.pid')}>
                      <span className="tabular-nums">{supervisor.pid ?? '—'}</span>
                    </Item>
                    <Item label={t('tunnel.restarts')}>
                      <span className="tabular-nums">{supervisor.restarts}</span>
                      {supervisor.lastExitCode !== null ? (
                        <span className="ml-2 text-xs text-fg-muted">
                          {t('tunnel.lastExit', { code: supervisor.lastExitCode })}
                        </span>
                      ) : null}
                    </Item>
                  </dl>
                ) : null}
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader title={t('tunnel.connections')} description={t('tunnel.connectionsHint')} />
            <ConnectorsTable connectors={tunnel.data.connectors} now={now} />
          </Card>

          <TunnelSettingsCard
            tunnel={selected}
            onDeleted={() => setParams({}, { replace: true })}
          />
        </div>
      )}

      <section aria-labelledby="logs-title" className="mt-6 space-y-3">
        <div>
          <h2 id="logs-title" className="text-base font-semibold">
            {t('logs.title')}
          </h2>
          <p className="text-sm text-fg-muted">{t('logs.description')}</p>
        </div>
        <LogViewer lines={lines} status={logs.status} onClear={logs.clear} />
      </section>

      <ConfirmDialog
        open={confirmStop}
        title={t('tunnel.stopTitle')}
        description={t('tunnel.stopBody')}
        confirmLabel={t('tunnel.stop')}
        loading={pending === 'stop'}
        onCancel={() => setConfirmStop(false)}
        onConfirm={() => run('stop')}
      />
      <CreateTunnelDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          select(id);
          toast.show(t('tunnels.created'));
        }}
      />
      <ImportTunnelDialog
        open={importing}
        onClose={() => setImporting(false)}
        onImported={(id) => select(id)}
      />
    </>
  );
}

function TunnelPicker({
  tunnels,
  selectedId,
  onSelect,
}: {
  tunnels: TunnelSummary[];
  selectedId: number | undefined;
  onSelect: (id: number) => void;
}) {
  return (
    <nav aria-label={t('tunnels.pick')} className="mb-6 flex flex-wrap gap-2">
      {tunnels.map((tunnel) => {
        const active = tunnel.id === selectedId;
        return (
          <button
            key={tunnel.id}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => onSelect(tunnel.id)}
            className={cn(
              'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'border-accent bg-surface text-fg shadow-sm'
                : 'border-border text-fg-muted hover:bg-surface hover:text-fg',
            )}
          >
            <StatusDot tone={tunnelTone(tunnel.status)} />
            {tunnel.name}
            {tunnel.isDefault ? <Badge tone="accent">{t('tunnels.default')}</Badge> : null}
            <span className="text-xs text-fg-muted tabular-nums">{tunnel.hostCount}</span>
          </button>
        );
      })}
    </nav>
  );
}

function TunnelSettingsCard({
  tunnel,
  onDeleted,
}: {
  tunnel: TunnelSummary;
  onDeleted: () => void;
}) {
  const update = useUpdateTunnel();
  const remove = useDeleteTunnel();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteOnCloudflare, setDeleteOnCloudflare] = useState(tunnel.origin === 'created');
  const onError = (error: unknown) => toast.show(errorMessage(error), 'danger');

  return (
    <Card>
      <CardHeader
        title={t('tunnels.settings')}
        description={
          tunnel.origin === 'imported' ? t('tunnels.originImported') : t('tunnels.originCreated')
        }
        actions={
          <>
            {!tunnel.isDefault ? (
              <Button
                variant="secondary"
                size="sm"
                icon="star"
                loading={update.isPending && update.variables?.input.isDefault === true}
                onClick={() =>
                  update.mutate({ id: tunnel.id, input: { isDefault: true } }, { onError })
                }
              >
                {t('tunnels.makeDefault')}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              icon="trash"
              className="hover:text-danger"
              disabled={tunnel.isDefault}
              title={tunnel.isDefault ? t('tunnels.deleteDefault') : undefined}
              onClick={() => {
                setDeleteOnCloudflare(tunnel.origin === 'created');
                setConfirmDelete(true);
              }}
            >
              {t('tunnels.delete')}
            </Button>
          </>
        }
      />
      <CardBody>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">{t('tunnels.runConnector')}</p>
            <p className="text-xs text-fg-muted">{t('tunnels.runConnectorHint')}</p>
          </div>
          <Switch
            checked={tunnel.runConnector}
            label={t('tunnels.runConnector')}
            disabled={update.isPending}
            onChange={(runConnector) =>
              update.mutate({ id: tunnel.id, input: { runConnector } }, { onError })
            }
          />
        </div>
      </CardBody>

      <ConfirmDialog
        open={confirmDelete}
        title={t('tunnels.deleteTitle', { name: tunnel.name })}
        description={
          tunnel.hostCount > 0
            ? t('tunnels.deleteHasHosts', { count: tunnel.hostCount })
            : t('tunnels.deleteBody')
        }
        confirmLabel={t('tunnels.delete')}
        loading={remove.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() =>
          remove.mutate(
            { id: tunnel.id, deleteOnCloudflare },
            {
              onSuccess: () => {
                setConfirmDelete(false);
                toast.show(t('tunnels.deleted', { name: tunnel.name }), 'info');
                onDeleted();
              },
              onError,
            },
          )
        }
      >
        <Checkbox
          id={`delete-cf-${tunnel.id}`}
          checked={deleteOnCloudflare}
          onChange={(e) => setDeleteOnCloudflare(e.target.checked)}
          label={t('tunnels.deleteOnCloudflare')}
          description={t('tunnels.deleteOnCloudflareHint')}
        />
      </ConfirmDialog>
    </Card>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </>
  );
}

function ConnectorsTable({
  connectors,
  now,
}: {
  connectors: import('@burrow/shared').Connector[];
  now: number;
}) {
  const rows = connectors.flatMap((c) =>
    c.connections.map((conn, i) => ({ connector: c, conn, key: `${c.id}-${i}` })),
  );
  if (rows.length === 0) {
    return (
      <p className="px-5 py-8 text-center text-sm text-fg-muted">{t('tunnel.noConnections')}</p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-left text-sm">
        <thead className="text-xs text-fg-muted">
          <tr className="border-b border-border">
            <th scope="col" className="px-5 py-2.5 font-medium">
              {t('tunnel.col.colo')}
            </th>
            <th scope="col" className="px-5 py-2.5 font-medium">
              {t('tunnel.col.originIp')}
            </th>
            <th scope="col" className="px-5 py-2.5 font-medium">
              {t('tunnel.col.openedAt')}
            </th>
            <th scope="col" className="px-5 py-2.5 font-medium">
              {t('tunnel.col.connector')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(({ connector, conn, key }) => (
            <tr key={key}>
              <td className="px-5 py-2.5">
                <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs font-semibold">
                  {conn.colo}
                </span>
              </td>
              <td className="px-5 py-2.5 font-mono text-xs">{conn.originIp}</td>
              <td className="px-5 py-2.5" title={formatDateTime(conn.openedAt)}>
                {formatRelative(conn.openedAt, now)}
              </td>
              <td className="px-5 py-2.5 text-xs text-fg-muted">
                <code className="font-mono">{connector.id.slice(0, 8)}</code> · {connector.version}{' '}
                · {connector.arch}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
