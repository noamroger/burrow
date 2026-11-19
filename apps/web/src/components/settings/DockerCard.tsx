/** Settings › Docker discovery: containers with `burrow.*` labels publish themselves. */
import type { DockerContainerInfo } from '@burrow/shared';
import { useDocker, useDockerScan, useDockerSettings } from '../../api/queries';
import { useNow } from '../../hooks/useNow';
import { t } from '../../i18n';
import { errorMessage } from '../../lib/errors';
import { formatRelative } from '../../lib/format';
import { Alert } from '../ui/Alert';
import { Badge, type Tone } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { Switch } from '../ui/Switch';
import { useToast } from '../ui/Toast';

const STATUS_TONE: Record<DockerContainerInfo['status'], Tone> = {
  published: 'success',
  pending: 'neutral',
  error: 'danger',
  ignored: 'neutral',
};

const EXAMPLE = `services:
  jellyfin:
    image: jellyfin/jellyfin
    networks: [proxy]
    labels:
      burrow.host: jellyfin.example.com
      burrow.template: jellyfin   # port 8096, options
      # burrow.port: 8096
      # burrow.access: me@example.com, family.example`;

export function DockerCard() {
  const docker = useDocker();
  const scan = useDockerScan();
  const settings = useDockerSettings();
  const toast = useToast();
  const now = useNow();
  const status = docker.data;
  const onError = (error: unknown) => toast.show(errorMessage(error), 'danger');

  return (
    <Card>
      <CardHeader title={t('docker.title')} description={t('docker.description')} />
      <CardBody className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">{t('docker.enable')}</p>
            <p className="text-xs text-fg-muted">
              {t('docker.enableHint', { endpoint: status?.endpoint ?? '…' })}
            </p>
          </div>
          <Switch
            checked={status?.enabled ?? false}
            label={t('docker.enable')}
            disabled={!status || settings.isPending}
            onChange={(enabled) => settings.mutate(enabled, { onError })}
          />
        </div>

        {status?.enabled && status.error ? (
          <Alert tone="danger" title={t('docker.unreachable')}>
            {status.error}
          </Alert>
        ) : null}

        {status?.enabled && status.reachable ? (
          status.containers.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('docker.none')}</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {status.containers.map((c) => (
                <li key={c.id + c.hostname} className="space-y-1 px-3.5 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-medium">
                      {c.hostname ?? '—'}
                      <span className="ml-2 text-xs font-normal text-fg-muted">
                        {t('docker.fromContainer', { name: c.name })}
                      </span>
                    </span>
                    <Badge tone={STATUS_TONE[c.status]} dot>
                      {t(`docker.status.${c.status}`)}
                    </Badge>
                  </div>
                  {c.service ? (
                    <code className="block truncate font-mono text-xs text-fg-muted">
                      {c.service}
                    </code>
                  ) : null}
                  {c.message ? (
                    <p
                      className={
                        c.status === 'error' ? 'text-xs text-danger' : 'text-xs text-fg-muted'
                      }
                    >
                      {c.message}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}

        <details className="group rounded-lg border border-border">
          <summary className="cursor-pointer px-3.5 py-2.5 text-sm font-medium select-none">
            {t('docker.howTo')}
          </summary>
          <div className="space-y-2 border-t border-border px-3.5 py-3 text-xs text-fg-muted">
            <p>{t('docker.howToBody')}</p>
            <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-[12px] text-fg">
              {EXAMPLE}
            </pre>
            <p>{t('docker.howToLabels')}</p>
          </div>
        </details>

        {status?.enabled ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-fg-muted">
              {status.lastScanAt
                ? t('docker.lastScan', {
                    when: formatRelative(status.lastScanAt, now),
                    seconds: status.intervalSeconds,
                  })
                : t('docker.neverScanned')}
            </p>
            <Button
              variant="secondary"
              size="sm"
              icon="sync"
              loading={scan.isPending}
              onClick={() => scan.mutate(undefined, { onError })}
            >
              {t('docker.scanNow')}
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
