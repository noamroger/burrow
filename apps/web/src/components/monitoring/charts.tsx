/**
 * Small, dependency-free charts for the monitoring pages: heartbeat strips,
 * a response time chart and an uptime band. Colours come from the theme
 * tokens, so light and dark modes need nothing special.
 */
import type { Heartbeat, MonitorBucket } from '@burrow/shared';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { formatDateTime } from '../../lib/format';

/** `0.99987` -> `99.98%`; never rounds up to 100%. */
export function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined) return '—';
  const pct = Math.floor(ratio * 10_000) / 100;
  return `${pct.toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** Tone of an uptime ratio. */
export function uptimeTone(ratio: number | null): 'success' | 'warning' | 'danger' | 'neutral' {
  if (ratio === null) return 'neutral';
  if (ratio >= 0.999) return 'success';
  if (ratio >= 0.95) return 'warning';
  return 'danger';
}

const BAR: Record<ReturnType<typeof uptimeTone>, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  neutral: 'bg-border',
};

/** The latest probes as a row of bars, oldest left; empty slots fill the start. */
export function Heartbeats({
  beats,
  slots = 60,
  className,
}: {
  beats: Heartbeat[];
  slots?: number;
  className?: string;
}) {
  const shown = beats.slice(-slots);
  const empty = slots - shown.length;
  const down = shown.filter((b) => !b.up).length;
  return (
    <div
      role="img"
      aria-label={t('monitoring.heartbeatsLabel', { count: shown.length, down })}
      className={cn('flex h-7 items-stretch gap-[2px]', className)}
    >
      {Array.from({ length: empty }, (_, i) => (
        <span key={`e${i}`} className="min-w-[2px] flex-1 rounded-[2px] bg-surface-2" />
      ))}
      {shown.map((b) => (
        <span
          key={b.at}
          title={`${formatDateTime(b.at)} · ${
            b.up
              ? b.latencyMs !== null
                ? t('health.latency', { ms: b.latencyMs })
                : t('health.up')
              : t('health.down')
          }`}
          className={cn(
            'min-w-[2px] flex-1 rounded-[2px] transition-transform hover:scale-y-110',
            b.up ? 'bg-success' : 'bg-danger',
          )}
        />
      ))}
    </div>
  );
}

/** One band per bucket, coloured by its uptime; grey without data. */
export function UptimeBand({ buckets }: { buckets: MonitorBucket[] }) {
  return (
    <div className="flex h-3 gap-px" aria-hidden>
      {buckets.map((b) => {
        const ratio = b.checks > 0 ? b.up / b.checks : null;
        return (
          <span
            key={b.start}
            title={`${formatDateTime(b.start)} · ${ratio === null ? t('monitoring.noData') : formatPercent(ratio)}`}
            className={cn('min-w-px flex-1 first:rounded-l last:rounded-r', BAR[uptimeTone(ratio)])}
          />
        );
      })}
    </div>
  );
}

/** Nice upper bound for an axis: 1, 2, 5 × 10^n. */
function niceMax(value: number): number {
  if (value <= 0) return 100;
  const exp = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) if (value <= step * exp) return step * exp;
  return 10 * exp;
}

/**
 * Average response time per bucket as a line over a soft area; the
 * slowest probe of each bucket as a faint dotted line. Gaps stay gaps.
 */
export function LatencyChart({ buckets }: { buckets: MonitorBucket[] }) {
  const W = 600;
  const H = 160;
  const max = niceMax(Math.max(0, ...buckets.map((b) => b.maxLatencyMs ?? b.avgLatencyMs ?? 0)));
  const x = (i: number) => (buckets.length <= 1 ? 0 : (i / (buckets.length - 1)) * W);
  const y = (v: number) => H - (v / max) * (H - 8);

  // Split into runs of buckets that have data.
  const runs: Array<Array<{ i: number; avg: number; max: number }>> = [];
  let run: Array<{ i: number; avg: number; max: number }> = [];
  buckets.forEach((b, i) => {
    if (b.avgLatencyMs === null) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push({ i, avg: b.avgLatencyMs, max: b.maxLatencyMs ?? b.avgLatencyMs });
  });
  if (run.length) runs.push(run);

  const line = (pts: Array<{ i: number; v: number }>) =>
    pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');

  const values = buckets.filter((b) => b.avgLatencyMs !== null).map((b) => b.avgLatencyMs!);
  const avg = values.length ? Math.round(values.reduce((a, v) => a + v, 0) / values.length) : null;

  return (
    <figure>
      <div className="relative">
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between text-[10px] text-fg-muted tabular-nums">
          <span className="border-b border-dashed border-border pb-0.5">{max} ms</span>
          <span className="border-b border-dashed border-border pb-0.5">{max / 2} ms</span>
          <span className="pb-0.5">0</span>
        </div>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="relative h-40 w-full overflow-visible"
          role="img"
          aria-label={
            avg === null
              ? t('monitoring.noData')
              : t('monitoring.latencyChartLabel', { avg, max: Math.max(...values) })
          }
        >
          {runs.map((r, k) => {
            const avgPts = r.map((p) => ({ i: p.i, v: p.avg }));
            const first = r[0]!;
            const last = r[r.length - 1]!;
            const area =
              r.length > 1
                ? `${line(avgPts)} L${x(last.i).toFixed(1)} ${H} L${x(first.i).toFixed(1)} ${H} Z`
                : '';
            return (
              <g key={k}>
                {area ? <path d={area} fill="var(--accent)" opacity={0.12} /> : null}
                <path
                  d={line(r.map((p) => ({ i: p.i, v: p.max })))}
                  fill="none"
                  stroke="var(--accent)"
                  strokeOpacity={0.35}
                  strokeWidth={1}
                  strokeDasharray="2 3"
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  d={line(avgPts)}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
                {r.length === 1 ? (
                  <circle cx={x(first.i)} cy={y(first.avg)} r={3} fill="var(--accent)" />
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-accent" aria-hidden />
          {t('monitoring.legendAvg')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-4 border-t border-dashed border-accent opacity-60" aria-hidden />
          {t('monitoring.legendMax')}
        </span>
      </figcaption>
    </figure>
  );
}
