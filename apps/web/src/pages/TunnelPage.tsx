/**
 * Tunnel: Cloudflare-side status and connectors, the local cloudflared
 * supervisor, and the live log stream.
 */
import { useState, type ReactNode } from 'react';
import { useTunnel, useTunnelAction } from '../api/queries';
import { LogViewer } from '../components/LogViewer';
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
  const tunnel = useTunnel();
  const action = useTunnelAction();
  const toast = useToast();
  const logs = useLogStream();
  const now = useNow(5_000);
  const [confirmStop, setConfirmStop] = useState(false);

  const run = (kind: 'start' | 'stop' | 'restart') =>
    action.mutate(kind, {
      onSuccess: () => {
        toast.show(t(`tunnel.action.${kind}Sent`), 'info');
        setConfirmStop(false);
      },
      onError: (error) => toast.show(errorMessage(error), 'danger'),
    });

  const supervisor = tunnel.data?.supervisor;
  const running =
    supervisor &&
    (supervisor.state === 'running' ||
      supervisor.state === 'starting' ||
      supervisor.state === 'backoff');
  const pending = action.isPending ? action.variables : undefined;

  return (
    <>
      <PageHeader
        title={t('tunnel.title')}
        description={t('tunnel.description')}
        actions={
          supervisor && supervisor.state !== 'disabled' ? (
            <>
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
            </>
          ) : null
        }
      />

      {tunnel.isPending ? (
        <PageSpinner />
      ) : tunnel.isError ? (
        <Alert tone="danger" title={t('tunnel.loadFailed')}>
          {errorMessage(tunnel.error)}
        </Alert>
      ) : (
        <div className="space-y-6">
          {supervisor?.state === 'disabled' ? (
            <Alert tone="info" title={t('supervisor.disabled')}>
              {t('tunnel.disabledHint')}
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
        </div>
      )}

      <section aria-labelledby="logs-title" className="mt-6 space-y-3">
        <div>
          <h2 id="logs-title" className="text-base font-semibold">
            {t('logs.title')}
          </h2>
          <p className="text-sm text-fg-muted">{t('logs.description')}</p>
        </div>
        <LogViewer lines={logs.lines} status={logs.status} onClear={logs.clear} />
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
    </>
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
