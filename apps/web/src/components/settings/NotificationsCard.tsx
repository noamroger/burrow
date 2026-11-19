/** Settings › Notifications: Discord, ntfy and webhook channels, with a test button. */
import { useId, useState, type FormEvent } from 'react';
import {
  NOTIFICATION_EVENTS,
  type Channel,
  type ChannelInput,
  type ChannelType,
  type NotificationEvent,
} from '@burrow/shared';
import {
  useDeleteChannel,
  useNotificationChannels,
  useSaveChannel,
  useTestChannel,
} from '../../api/queries';
import { useNow } from '../../hooks/useNow';
import { t, type MessageKey } from '../../i18n';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { formatRelative } from '../../lib/format';
import { Alert } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Button, IconButton } from '../ui/Button';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Dialog } from '../ui/Dialog';
import { Checkbox, Field, Input } from '../ui/Field';
import { PageSpinner } from '../ui/Spinner';
import { Switch } from '../ui/Switch';
import { useToast } from '../ui/Toast';

const EVENT_LABEL: Record<NotificationEvent, MessageKey> = {
  'tunnel.down': 'notifications.event.tunnelDown',
  'tunnel.up': 'notifications.event.tunnelUp',
  'host.down': 'notifications.event.hostDown',
  'host.up': 'notifications.event.hostUp',
  'drift.detected': 'notifications.event.drift',
  'backup.failed': 'notifications.event.backupFailed',
};

const TYPE_LABEL: Record<ChannelType, MessageKey> = {
  discord: 'notifications.type.discord',
  ntfy: 'notifications.type.ntfy',
  webhook: 'notifications.type.webhook',
};

