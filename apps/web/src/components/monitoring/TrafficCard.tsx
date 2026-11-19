/** Traffic of one host from Cloudflare Analytics: totals, requests over time, statuses, countries. */
import { Link } from 'react-router';
import type { HostTraffic, MonitoringRange } from '@burrow/shared';
import { isApiError } from '../../api/client';
import { useHostTraffic } from '../../api/queries';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { formatBytes, formatCount, formatDateTime } from '../../lib/format';
import { Alert } from '../ui/Alert';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { PageSpinner } from '../ui/Spinner';

const STATUS_COLORS: Record<keyof HostTraffic['statuses'], string> = {
  '2xx': 'bg-success',
  '3xx': 'bg-info',
  '4xx': 'bg-warning',
  '5xx': 'bg-danger',
};

const regionNames =
  typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : null;

function countryName(code: string): string {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

export function TrafficCard({ hostId, range }: { hostId: number; range: MonitoringRange }) {
  const traffic = useHostTraffic(hostId, range);
  const missing = isApiError(traffic.error, 'CLOUDFLARE_PERMISSION_MISSING');

  return (
    <Card>
      <CardHeader title={t('traffic.title')} description={t('traffic.hint')} />
      <CardBody>
        {missing ? (
          <Alert tone="info" title={t('traffic.permissionTitle')}>
            <p>{t('traffic.permissionBody')}</p>
            <Link to="/settings" className="font-medium text-accent underline underline-offset-2">
              {t('traffic.permissionLink')}
            </Link>
          </Alert>
        ) : traffic.isError ? (
          <Alert tone="danger">{errorMessage(traffic.error)}</Alert>
        ) : !traffic.data ? (
          <PageSpinner />
        ) : (
          <TrafficBody traffic={traffic.data} />
        )}
      </CardBody>
    </Card>
  );
}

function TrafficBody({ traffic }: { traffic: HostTraffic }) {
  const max = Math.max(1, ...traffic.series.map((p) => p.requests));
  const statusTotal = Object.values(traffic.statuses).reduce((a, b) => a + b, 0);
  const daily = traffic.range === '30d';

  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-3 gap-3">
        {(
          [
            ['traffic.requests', formatCount(traffic.totals.requests)],
            ['traffic.bandwidth', formatBytes(traffic.totals.bytes)],
            ['traffic.visits', formatCount(traffic.totals.visits)],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-fg-muted">{t(label)}</dt>
            <dd className="font-mono text-lg font-semibold text-fg tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      <div>
        <div
          className="flex h-28 items-end gap-px border-b border-border"
          role="img"
          aria-label={t('traffic.chartLabel', {
            total: traffic.totals.requests.toLocaleString(),
            range: traffic.range,
          })}
        >
          {traffic.series.map((p) => (
            <span
              key={p.start}
              title={`${daily ? new Date(p.start).toLocaleDateString() : formatDateTime(p.start)} · ${t('traffic.requestsCount', { count: p.requests.toLocaleString() })} · ${formatBytes(p.bytes)}`}
              className="min-w-px flex-1 rounded-t-[2px] bg-accent/70 transition-colors hover:bg-accent"
              style={{ height: `${Math.max(p.requests > 0 ? 2 : 0, (p.requests / max) * 100)}%` }}
            />
          ))}
        </div>
        <p className="mt-1 text-right text-[11px] text-fg-muted">
          {daily ? t('traffic.perDay') : t('traffic.perHour')}
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <p className="mb-2 text-xs font-medium text-fg-muted">{t('traffic.statuses')}</p>
          {statusTotal === 0 ? (
            <p className="text-sm text-fg-muted">{t('traffic.none')}</p>
          ) : (
            <>
              <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                {(Object.keys(traffic.statuses) as Array<keyof HostTraffic['statuses']>).map(
                  (k) => (
                    <span
                      key={k}
                      className={STATUS_COLORS[k]}
                      style={{ width: `${(traffic.statuses[k] / statusTotal) * 100}%` }}
                    />
                  ),
                )}
              </div>
              <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                {(Object.keys(traffic.statuses) as Array<keyof HostTraffic['statuses']>).map(
                  (k) => (
                    <li key={k} className="flex items-center gap-2">
                      <span className={cn('size-2 rounded-full', STATUS_COLORS[k])} aria-hidden />
                      <span className="font-mono text-fg">{k}</span>
                      <span className="ml-auto text-fg-muted tabular-nums">
                        {formatCount(traffic.statuses[k])}
                      </span>
                    </li>
                  ),
                )}
              </ul>
            </>
          )}
        </div>
        <div>
          <p className="mb-2 text-xs font-medium text-fg-muted">{t('traffic.countries')}</p>
          {traffic.topCountries.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('traffic.none')}</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {traffic.topCountries.map((c) => (
                <li key={c.country} className="grid grid-cols-[1fr_auto] items-center gap-x-3">
                  <span className="truncate text-fg">{countryName(c.country)}</span>
                  <span className="text-xs text-fg-muted tabular-nums">
                    {formatCount(c.requests)}
                  </span>
                  <span className="col-span-2 h-1 overflow-hidden rounded-full bg-surface-2">
                    <span
                      className="block h-full rounded-full bg-accent/60"
                      style={{
                        width: `${(c.requests / Math.max(1, traffic.topCountries[0]!.requests)) * 100}%`,
                      }}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="text-xs text-fg-muted">{t('traffic.sampled')}</p>
    </div>
  );
}
