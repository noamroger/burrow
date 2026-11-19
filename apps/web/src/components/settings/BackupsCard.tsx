/** Settings › Backups: schedule, retention, destination (folder or S3/R2), files. */
import { useId, useState, type FormEvent } from 'react';
import type { BackupSettingsInput, BackupStatus } from '@burrow/shared';
import { backupsApi } from '../../api/endpoints';
import { useBackups, useRunBackup, useSaveBackups } from '../../api/queries';
import { useNow } from '../../hooks/useNow';
import { t } from '../../i18n';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, formatRelative } from '../../lib/format';
import { Icon } from '../Icon';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { Checkbox, Field, Input, Select } from '../ui/Field';
import { PageSpinner } from '../ui/Spinner';
import { Switch } from '../ui/Switch';
import { useToast } from '../ui/Toast';

const INTERVALS = [6, 12, 24, 48, 168];

interface FormState {
  enabled: boolean;
  intervalHours: number;
  retention: string;
  destination: 'local' | 's3';
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

function toForm(status: BackupStatus): FormState {
  const { settings } = status;
  return {
    enabled: settings.enabled,
    intervalHours: settings.intervalHours,
    retention: String(settings.retention),
    destination: settings.destination,
    endpoint: settings.s3?.endpoint ?? '',
    region: settings.s3?.region ?? 'auto',
    bucket: settings.s3?.bucket ?? '',
    prefix: settings.s3?.prefix ?? 'burrow/',
    accessKeyId: settings.s3?.accessKeyId ?? '',
    secretAccessKey: '',
    forcePathStyle: settings.s3?.forcePathStyle ?? true,
  };
}

function toInput(form: FormState): BackupSettingsInput {
  const hasS3 = form.destination === 's3' || form.endpoint.trim() !== '';
  return {
    enabled: form.enabled,
    intervalHours: form.intervalHours,
    retention: Math.max(1, Number.parseInt(form.retention, 10) || 1),
    destination: form.destination,
    s3: hasS3
      ? {
          endpoint: form.endpoint.trim(),
          region: form.region.trim() || 'auto',
          bucket: form.bucket.trim(),
          prefix: form.prefix.trim(),
          accessKeyId: form.accessKeyId.trim(),
          ...(form.secretAccessKey ? { secretAccessKey: form.secretAccessKey } : {}),
          forcePathStyle: form.forcePathStyle,
        }
      : null,
  };
}

function intervalLabel(hours: number): string {
  if (hours === 24) return t('backups.daily');
  if (hours === 168) return t('backups.weekly');
  return t('backups.everyHours', { count: hours });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function BackupsCard() {
  const backups = useBackups();
  return (
    <Card>
      <CardHeader title={t('backups.title')} description={t('backups.hint')} />
      <CardBody className="space-y-5">
        {backups.data ? (
          // Remount when the saved settings change so the form starts from them.
          <BackupsForm key={JSON.stringify(backups.data.settings)} status={backups.data} />
        ) : backups.isError ? (
          <Alert tone="danger">{errorMessage(backups.error)}</Alert>
        ) : (
          <PageSpinner />
        )}
      </CardBody>
    </Card>
  );
}

function BackupsForm({ status }: { status: BackupStatus }) {
  const uid = useId();
  const save = useSaveBackups();
  const run = useRunBackup();
  const toast = useToast();
  const now = useNow(60_000);
  const [form, setForm] = useState<FormState>(() => toForm(status));
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const intervals = INTERVALS.includes(form.intervalHours)
    ? INTERVALS
    : [...INTERVALS, form.intervalHours].sort((a, b) => a - b);
  const hasSecret = status.settings.s3?.hasSecret ?? false;
  const last = status.lastRun;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const saved = await save.mutateAsync(toInput(form)).catch(() => null);
    if (saved) toast.show(t('backups.saved'), 'success');
  }

  async function backupNow() {
    try {
      const result = await run.mutateAsync();
      toast.show(
        result.ok
          ? t('backups.done', { name: result.name ?? '' })
          : t('backups.failed', { error: result.error ?? '' }),
        result.ok ? 'success' : 'danger',
      );
    } catch (error) {
      toast.show(errorMessage(error), 'danger');
    }
  }

  return (
    <>
      <form onSubmit={submit} className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-medium">{t('backups.enabled')}</p>
          <Switch
            checked={form.enabled}
            label={t('backups.enabled')}
            onChange={(enabled) => set('enabled', enabled)}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${uid}-interval`} label={t('backups.interval')}>
            <Select
              id={`${uid}-interval`}
              value={form.intervalHours}
              onChange={(e) => set('intervalHours', Number(e.target.value))}
            >
              {intervals.map((h) => (
                <option key={h} value={h}>
                  {intervalLabel(h)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            id={`${uid}-retention`}
            label={t('backups.retention')}
            hint={t('backups.retentionHint')}
            aside={t('backups.retentionUnit')}
          >
            <Input
              id={`${uid}-retention`}
              type="number"
              min={1}
              max={365}
              inputMode="numeric"
              value={form.retention}
              onChange={(e) => set('retention', e.target.value)}
            />
          </Field>
        </div>

        <Field
          id={`${uid}-destination`}
          label={t('backups.destination')}
          hint={
            form.destination === 'local'
              ? t('backups.localHint', { dir: status.localDir })
              : undefined
          }
        >
          <Select
            id={`${uid}-destination`}
            value={form.destination}
            onChange={(e) => set('destination', e.target.value as FormState['destination'])}
          >
            <option value="local">{t('backups.local')}</option>
            <option value="s3">{t('backups.s3')}</option>
          </Select>
        </Field>

        {form.destination === 's3' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id={`${uid}-endpoint`}
              label={t('backups.endpoint')}
              hint={t('backups.endpointHint')}
              className="sm:col-span-2"
            >
              <Input
                id={`${uid}-endpoint`}
                type="url"
                required
                placeholder="https://"
                value={form.endpoint}
                onChange={(e) => set('endpoint', e.target.value)}
              />
            </Field>
            <Field id={`${uid}-bucket`} label={t('backups.bucket')}>
              <Input
                id={`${uid}-bucket`}
                required
                value={form.bucket}
                onChange={(e) => set('bucket', e.target.value)}
              />
            </Field>
            <Field id={`${uid}-prefix`} label={t('backups.prefix')}>
              <Input
                id={`${uid}-prefix`}
                value={form.prefix}
                onChange={(e) => set('prefix', e.target.value)}
              />
            </Field>
            <Field id={`${uid}-key`} label={t('backups.accessKeyId')}>
              <Input
                id={`${uid}-key`}
                required
                autoComplete="off"
                value={form.accessKeyId}
                onChange={(e) => set('accessKeyId', e.target.value)}
              />
            </Field>
            <Field
              id={`${uid}-secret`}
              label={t('backups.secretAccessKey')}
              hint={hasSecret ? t('backups.secretSaved') : undefined}
            >
              <Input
                id={`${uid}-secret`}
                type="password"
                autoComplete="new-password"
                required={!hasSecret}
                placeholder={hasSecret ? '••••••••' : ''}
                value={form.secretAccessKey}
                onChange={(e) => set('secretAccessKey', e.target.value)}
              />
            </Field>
            <Field id={`${uid}-region`} label={t('backups.region')} hint={t('backups.regionHint')}>
              <Input
                id={`${uid}-region`}
                value={form.region}
                onChange={(e) => set('region', e.target.value)}
              />
            </Field>
            <Checkbox
              id={`${uid}-path`}
              className="self-center"
              label={t('backups.pathStyle')}
              description={t('backups.pathStyleHint')}
              checked={form.forcePathStyle}
              onChange={(e) => set('forcePathStyle', e.target.checked)}
            />
          </div>
        ) : null}

        {save.isError ? <Alert tone="danger">{errorMessage(save.error)}</Alert> : null}
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending}>
            {t('backups.save')}
          </Button>
        </div>
      </form>

      <div className="space-y-3 border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className={last && !last.ok ? 'text-sm text-danger' : 'text-sm text-fg-muted'}>
            {last
              ? last.ok
                ? t('backups.lastOk', { when: formatRelative(last.at, now) })
                : t('backups.lastFailed', {
                    when: formatRelative(last.at, now),
                    error: last.error ?? '',
                  })
              : t('backups.never')}
            {status.nextRunAt ? (
              <span className="text-fg-muted">
                {' · '}
                {t('backups.next', { when: formatRelative(status.nextRunAt, now) })}
              </span>
            ) : null}
          </p>
          <Button
            variant="secondary"
            size="sm"
            icon="database"
            loading={run.isPending}
            onClick={() => void backupNow()}
          >
            {t('backups.runNow')}
          </Button>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">{t('backups.files')}</p>
          {status.listError ? (
            <Alert tone="danger">{t('backups.listError', { error: status.listError })}</Alert>
          ) : status.files.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('backups.empty')}</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {status.files.map((file) => (
                <li key={file.name} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs">{file.name}</p>
                    <p className="text-xs text-fg-muted" title={formatDateTime(file.createdAt)}>
                      {formatRelative(file.createdAt, now)} · {formatSize(file.size)}
                    </p>
                  </div>
                  <a
                    href={backupsApi.downloadUrl(file.name)}
                    download
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg"
                    aria-label={t('backups.download', { name: file.name })}
                    title={t('backups.download', { name: file.name })}
                  >
                    <Icon name="download" size={16} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="text-xs leading-relaxed text-fg-muted">{t('backups.restoreHint')}</p>
      </div>
    </>
  );
}
