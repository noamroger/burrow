/** Monitoring: every host with its status, latest probes and uptime. */
import { Link } from 'react-router';
import type { HostMonitorSummary } from '@burrow/shared';
import { useMonitoring, useTrafficOverview } from '../api/queries';
import { EmptyState } from '../components/EmptyState';
import { Heartbeats, formatPercent, uptimeTone } from '../components/monitoring/charts';
import { PageHeader } from '../components/PageHeader';
import { Alert } from '../components/ui/Alert';
import { Badge, StatusDot, type Tone } from '../components/ui/Badge';
import { Card } from '../components/ui/Card';
import { PageSpinner } from '../components/ui/Spinner';
import { useNow } from '../hooks/useNow';
import { t } from '../i18n';
import { cn } from '../lib/cn';
import { errorMessage } from '../lib/errors';
import { formatCount, formatUptime } from '../lib/format';

const STATE_TONE: Record<HostMonitorSummary['state'], Tone> = {
  up: 'success',
  down: 'danger',
  unknown: 'neutral',
};

const UPTIME_TEXT = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  neutral: 'text-fg-muted',
} as const;

export function MonitoringPage() {
  const monitoring = useMonitoring();
  // Traffic is optional (needs Zone › Analytics › Read): the column only shows when it works.
  const traffic = useTrafficOverview();
  const requests = traffic.data?.error
    ? null
    : new Map(traffic.data?.hosts.map((h) => [h.hostId, h.requests]));
  const data = monitoring.data;
  const hosts = data?.hosts ?? [];
  const down = hosts.filter((h) => h.state === 'down').length;

  return (
    <>
      <PageHeader
        title={t('monitoring.title')}
        description={
          data
            ? data.intervalSeconds > 0
              ? t('monitoring.description', {
                  interval: data.intervalSeconds,
                  days: data.retentionDays,
                })
              : t('monitoring.descriptionOff')
            : undefined
        }
        actions={
          data && hosts.length > 0 ? (
            down > 0 ? (
              <Badge tone="danger" dot pulse>
                {t('monitoring.downCount', { count: down })}
              </Badge>
            ) : (
              <Badge tone="success" dot>
                {t('monitoring.allUp')}
              </Badge>
            )
          ) : undefined
        }
      />
      {monitoring.isError ? (
        <Alert tone="danger">{errorMessage(monitoring.error)}</Alert>
      ) : !data ? (
        <PageSpinner />
      ) : hosts.length === 0 ? (
        <Card>
          <EmptyState icon="activity" title={t('monitoring.emptyTitle')}>
            {t('monitoring.emptyBody')}
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border">
            {hosts.map((h) => (
              <MonitorRow
                key={h.hostId}
                host={h}
                requests={requests ? (requests.get(h.hostId) ?? null) : undefined}
              />
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function MonitorRow({
  host,
  requests,
}: {
  host: HostMonitorSummary;
  /** Requests over 24 hours; undefined when traffic statistics are unavailable. */
  requests?: number | null;
}) {
  const now = useNow(30_000);
  const name = host.hostname + host.path;
  return (
    <li>
      <Link
        to={`/monitoring/${host.hostId}`}
        className="grid gap-x-6 gap-y-3 px-4 py-3.5 transition-colors hover:bg-surface-2/60 sm:px-5 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] md:items-center"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <StatusDot tone={STATE_TONE[host.state]} pulse={host.state === 'down'} />
          <div className="min-w-0">
            <p className={cn('truncate font-medium', host.enabled ? 'text-fg' : 'text-fg-muted')}>
              {name}
            </p>
            <p className="text-xs text-fg-muted">
              {!host.enabled
                ? t('monitoring.disabled')
                : host.state === 'down' && host.downSince
                  ? t('monitoring.downFor', { duration: formatUptime(host.downSince, now) })
                  : host.avgLatencyMs !== null
                    ? t('monitoring.avgLatency', { ms: host.avgLatencyMs })
                    : t('monitoring.noData')}
            </p>
          </div>
        </div>
        <Heartbeats beats={host.heartbeats} slots={40} className="md:max-w-md" />
        <dl className="flex gap-5 text-right text-xs">
          {requests !== undefined ? (
            <div className="min-w-14">
              <dt className="text-fg-muted">{t('monitoring.requests24h')}</dt>
              <dd className="font-mono text-sm font-semibold text-fg tabular-nums">
                {requests === null ? '—' : formatCount(requests)}
              </dd>
            </div>
          ) : null}
          {(
            [
              ['24h', host.uptime.h24],
              ['30d', host.uptime.d30],
            ] as const
          ).map(([label, ratio]) => (
            <div key={label} className="min-w-14">
              <dt className="text-fg-muted">{label}</dt>
              <dd
                className={cn(
                  'font-mono text-sm font-semibold tabular-nums',
                  UPTIME_TEXT[uptimeTone(ratio)],
                )}
              >
                {formatPercent(ratio)}
              </dd>
            </div>
          ))}
        </dl>
      </Link>
    </li>
  );
}
