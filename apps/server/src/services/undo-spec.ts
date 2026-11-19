import type {
  HomepageSettings,
  HostMaintenanceInput,
  MaintenancePage,
  ProxyHostInput,
} from '@burrow/shared';

/**
 * How to reverse an audited change. Stored with the audit entry; `expect` is
 * the state right after the change: the undo is refused when the current
 * state differs (something changed since), so it never overwrites newer work.
 */
export type UndoSpec =
  /** Undo a host creation: delete it. */
  | { kind: 'host.delete'; hostId: number; expect: ProxyHostInput }
  /** Undo a host update: put the previous settings back. */
  | { kind: 'host.restore'; hostId: number; input: ProxyHostInput; expect: ProxyHostInput }
  /** Undo a host deletion: publish it again. */
  | {
      kind: 'host.recreate';
      input: ProxyHostInput;
      extra: Record<string, unknown>;
    }
  /** Undo maintenance on/off for a host. */
  | {
      kind: 'host.maintenance';
      hostId: number;
      input: HostMaintenanceInput;
      expect: boolean;
    }
  | { kind: 'zone.enabled'; zoneId: string; enabled: boolean }
  | { kind: 'docker.enabled'; enabled: boolean }
  | { kind: 'drift.autoRepair'; enabled: boolean }
  | { kind: 'homepage.settings'; settings: HomepageSettings; expect: HomepageSettings }
  | { kind: 'maintenance.page'; page: MaintenancePage; expect: MaintenancePage }
  /** Undo "run cloudflared in Burrow" on/off, or a change of default tunnel. */
  | {
      kind: 'tunnel.update';
      tunnelId: number;
      runConnector: boolean;
      defaultTunnelId: number | null;
      expect: { runConnector: boolean; defaultTunnelId: number | null };
    };
