/**
 * Pure helpers that turn a container's `burrow.*` labels into a host
 * description. No I/O: unit tested in test/docker.test.ts.
 *
 * | Label                        | Meaning                                                   |
 * |------------------------------|-----------------------------------------------------------|
 * | `burrow.host`                | Public hostname (required), e.g. `app.example.com`        |
 * | `burrow.port`                | Container port (default: template port, single exposed port, else 80) |
 * | `burrow.scheme`              | `http` (default), `https`, `ssh`, `rdp`, `tcp`            |
 * | `burrow.service`             | Full origin URL, overrides address/scheme/port            |
 * | `burrow.address`             | Host or IP to reach the container (default: automatic)   |
 * | `burrow.path`                | Path regex, e.g. `^/api`                                  |
 * | `burrow.tunnel`              | Tunnel name (default tunnel otherwise)                    |
 * | `burrow.template`            | Template id (`jellyfin`, `proxmox`…): port, scheme, options |
 * | `burrow.no-tls-verify`       | `true` to accept self-signed certificates                 |
 * | `burrow.http-host-header`    | Host header sent to the origin                            |
 * | `burrow.origin-server-name`  | TLS server name expected from the origin                  |
 * | `burrow.access`              | Comma-separated emails and email domains: turns on Access |
 * | `burrow.access.session`      | Access session length (`30m`, `6h`, `24h`…)               |
 * | `burrow.enable`              | `false` to ignore the container                           |
 */
import { findTemplate, type ServiceTemplate } from '@burrow/shared';
import type { DockerContainer } from './client.js';

export const LABEL_PREFIX = 'burrow.';

/** What the labels of one container ask for. */
export interface LabelSpec {
  hostname: string;
  path: string;
  service: string;
  tunnel: string | null;
  template: string | null;
  noTLSVerify: boolean;
  httpHostHeader: string;
  originServerName: string;
  access: { enabled: boolean; emails: string[]; emailDomains: string[]; sessionDuration: string };
}

export type LabelResult =
  | { kind: 'none' }
  | { kind: 'ignored'; reason: string }
  | { kind: 'error'; hostname: string | null; path: string; message: string }
  | { kind: 'ok'; spec: LabelSpec };

/** `/my-app` → `my-app`. */
export function containerName(c: DockerContainer): string {
  return (c.Names[0] ?? c.Id.slice(0, 12)).replace(/^\//, '');
}

const truthy = (v: string | undefined) => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());
const falsy = (v: string | undefined) => v !== undefined && /^(0|false|no|off)$/i.test(v.trim());

/** Networks Docker creates without DNS for container names. */
const NO_DNS_NETWORKS = new Set(['bridge']);

/**
 * How Burrow reaches the container. With `burrow.address`, that. Otherwise,
 * through a network both containers are on: by name on user-defined networks
 * (Docker DNS), by IP on the default bridge. When Burrow does not know its own
 * networks (not running in Docker), the container's first IP is used.
 */
export function containerAddress(
  c: DockerContainer,
  selfNetworks: Set<string> | null,
): { address: string } | { error: string } {
  const networks = Object.entries(c.NetworkSettings?.Networks ?? {});
  const mode = c.HostConfig?.NetworkMode ?? '';
  if (mode === 'host' || networks.some(([name]) => name === 'host')) {
    return {
      error:
        'The container uses the host network: set burrow.address (the host IP) or burrow.service.',
    };
  }
  const name = containerName(c);
  if (selfNetworks) {
    const shared = networks.filter(([n]) => selfNetworks.has(n));
    const named = shared.find(([n]) => !NO_DNS_NETWORKS.has(n));
    if (named) return { address: name };
    const ip = shared.map(([, v]) => v?.IPAddress).find(Boolean);
    if (ip) return { address: ip };
    return {
      error:
        'Burrow is not on any network of this container: attach both to the same Docker network, or set burrow.address.',
    };
  }
  const ip = networks.map(([, v]) => v?.IPAddress).find(Boolean);
  if (ip) return { address: ip };
  return { error: 'The container has no IP address (is it running?). Set burrow.address.' };
}

function defaultPort(c: DockerContainer, template: ServiceTemplate | undefined): number {
  if (template) return template.port;
  const tcp = [
    ...new Set((c.Ports ?? []).filter((p) => p.Type === 'tcp').map((p) => p.PrivatePort)),
  ];
  return tcp.length === 1 ? tcp[0]! : 80;
}

const splitList = (v: string | undefined) =>
  (v ?? '')
    .split(/[\s,;]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

/** Read the `burrow.*` labels of a container. */
export function parseLabels(c: DockerContainer, selfNetworks: Set<string> | null): LabelResult {
  const labels = c.Labels ?? {};
  const get = (key: string) => {
    const v = labels[LABEL_PREFIX + key];
    return v === undefined ? undefined : v.trim();
  };
  const rawHost = get('host');
  if (!rawHost) return { kind: 'none' };
  if (falsy(get('enable'))) return { kind: 'ignored', reason: 'burrow.enable is false' };

  const hostname = rawHost
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  const path = get('path') ?? '';
  const fail = (message: string): LabelResult => ({ kind: 'error', hostname, path, message });

  const templateId = get('template');
  const template = templateId ? findTemplate(templateId) : undefined;
  if (templateId && !template) return fail(`Unknown template "${templateId}".`);

  let service = get('service');
  if (!service) {
    const scheme = (get('scheme') ?? template?.scheme ?? 'http').toLowerCase();
    const portLabel = get('port');
    const port = portLabel ? Number(portLabel) : defaultPort(c, template);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return fail(`burrow.port must be a port number (got "${portLabel}").`);
    }
    let address = get('address');
    if (!address) {
      const found = containerAddress(c, selfNetworks);
      if ('error' in found) return fail(found.error);
      address = found.address;
    }
    service = `${scheme}://${address}:${port}`;
  }

  const access = splitList(get('access'));
  return {
    kind: 'ok',
    spec: {
      hostname,
      path,
      service,
      tunnel: get('tunnel') || null,
      template: template?.id ?? null,
      noTLSVerify:
        get('no-tls-verify') !== undefined
          ? truthy(get('no-tls-verify'))
          : (template?.options.noTLSVerify ?? false),
      httpHostHeader: get('http-host-header') ?? template?.options.httpHostHeader ?? '',
      originServerName: get('origin-server-name') ?? template?.options.originServerName ?? '',
      access: {
        enabled: access.length > 0,
        emails: access.filter((x) => x.includes('@') && !x.startsWith('@')),
        emailDomains: access.filter((x) => !x.includes('@') || x.startsWith('@')),
        sessionDuration: get('access.session') ?? '24h',
      },
    },
  };
}