export function NotificationsCard() {
  const channels = useNotificationChannels();
  const [editing, setEditing] = useState<Channel | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Channel | null>(null);
  const remove = useDeleteChannel();
  const toast = useToast();

  return (
    <Card>
      <CardHeader
        title={t('notifications.title')}
        description={t('notifications.hint')}
        actions={
          <Button size="sm" icon="plus" onClick={() => setEditing('new')}>
            {t('notifications.add')}
          </Button>
        }
      />
      {channels.isError ? (
        <CardBody>
          <Alert tone="danger">{errorMessage(channels.error)}</Alert>
        </CardBody>
      ) : !channels.data ? (
        <CardBody>
          <PageSpinner />
        </CardBody>
      ) : channels.data.length === 0 ? (
        <CardBody>
          <p className="text-sm text-fg-muted">{t('notifications.empty')}</p>
        </CardBody>
      ) : (
        <ul className="divide-y divide-border">
          {channels.data.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              onEdit={() => setEditing(c)}
              onDelete={() => setDeleting(c)}
            />
          ))}
        </ul>
      )}
      {editing !== null ? (
        <ChannelDialog
          channel={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        title={t('notifications.deleteTitle', { name: deleting?.name ?? '' })}
        confirmLabel={t('notifications.delete')}
        loading={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() =>
          remove.mutate(deleting!.id, {
            onSuccess: () => setDeleting(null),
            onError: (e) => toast.show(errorMessage(e), 'danger'),
          })
        }
      />
    </Card>
  );
}

function ChannelRow({
  channel,
  onEdit,
  onDelete,
}: {
  channel: Channel;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const test = useTestChannel();
  const toast = useToast();
  const now = useNow(60_000);
  const target =
    channel.type === 'discord'
      ? channel.config.webhookHint
      : channel.type === 'ntfy'
        ? `${channel.config.serverUrl ?? ''}/${channel.config.topic ?? ''}`
        : channel.config.url;

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('font-medium', channel.enabled ? 'text-fg' : 'text-fg-muted')}>
            {channel.name}
          </span>
          <Badge tone="accent">{t(TYPE_LABEL[channel.type])}</Badge>
          {!channel.enabled ? <Badge>{t('notifications.paused')}</Badge> : null}
        </div>
        <p className="mt-0.5 truncate text-xs text-fg-muted">
          {target ? <span className="font-mono">{target}</span> : null}
          {target ? ' · ' : null}
          {channel.events.map((e) => t(EVENT_LABEL[e])).join(', ')}
        </p>
        {channel.lastSentAt ? (
          <p className={cn('mt-0.5 text-xs', channel.lastError ? 'text-danger' : 'text-fg-muted')}>
            {channel.lastError
              ? t('notifications.lastFailed', {
                  when: formatRelative(channel.lastSentAt, now),
                  error: channel.lastError,
                })
              : t('notifications.lastOk', { when: formatRelative(channel.lastSentAt, now) })}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="secondary"
          icon="bell"
          loading={test.isPending}
          onClick={() =>
            test.mutate(channel.id, {
              onSuccess: (r) =>
                toast.show(
                  r.ok
                    ? t('notifications.testOk', { name: channel.name })
                    : t('notifications.testFailed', { error: r.error ?? '' }),
                  r.ok ? 'success' : 'danger',
                ),
              onError: (e) => toast.show(errorMessage(e), 'danger'),
            })
          }
        >
          {t('notifications.test')}
        </Button>
        <IconButton
          icon="pencil"
          size="sm"
          label={t('notifications.edit', { name: channel.name })}
          onClick={onEdit}
        />
        <IconButton
          icon="trash"
          size="sm"
          label={t('notifications.deleteLabel', { name: channel.name })}
          onClick={onDelete}
        />
      </div>
    </li>
  );
}

interface FormState {
  type: ChannelType;
  name: string;
  enabled: boolean;
  events: NotificationEvent[];
  webhookUrl: string;
  serverUrl: string;
  topic: string;
  token: string;
  url: string;
  secret: string;
}

function toForm(c: Channel | null): FormState {
  return {
    type: c?.type ?? 'discord',
    name: c?.name ?? '',
    enabled: c?.enabled ?? true,
    events: c?.events ?? ['tunnel.down', 'tunnel.up', 'host.down', 'host.up', 'drift.detected'],
    webhookUrl: '',
    serverUrl: c?.config.serverUrl ?? 'https://ntfy.sh',
    topic: c?.config.topic ?? '',
    token: '',
    url: c?.config.url ?? '',
    secret: '',
  };
}

function toInput(f: FormState): ChannelInput {
  const base = { name: f.name.trim(), enabled: f.enabled, events: f.events };
  if (f.type === 'discord') {
    return {
      ...base,
      type: 'discord',
      config: f.webhookUrl.trim() ? { webhookUrl: f.webhookUrl.trim() } : {},
    };
  }
  if (f.type === 'ntfy') {
    return {
      ...base,
      type: 'ntfy',
      config: {
        serverUrl: f.serverUrl.trim() || 'https://ntfy.sh',
        topic: f.topic.trim(),
        ...(f.token.trim() ? { token: f.token.trim() } : {}),
      },
    };
  }
  return {
    ...base,
    type: 'webhook',
    config: { url: f.url.trim(), ...(f.secret ? { secret: f.secret } : {}) },
  };
}

function ChannelDialog({ channel, onClose }: { channel: Channel | null; onClose: () => void }) {
  const uid = useId();
  const save = useSaveChannel();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(() => toForm(channel));
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  // A saved secret only counts for the type it was saved with.
  const hasSecret = channel !== null && channel.type === form.type && channel.config.hasSecret;
  const formId = `${uid}-form`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const saved = await save
      .mutateAsync({ id: channel?.id ?? null, input: toInput(form) })
      .catch(() => null);
    if (saved) {
      toast.show(t('notifications.saved', { name: saved.name }), 'success');
      onClose();
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      busy={save.isPending}
      title={channel ? t('notifications.editTitle') : t('notifications.addTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={save.isPending}>
            {t('notifications.save')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-4">
        {save.isError ? <Alert tone="danger">{errorMessage(save.error)}</Alert> : null}
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-fg">{t('notifications.type')}</legend>
          <div className="grid grid-cols-3 gap-2">
            {(['discord', 'ntfy', 'webhook'] as const).map((type) => (
              <label
                key={type}
                className={cn(
                  'flex cursor-pointer items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                  'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
                  form.type === type
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-border text-fg-muted hover:text-fg',
                )}
              >
                <input
                  type="radio"
                  name={`${uid}-type`}
                  value={type}
                  checked={form.type === type}
                  onChange={() => set('type', type)}
                  className="sr-only"
                />
                {t(TYPE_LABEL[type])}
              </label>
            ))}
          </div>
        </fieldset>

        <Field id={`${uid}-name`} label={t('notifications.name')}>
          <Input
            id={`${uid}-name`}
            value={form.name}
            maxLength={64}
            required
            placeholder={t(TYPE_LABEL[form.type])}
            onChange={(e) => set('name', e.target.value)}
          />
        </Field>

        {form.type === 'discord' ? (
          <Field
            id={`${uid}-discord`}
            label={t('notifications.discordUrl')}
            hint={hasSecret ? t('notifications.secretSaved') : t('notifications.discordHint')}
          >
            <Input
              id={`${uid}-discord`}
              type="url"
              value={form.webhookUrl}
              required={!hasSecret}
              autoComplete="off"
              placeholder="https://discord.com/api/webhooks/…"
              onChange={(e) => set('webhookUrl', e.target.value)}
            />
          </Field>
        ) : form.type === 'ntfy' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`${uid}-server`} label={t('notifications.ntfyServer')}>
                <Input
                  id={`${uid}-server`}
                  type="url"
                  value={form.serverUrl}
                  required
                  onChange={(e) => set('serverUrl', e.target.value)}
                />
              </Field>
              <Field
                id={`${uid}-topic`}
                label={t('notifications.ntfyTopic')}
                hint={t('notifications.ntfyTopicHint')}
              >
                <Input
                  id={`${uid}-topic`}
                  value={form.topic}
                  required
                  pattern="[A-Za-z0-9_\-]{1,64}"
                  placeholder="burrow-alerts"
                  onChange={(e) => set('topic', e.target.value)}
                />
              </Field>
            </div>
            <Field
              id={`${uid}-token`}
              label={t('notifications.ntfyToken')}
              aside={t('common.optional')}
              hint={hasSecret ? t('notifications.secretSaved') : t('notifications.ntfyTokenHint')}
            >
              <Input
                id={`${uid}-token`}
                type="password"
                value={form.token}
                autoComplete="off"
                placeholder="tk_…"
                onChange={(e) => set('token', e.target.value)}
              />
            </Field>
          </>
        ) : (
          <>
            <Field id={`${uid}-url`} label={t('notifications.webhookUrl')}>
              <Input
                id={`${uid}-url`}
                type="url"
                value={form.url}
                required
                placeholder="https://example.com/hooks/burrow"
                onChange={(e) => set('url', e.target.value)}
              />
            </Field>
            <Field
              id={`${uid}-secret`}
              label={t('notifications.webhookSecret')}
              aside={t('common.optional')}
              hint={
                hasSecret ? t('notifications.secretSaved') : t('notifications.webhookSecretHint')
              }
            >
              <Input
                id={`${uid}-secret`}
                type="password"
                value={form.secret}
                autoComplete="off"
                onChange={(e) => set('secret', e.target.value)}
              />
            </Field>
          </>
        )}

        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-sm font-medium text-fg">
            {t('notifications.events')}
          </legend>
          {NOTIFICATION_EVENTS.map((e) => (
            <Checkbox
              key={e}
              id={`${uid}-${e}`}
              label={t(EVENT_LABEL[e])}
              checked={form.events.includes(e)}
              onChange={(ev) =>
                set(
                  'events',
                  ev.target.checked
                    ? NOTIFICATION_EVENTS.filter((x) => x === e || form.events.includes(x))
                    : form.events.filter((x) => x !== e),
                )
              }
            />
          ))}
        </fieldset>

        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-medium">{t('notifications.enabled')}</p>
          <Switch
            checked={form.enabled}
            label={t('notifications.enabled')}
            onChange={(v) => set('enabled', v)}
          />
        </div>
      </form>
    </Dialog>
  );
}
