/**
 * Paste-and-verify form for the Cloudflare API token.
 *
 * PUT /api/cloudflare/token verifies the token before saving it. When the
 * token can see several accounts, the server answers with `availableAccounts`
 * (in the response, or in the error details) and we ask the user to pick one,
 * then submit again with `accountId`.
 */
import { useId, useState, type FormEvent } from 'react';
import {
  cloudflareSettingsSchema,
  permissionCheckSchema,
  saveTokenSchema,
  type CloudflareSettings,
  type PermissionCheck,
} from '@burrow/shared';
import { z } from 'zod';
import { isApiError } from '../api/client';
import { useSaveToken } from '../api/queries';
import { t } from '../i18n';
import { errorMessage } from '../lib/errors';
import { PermissionChecks } from './TokenPermissions';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { describedBy, Field, Input, Select } from './ui/Field';

type Account = CloudflareSettings['availableAccounts'][number];

const errorDetailsSchema = z
  .object({
    permissions: z.array(permissionCheckSchema).optional(),
    availableAccounts: cloudflareSettingsSchema.shape.availableAccounts.optional(),
  })
  .passthrough();

export interface TokenFormProps {
  onSaved: (settings: CloudflareSettings) => void;
  onCancel?: () => void;
  submitLabel?: string;
}

export function TokenForm({ onSaved, onCancel, submitLabel }: TokenFormProps) {
  const uid = useId();
  const save = useSaveToken();
  const [token, setToken] = useState('');
  const [reveal, setReveal] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [checks, setChecks] = useState<PermissionCheck[]>([]);
  const [fieldError, setFieldError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = saveTokenSchema.safeParse({ token, accountId: accountId || undefined });
    if (!parsed.success) {
      setFieldError(t('token.invalidFormat'));
      return;
    }
    setFieldError(null);
    try {
      const settings = await save.mutateAsync(parsed.data);
      setChecks(settings.permissions);
      if (!settings.configured && settings.availableAccounts.length > 1 && !settings.account) {
        setAccounts(settings.availableAccounts);
        setAccountId((id) => id || settings.availableAccounts[0]!.id);
        return;
      }
      if (settings.configured) onSaved(settings);
    } catch (error) {
      if (isApiError(error)) {
        const details = errorDetailsSchema.safeParse(error.details);
        if (details.success) {
          if (details.data.permissions) setChecks(details.data.permissions);
          const available = details.data.availableAccounts;
          if (available && available.length > 1) {
            setAccounts(available);
            setAccountId((id) => id || available[0]!.id);
          }
        }
      }
    }
  }

  const needsAccount = accounts.length > 1;
  const failed = checks.some((c) => !c.ok);

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <Field id={`${uid}-token`} label={t('token.label')} hint={t('token.hint')} error={fieldError}>
        <div className="flex gap-2">
          <Input
            id={`${uid}-token`}
            type={reveal ? 'text' : 'password'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t('token.placeholder')}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            aria-invalid={!!fieldError}
            aria-describedby={describedBy(`${uid}-token`, { hint: true, error: fieldError })}
          />
          <Button
            variant="secondary"
            icon="eye"
            onClick={() => setReveal((r) => !r)}
            aria-pressed={reveal}
          >
            <span className="sr-only sm:not-sr-only">
              {reveal ? t('token.hide') : t('token.show')}
            </span>
          </Button>
        </div>
      </Field>

      {needsAccount ? (
        <Field id={`${uid}-account`} label={t('token.account')} hint={t('token.accountHint')}>
          <Select
            id={`${uid}-account`}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.id.slice(0, 8)}…)
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      {save.isError ? (
        <Alert tone="danger" title={t('token.verifyFailed')}>
          {errorMessage(save.error)}
        </Alert>
      ) : null}

      {checks.length > 0 ? (
        <div className="rounded-lg border border-border bg-surface-2/60 p-3.5">
          <p className="mb-2 text-sm font-medium text-fg">{t('token.checksTitle')}</p>
          <PermissionChecks checks={checks} />
          {failed ? <p className="mt-2 text-xs text-fg-muted">{t('token.checksFix')}</p> : null}
        </div>
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel} disabled={save.isPending}>
            {t('common.cancel')}
          </Button>
        ) : null}
        <Button type="submit" icon="shield" loading={save.isPending}>
          {needsAccount ? t('token.useAccount') : (submitLabel ?? t('token.verify'))}
        </Button>
      </div>
    </form>
  );
}
