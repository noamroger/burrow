/** Settings › API tokens: create, list and revoke personal tokens for scripts. */
import { useId, useState, type FormEvent } from 'react';
import type { CreatedApiToken } from '@burrow/shared';
import { docsUrl } from '../../api/endpoints';
import { useApiTokens, useCreateApiToken, useDeleteApiToken } from '../../api/queries';
import { useNow } from '../../hooks/useNow';
import { t } from '../../i18n';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, formatRelative } from '../../lib/format';
import { Icon } from '../Icon';
import { Alert } from '../ui/Alert';
import { Button, IconButton } from '../ui/Button';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Field, Input } from '../ui/Field';
import { PageSpinner } from '../ui/Spinner';
import { useToast } from '../ui/Toast';

export function ApiTokensCard() {
  const uid = useId();
  const tokens = useApiTokens();
  const create = useCreateApiToken();
  const remove = useDeleteApiToken();
  const toast = useToast();
  const now = useNow(60_000);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [revoking, setRevoking] = useState<{ id: number; name: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    const token = await create.mutateAsync(name.trim()).catch(() => null);
    if (token) {
      setCreated(token);
      setName('');
    }
  }

  return (
    <Card>
      <CardHeader
        title={t('apiTokens.title')}
        description={t('apiTokens.hint')}
        actions={
          <a
            href={docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
          >
            <Icon name="book" size={14} />
            {t('apiTokens.docs')}
            <span className="sr-only">{t('common.opensNewTab')}</span>
          </a>
        }
      />
      <CardBody className="space-y-4">
        {created ? (
          <Alert tone="success" title={t('apiTokens.createdTitle', { name: created.name })}>
            <p className="mb-2">{t('apiTokens.createdBody')}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 rounded bg-surface-2 px-2 py-1.5 font-mono text-xs break-all text-fg">
                {created.token}
              </code>
              <IconButton
                icon="check"
                size="sm"
                label={t('apiTokens.copy')}
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(created.token)
                    .then(() => toast.show(t('apiTokens.copied'), 'info'))
                }
              />
            </div>
          </Alert>
        ) : null}
        {create.isError ? <Alert tone="danger">{errorMessage(create.error)}</Alert> : null}

        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <Field id={`${uid}-name`} label={t('apiTokens.name')} className="min-w-48 flex-1">
            <Input
              id={`${uid}-name`}
              value={name}
              maxLength={64}
              placeholder={t('apiTokens.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Button type="submit" icon="key" loading={create.isPending} disabled={!name.trim()}>
            {t('apiTokens.create')}
          </Button>
        </form>

        {tokens.isPending ? (
          <PageSpinner />
        ) : tokens.isError ? (
          <Alert tone="danger">{errorMessage(tokens.error)}</Alert>
        ) : tokens.data.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('apiTokens.none')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {tokens.data.map((token) => (
              <li key={token.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{token.name}</p>
                  <p className="text-xs text-fg-muted">
                    <code className="font-mono">{token.hint}…</code> ·{' '}
                    <span title={formatDateTime(token.createdAt)}>
                      {t('apiTokens.created', { when: formatRelative(token.createdAt, now) })}
                    </span>{' '}
                    ·{' '}
                    {token.lastUsedAt
                      ? t('apiTokens.lastUsed', { when: formatRelative(token.lastUsedAt, now) })
                      : t('apiTokens.neverUsed')}
                  </p>
                </div>
                <IconButton
                  icon="trash"
                  size="sm"
                  label={t('apiTokens.revoke', { name: token.name })}
                  className="hover:text-danger"
                  onClick={() => setRevoking({ id: token.id, name: token.name })}
                />
              </li>
            ))}
          </ul>
        )}
      </CardBody>

      <ConfirmDialog
        open={revoking !== null}
        title={t('apiTokens.revokeTitle', { name: revoking?.name ?? '' })}
        description={t('apiTokens.revokeBody')}
        confirmLabel={t('apiTokens.revokeConfirm')}
        loading={remove.isPending}
        onCancel={() => setRevoking(null)}
        onConfirm={() =>
          revoking &&
          remove.mutate(revoking.id, {
            onSuccess: () => {
              setRevoking(null);
              if (created?.id === revoking.id) setCreated(null);
            },
            onError: (error) => toast.show(errorMessage(error), 'danger'),
          })
        }
      />
    </Card>
  );
}
