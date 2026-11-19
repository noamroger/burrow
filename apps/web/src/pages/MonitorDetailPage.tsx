/** One host's history: uptime, response time, incidents and its public badge. */
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { MONITORING_RANGES, type HostMonitorDetail, type MonitoringRange } from '@burrow/shared';
import { useHostMonitoring } from '../api/queries';
import { BadgeCard } from '../components/monitoring/BadgeCard';
import {
  formatPercent,
  Heartbeats,
  LatencyChart,
  UptimeBand,
  uptimeTone,
} from '../components/monitoring/charts';
import { Icon } from '../components/Icon';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { PageSpinner } from '../components/ui/Spinner';
import { useNow } from '../hooks/useNow';
import { t } from '../i18n';
import { cn } from '../lib/cn';
import { errorMessage } from '../lib/errors';
import { formatDateTime, formatRelative, formatUptime } from '../lib/format';

export function MonitorDetailPage() {
  const id = Number(useParams().id);
  const [range, setRange] = useState<MonitoringRange>('24h');
  const detail = useHostMonitoring(id, range);

  return (
    <>
      <Link
        to="/monitoring"
        className="mb-3 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
      >
        <span aria-hidden>←</span> {t('monitoring.back')}
      </Link>
      {detail.isError ? (
        <Alert tone="danger">{errorMessage(detail.error)}</Alert>
      ) : !detail.data ? (
        <PageSpinner />
      ) : (
        <Detail detail={detail.data} range={range} onRange={setRange} />
      )}
    </>
  );
}

function Detail({
  detail,
  range,
  onRange,
}: {
  detail: HostMonitorDetail;
  range: MonitoringRange;
  onRange: (range: MonitoringRange) => void;
}) {
  const now = useNow(30_000);
  const { summary } = detail;
  const values = detail.buckets.filter((b) => b.avgLatencyMs !== null);
  const avg = values.length
    ? Math.round(
        values.reduce((a, b) => a + b.avgLatencyMs! * b.up, 0) /
          values.reduce((a, b) => a + b.up, 0),
      )
    : null;
  const checks = detail.buckets.reduce((a, b) => a + b.checks, 0);
  const stateTone =
    summary.state === 'up' ? 'success' : summary.state === 'down' ? 'danger' : 'neutral';

  return (
    <>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-fg">
              {summary.hostname + summary.path}
            </h1>
            <Badge tone={stateTone} dot pulse={summary.state === 'down'}>
              {summary.state === 'up'
                ? t('health.up')
                : summary.state === 'down'
                  ? t('health.down')
                  : t('health.unknown')}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-fg-muted">
            {summary.state === 'down' && summary.downSince
              ? t('monitoring.downSince', {
                  duration: formatUptime(summary.downSince, now),
                  when: formatDateTime(summary.downSince),
                })
              : summary.heartbeats.length
                ? t('monitoring.lastCheck', {
                    when: formatRelative(summary.heartbeats.at(-1)!.at, now),
                  })
                : t('monitoring.noData')}
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label={t('monitoring.range')}
          className="inline-flex rounded-lg border border-border bg-surface p-0.5"
        >
          {MONITORING_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={r === range}
              onClick={() => onRange(r)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium tabular-nums transition-colors',
                r === range ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:text-fg',
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-6">
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label={t('monitoring.uptimeRange', { range })}
            value={formatPercent(detail.uptime)}
            tone={uptimeTone(detail.uptime)}
          />
          <Stat label={t('monitoring.avgResponse')} value={avg !== null ? `${avg} ms` : '—'} />
          <Stat label={t('monitoring.incidents')} value={String(detail.incidents.length)} />
          <Stat label={t('monitoring.checks')} value={checks.toLocaleString()} />
        </dl>

        <Card>
          <CardHeader title={t('monitoring.responseTime')} />
          <CardBody className="space-y-4">
            <LatencyChart buckets={detail.buckets} />
            <div>
              <p className="mb-1.5 text-xs font-medium text-fg-muted">
                {t('monitoring.uptimeBand')}
              </p>
              <UptimeBand buckets={detail.buckets} />
              <div className="mt-1 flex justify-between text-[11px] text-fg-muted">
                <span>{formatDateTime(detail.buckets[0]?.start)}</span>
                <span>{t('time.now')}</span>
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium text-fg-muted">
                {t('monitoring.latestChecks')}
              </p>
              <Heartbeats beats={summary.heartbeats} />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={t('monitoring.incidentsTitle')} />
          {detail.incidents.length === 0 ? (
            <CardBody>
              <p className="flex items-center gap-2 text-sm text-fg-muted">
                <Icon name="check" size={16} className="text-success" />
                {t('monitoring.noIncidents', { range })}
              </p>
            </CardBody>
          ) : (
            <ul className="divide-y divide-border">
              {detail.incidents.map((i) => (
                <li
                  key={i.start}
                  className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3 sm:px-5"
                >
                  <span
                    className={cn(
                      'mt-1.5 size-2 shrink-0 rounded-full',
                      i.end ? 'bg-fg-muted' : 'animate-pulse bg-danger',
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-fg">
                      {i.end
                        ? t('monitoring.incidentResolved', {
                            duration: formatSeconds(i.durationSeconds),
                          })
                        : t('monitoring.incidentOngoing', {
                            duration: formatSeconds(i.durationSeconds),
                          })}
                    </p>
                    {i.error ? <p className="text-xs text-fg-muted">{i.error}</p> : null}
                  </div>
                  <time dateTime={i.start} className="text-xs text-fg-muted tabular-nums">
                    {formatDateTime(i.start)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <BadgeCard summary={summary} />
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'success' | 'warning' | 'danger' | 'neutral';
}) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3 shadow-sm">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd
        className={cn(
          'mt-1 font-mono text-xl font-semibold tabular-nums',
          tone === 'success'
            ? 'text-success'
            : tone === 'warning'
              ? 'text-warning'
              : tone === 'danger'
                ? 'text-danger'
                : 'text-fg',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/** 75 -> "1 min 15 s", 7300 -> "2 h 1 min". */
export function formatSeconds(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return s ? `${m} min ${s} s` : `${m} min`;
  return `${s} s`;
}
