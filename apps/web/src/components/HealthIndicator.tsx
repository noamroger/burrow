import type { OriginHealth } from '@burrow/shared';
import { t } from '../i18n';
import { formatRelative } from '../lib/format';
import { StatusDot, type Tone } from './ui/Badge';
import { Tooltip } from './ui/Tooltip';

const TONE: Record<OriginHealth['state'], Tone> = {
  up: 'success',
  down: 'danger',
  unknown: 'neutral',
};

/** Origin reachability: coloured dot, latency, and the probe details on hover. */
export function HealthIndicator({ health, now }: { health: OriginHealth; now?: number }) {
  const label =
    health.state === 'up'
      ? t('health.up')
      : health.state === 'down'
        ? t('health.down')
        : t('health.unknown');
  const details = [
    health.statusCode !== null ? t('health.status', { code: health.statusCode }) : null,
    health.error,
    health.checkedAt
      ? t('health.checked', { time: formatRelative(health.checkedAt, now) })
      : t('health.never'),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Tooltip content={details}>
      <span className="inline-flex items-center gap-2 text-sm">
        <StatusDot tone={TONE[health.state]} />
        <span className="text-fg">{label}</span>
        {health.state === 'up' && health.latencyMs !== null ? (
          <span className="text-xs text-fg-muted tabular-nums">
            {t('health.latency', { ms: health.latencyMs })}
          </span>
        ) : null}
      </span>
    </Tooltip>
  );
}
