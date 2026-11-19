/**
 * Settings › Two-factor authentication: authenticator app (TOTP), passkeys and
 * recovery codes. Always optional; the card only recommends it.
 */
import { useId, useState, type FormEvent } from 'react';
import type { Passkey, TotpSetup } from '@burrow/shared';
import { isApiError } from '../../api/client';
import { twoFactorApi } from '../../api/endpoints';
import {
  useAddPasskey,
  useDisableTotp,
  useEnableTotp,
  useRegenerateCodes,
  useRemovePasskey,
  useRenamePasskey,
  useStartTotp,
  useTwoFactor,
} from '../../api/queries';
import { useNow } from '../../hooks/useNow';
import { t } from '../../i18n';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, formatRelative } from '../../lib/format';
import {
  createPasskey,
  isPasskeyCancelled,
  passkeyErrorMessage,
  passkeySupport,
} from '../../lib/passkeys';
import { Icon } from '../Icon';
import { Alert } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Button, IconButton } from '../ui/Button';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { Dialog } from '../ui/Dialog';
import { describedBy, Field, Input } from '../ui/Field';
import { PageSpinner } from '../ui/Spinner';
import { useToast } from '../ui/Toast';

export function SecurityCard() {
  const status = useTwoFactor();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [totpSetup, setTotpSetup] = useState<TotpSetup | null>(null);
  const startTotp = useStartTotp();
  const [confirm, setConfirm] = useState<'totp-off' | 'codes' | { passkey: Passkey } | null>(null);
  const disableTotp = useDisableTotp();
  const regenerate = useRegenerateCodes();
  const removePasskey = useRemovePasskey();
  const toast = useToast();

  const data = status.data;
  return (
    <Card>
      <CardHeader
        title={t('security.title')}
        description={t('security.hint')}
        actions={
          data ? (
            <Badge tone={data.enabled ? 'success' : 'neutral'} dot>
              {data.enabled ? t('security.on') : t('security.off')}
            </Badge>
          ) : null
        }
      />
      <CardBody className="space-y-6">
        {status.isPending ? (
          <PageSpinner />
        ) : status.isError ? (
          <Alert tone="danger">{errorMessage(status.error)}</Alert>
        ) : (
          <>
            {!data!.enabled ? (
              <Alert tone="info" title={t('security.recommendTitle')}>
                {t('security.recommendBody')}
              </Alert>
            ) : null}

            <section aria-labelledby="security-totp" className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 id="security-totp" className="flex items-center gap-2 text-sm font-semibold">
                    {t('security.totp')}
                    {data!.totpEnabled ? (
                      <Badge tone="success">{t('security.active')}</Badge>
                    ) : null}
                  </h3>
                  <p className="text-sm text-fg-muted">{t('security.totpHint')}</p>
                </div>
                {data!.totpEnabled ? (
                  <Button variant="secondary" size="sm" onClick={() => setConfirm('totp-off')}>
                    {t('security.turnOff')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    icon="shield"
                    loading={startTotp.isPending}
                    onClick={() =>
                      startTotp.mutate(undefined, {
                        onSuccess: setTotpSetup,
                        onError: (err) => toast.show(errorMessage(err), 'danger'),
                      })
                    }
                  >
                    {t('security.setUp')}
                  </Button>
                )}
              </div>
            </section>

            <PasskeysSection
              passkeys={data!.passkeys}
              onCodes={setCodes}
              onRemove={(passkey) => setConfirm({ passkey })}
            />

            {data!.enabled ? (
              <section
                aria-labelledby="security-recovery"
                className="flex flex-wrap items-start justify-between gap-3"
              >
                <div className="min-w-0">
                  <h3 id="security-recovery" className="text-sm font-semibold">
                    {t('security.recovery')}
                  </h3>
                  <p
                    className={
                      data!.recoveryCodesLeft <= 3
                        ? 'text-sm text-warning'
                        : 'text-sm text-fg-muted'
                    }
                  >
                    {t('security.recoveryLeft', { count: data!.recoveryCodesLeft })}
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => setConfirm('codes')}>
                  {t('security.newCodes')}
                </Button>
              </section>
            ) : null}
          </>
        )}
      </CardBody>

      {totpSetup ? (
        <TotpSetupDialog
          setup={totpSetup}
          onClose={() => setTotpSetup(null)}
          onEnabled={(recovery) => {
            setTotpSetup(null);
            toast.show(t('security.totpEnabled'));
            if (recovery.length > 0) setCodes(recovery);
          }}
        />
      ) : null}

      <PasswordConfirmDialog
        open={confirm !== null}
        title={
          confirm === 'totp-off'
            ? t('security.turnOffTitle')
            : confirm === 'codes'
              ? t('security.newCodesTitle')
              : t('security.removePasskeyTitle', {
                  name: confirm && typeof confirm === 'object' ? confirm.passkey.name : '',
                })
        }
        description={
          confirm === 'totp-off'
            ? t('security.turnOffBody')
            : confirm === 'codes'
              ? t('security.newCodesBody')
              : t('security.removePasskeyBody')
        }
        confirmLabel={
          confirm === 'totp-off'
            ? t('security.turnOff')
            : confirm === 'codes'
              ? t('security.newCodes')
              : t('security.removePasskey')
        }
        tone={confirm === 'codes' ? 'primary' : 'danger'}
        onCancel={() => setConfirm(null)}
        onConfirm={async (password) => {
          if (confirm === 'totp-off') {
            await disableTotp.mutateAsync(password);
            toast.show(t('security.totpDisabled'), 'info');
          } else if (confirm === 'codes') {
            const res = await regenerate.mutateAsync(password);
            setCodes(res.recoveryCodes);
          } else if (confirm) {
            await removePasskey.mutateAsync({ id: confirm.passkey.id, password });
            toast.show(t('security.passkeyRemoved'), 'info');
          }
          setConfirm(null);
        }}
      />

      <RecoveryCodesDialog codes={codes} onClose={() => setCodes(null)} />
    </Card>
  );
}

