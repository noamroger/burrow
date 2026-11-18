import type { SupervisorState, TunnelStatus } from '@burrow/shared';
import { t, type MessageKey } from '../i18n';
import { Badge, type Tone } from './ui/Badge';

const TUNNEL: Record<TunnelStatus, { tone: Tone; label: MessageKey }> = {
  healthy: { tone: 'success', label: 'tunnel.status.healthy' },
  degraded: { tone: 'warning', label: 'tunnel.status.degraded' },
  down: { tone: 'danger', label: 'tunnel.status.down' },
  inactive: { tone: 'neutral', label: 'tunnel.status.inactive' },
  unknown: { tone: 'neutral', label: 'tunnel.status.unknown' },
};

const SUPERVISOR: Record<SupervisorState, { tone: Tone; label: MessageKey }> = {
  running: { tone: 'success', label: 'supervisor.running' },
  starting: { tone: 'info', label: 'supervisor.starting' },
  backoff: { tone: 'warning', label: 'supervisor.backoff' },
  stopped: { tone: 'neutral', label: 'supervisor.stopped' },
  disabled: { tone: 'neutral', label: 'supervisor.disabled' },
};

export function tunnelTone(status: TunnelStatus): Tone {
  return TUNNEL[status].tone;
}

export function TunnelStatusBadge({ status }: { status: TunnelStatus }) {
  const look = TUNNEL[status];
  return (
    <Badge tone={look.tone} dot pulse={status === 'healthy'}>
      {t(look.label)}
    </Badge>
  );
}

export function SupervisorBadge({ state }: { state: SupervisorState }) {
  const look = SUPERVISOR[state];
  return (
    <Badge tone={look.tone} dot pulse={state === 'starting'}>
      {t(look.label)}
    </Badge>
  );
}