function PasskeysSection({
  passkeys,
  onCodes,
  onRemove,
}: {
  passkeys: Passkey[];
  onCodes: (codes: string[]) => void;
  onRemove: (passkey: Passkey) => void;
}) {
  const uid = useId();
  const support = passkeySupport();
  const add = useAddPasskey();
  const rename = useRenamePasskey();
  const toast = useToast();
  const now = useNow(60_000);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Passkey | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { challengeId, options } = await twoFactorApi.passkeyOptions();
      const response = await createPasskey(options);
      const res = await add.mutateAsync({ name: name.trim(), challengeId, response });
      setName('');
      toast.show(t('security.passkeyAdded', { name: res.passkey.name }));
      if (res.recoveryCodes.length > 0) onCodes(res.recoveryCodes);
    } catch (err) {
      if (!isPasskeyCancelled(err)) {
        setError(isApiError(err) ? errorMessage(err) : passkeyErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="security-passkeys" className="space-y-3">
      <div>
        <h3 id="security-passkeys" className="text-sm font-semibold">
          {t('security.passkeys')}
        </h3>
        <p className="text-sm text-fg-muted">{t('security.passkeysHint')}</p>
      </div>

      {passkeys.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {passkeys.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <Icon name="key" size={16} className="shrink-0 text-fg-muted" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium">
                  <span className="truncate">{p.name}</span>
                  {p.backedUp ? <Badge tone="info">{t('security.synced')}</Badge> : null}
                </p>
                <p className="text-xs text-fg-muted">
                  <span title={formatDateTime(p.createdAt)}>
                    {t('apiTokens.created', { when: formatRelative(p.createdAt, now) })}
                  </span>{' '}
                  ·{' '}
                  {p.lastUsedAt
                    ? t('apiTokens.lastUsed', { when: formatRelative(p.lastUsedAt, now) })
                    : t('apiTokens.neverUsed')}
                </p>
              </div>
              <IconButton
                icon="pencil"
                size="sm"
                label={t('security.renamePasskey', { name: p.name })}
                onClick={() => setRenaming(p)}
              />
              <IconButton
                icon="trash"
                size="sm"
                label={t('security.removePasskeyNamed', { name: p.name })}
                className="hover:text-danger"
                onClick={() => onRemove(p)}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {support === 'ok' ? (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <Field id={`${uid}-name`} label={t('security.passkeyName')} className="min-w-48 flex-1">
            <Input
              id={`${uid}-name`}
              value={name}
              maxLength={64}
              placeholder={t('security.passkeyNamePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Button type="submit" icon="plus" loading={busy} disabled={!name.trim()}>
            {t('security.addPasskey')}
          </Button>
        </form>
      ) : (
        <Alert tone="warning">
          {support === 'insecure'
            ? t('security.passkeyInsecure')
            : t('security.passkeyUnsupported')}
        </Alert>
      )}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <RenameDialog
        passkey={renaming}
        loading={rename.isPending}
        onCancel={() => setRenaming(null)}
        onSave={(newName) =>
          renaming &&
          rename.mutate(
            { id: renaming.id, name: newName },
            {
              onSuccess: () => setRenaming(null),
              onError: (err) => toast.show(errorMessage(err), 'danger'),
            },
          )
        }
      />
    </section>
  );
}

function TotpSetupDialog({
  setup,
  onClose,
  onEnabled,
}: {
  setup: TotpSetup;
  onClose: () => void;
  onEnabled: (recoveryCodes: string[]) => void;
}) {
  const uid = useId();
  const enable = useEnableTotp();
  const [code, setCode] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const res = await enable.mutateAsync(code.trim()).catch(() => null);
    if (res) onEnabled(res.recoveryCodes);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('security.totpSetupTitle')}
      description={t('security.totpSetupHint')}
      busy={enable.isPending}
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
          <img
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qrSvg)}`}
            alt={t('security.qrAlt')}
            width={168}
            height={168}
            className="shrink-0 rounded-lg border border-border bg-white p-1"
          />
          <div className="min-w-0 space-y-2 text-sm">
            <p className="text-fg-muted">{t('security.manualEntry')}</p>
            <code className="block rounded bg-surface-2 px-2 py-1.5 font-mono text-xs tracking-wider break-all">
              {setup.secret.replace(/(.{4})/g, '$1 ').trim()}
            </code>
            <p className="text-xs text-fg-muted">{t('security.manualDetails')}</p>
          </div>
        </div>
        <Field
          id={`${uid}-code`}
          label={t('security.confirmCode')}
          error={enable.error ? errorMessage(enable.error) : null}
        >
          <Input
            id={`${uid}-code`}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="123456"
            className="font-mono tracking-widest"
            aria-invalid={!!enable.error}
            aria-describedby={describedBy(`${uid}-code`, {
              error: enable.error ? errorMessage(enable.error) : null,
            })}
            autoFocus
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={enable.isPending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={enable.isPending} disabled={code.trim().length !== 6}>
            {t('security.activate')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Shown once after the codes are made: copy or download them. */
export function RecoveryCodesDialog({
  codes,
  onClose,
}: {
  codes: string[] | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const text = (codes ?? []).join('\n');
  const download = () => {
    const blob = new Blob([`Burrow recovery codes\n\n${text}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'burrow-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Dialog
      open={codes !== null}
      onClose={onClose}
      title={t('security.codesTitle')}
      description={t('security.codesHint')}
      footer={
        <>
          <Button
            variant="secondary"
            icon="copy"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(text)
                .then(() => toast.show(t('security.codesCopied'), 'info'))
            }
          >
            {t('security.copy')}
          </Button>
          <Button variant="secondary" icon="download" onClick={download}>
            {t('security.download')}
          </Button>
          <Button onClick={onClose}>{t('security.codesSaved')}</Button>
        </>
      }
    >
      <ul className="grid grid-cols-2 gap-2 rounded-lg bg-surface-2 p-3 font-mono text-sm">
        {(codes ?? []).map((c) => (
          <li key={c} className="text-center tracking-wider">
            {c}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** Ask for the password again before a sensitive change. */
function PasswordConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  tone,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  tone: 'danger' | 'primary';
  onConfirm: (password: string) => Promise<void>;
  onCancel: () => void;
}) {
  const uid = useId();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setPassword('');
    setError(null);
    onCancel();
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(password);
      setPassword('');
    } catch (err) {
      setError(
        isApiError(err, 'VALIDATION_ERROR') ? t('security.wrongPassword') : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      description={description}
      size="sm"
      busy={busy}
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field id={`${uid}-pw`} label={t('settings.currentPassword')} error={error}>
          <Input
            id={`${uid}-pw`}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!error}
            aria-describedby={describedBy(`${uid}-pw`, { error })}
            autoFocus
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant={tone} loading={busy} disabled={!password}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RenameDialog({
  passkey,
  loading,
  onSave,
  onCancel,
}: {
  passkey: Passkey | null;
  loading: boolean;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const uid = useId();
  const [name, setName] = useState('');
  const [forId, setForId] = useState<number | null>(null);
  if (passkey && forId !== passkey.id) {
    setForId(passkey.id);
    setName(passkey.name);
  }
  return (
    <Dialog
      open={passkey !== null}
      onClose={onCancel}
      title={t('security.renameTitle')}
      size="sm"
      busy={loading}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSave(name.trim());
        }}
        className="space-y-4"
      >
        <Field id={`${uid}-name`} label={t('security.passkeyName')}>
          <Input
            id={`${uid}-name`}
            value={name}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={loading} disabled={!name.trim()}>
            {t('security.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
