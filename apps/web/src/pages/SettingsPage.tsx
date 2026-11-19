/** Settings: Cloudflare token, zones, configuration, API tokens, password, session. */
import { useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { changePasswordSchema } from '@burrow/shared';
import { isApiError } from '../api/client';
import {
  useChangePassword,
  useCloudflareSettings,
  useLogout,
  useMe,
  useRemoveToken,
} from '../api/queries';
import { PageHeader } from '../components/PageHeader';
import {
  RequiredPermissionsTable,
  PermissionChecks,
  TokenGuide,
} from '../components/TokenPermissions';
import { TokenForm } from '../components/TokenForm';
import { ZoneList } from '../components/ZoneList';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Dialog } from '../components/ui/Dialog';
import { describedBy, Field, Input } from '../components/ui/Field';
import { PageSpinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';
import { t } from '../i18n';
import { errorMessage } from '../lib/errors';
import { fieldErrors } from '../lib/zod';
import { PasswordStrength } from '../components/PasswordStrength';
import { ApiTokensCard } from '../components/settings/ApiTokensCard';
import { BackupsCard } from '../components/settings/BackupsCard';
import { ConfigCard } from '../components/settings/ConfigCard';
import { DockerCard } from '../components/settings/DockerCard';
import { DriftCard } from '../components/settings/DriftCard';

export function SettingsPage() {
  return (
    <>
      <PageHeader title={t('settings.title')} description={t('settings.description')} />
      <div className="space-y-6">
        <CloudflareCard />
        <Card>
          <CardHeader title={t('settings.zones')} description={t('settings.zonesHint')} />
          <CardBody>
            <ZoneList />
          </CardBody>
        </Card>
        <DockerCard />
        <DriftCard />
        <ConfigCard />
        <BackupsCard />
        <ApiTokensCard />
        <div className="grid gap-6 lg:grid-cols-2">
          <PasswordCard />
          <SessionCard />
        </div>
      </div>
    </>
  );
}

function CloudflareCard() {
  const settings = useCloudflareSettings();
  const remove = useRemoveToken();
  const toast = useToast();
  const navigate = useNavigate();
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showPerms, setShowPerms] = useState(false);

  return (
    <Card>
      <CardHeader
        title={t('settings.cloudflare')}
        description={t('settings.cloudflareHint')}
        actions={
          settings.data?.configured ? (
            <>
              <Button variant="secondary" size="sm" icon="key" onClick={() => setReplacing(true)}>
                {t('settings.replaceToken')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon="trash"
                onClick={() => setConfirmRemove(true)}
                className="hover:text-danger"
              >
                {t('settings.removeToken')}
              </Button>
            </>
          ) : null
        }
      />
      <CardBody className="space-y-4">
        {settings.isPending ? (
          <PageSpinner />
        ) : settings.isError ? (
          <Alert tone="danger">{errorMessage(settings.error)}</Alert>
        ) : (
          <>
            <dl className="grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-fg-muted">{t('settings.token')}</dt>
                <dd className="mt-1 flex items-center gap-2">
                  {settings.data.tokenHint ? (
                    <code className="font-mono tracking-wider">
                      ••••••••{settings.data.tokenHint}
                    </code>
                  ) : (
                    <span className="text-fg-muted">—</span>
                  )}
                  <Badge tone={settings.data.configured ? 'success' : 'warning'} dot>
                    {settings.data.configured
                      ? t('settings.verified')
                      : t('settings.notConfigured')}
                  </Badge>
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-fg-muted">{t('settings.account')}</dt>
                <dd className="mt-1">
                  {settings.data.account ? (
                    <>
                      <span className="font-medium">{settings.data.account.name}</span>{' '}
                      <code className="font-mono text-xs break-all text-fg-muted">
                        {settings.data.account.id}
                      </code>
                    </>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
            </dl>
            {settings.data.permissions.length > 0 ? (
              <div>
                <p className="mb-2 text-sm text-fg-muted">{t('token.checksTitle')}</p>
                <PermissionChecks checks={settings.data.permissions} />
              </div>
            ) : null}
            <button
              type="button"
              className="text-sm font-medium text-accent underline-offset-2 hover:underline"
              aria-expanded={showPerms}
              onClick={() => setShowPerms((s) => !s)}
            >
              {showPerms ? t('settings.hidePermissions') : t('settings.showPermissions')}
            </button>
            {showPerms ? <RequiredPermissionsTable /> : null}
          </>
        )}
      </CardBody>

      <Dialog
        open={replacing}
        onClose={() => setReplacing(false)}
        title={t('settings.replaceToken')}
        description={t('settings.replaceHint')}
        size="lg"
      >
        <section aria-labelledby="replace-token-guide" className="space-y-3">
          <h3 id="replace-token-guide" className="text-sm font-semibold">
            {t('settings.howToCreate')}
          </h3>
          <TokenGuide />
          <RequiredPermissionsTable />
        </section>
        <div className="mt-5 border-t border-border pt-5">
          <TokenForm
            onCancel={() => setReplacing(false)}
            onSaved={() => {
              setReplacing(false);
              toast.show(t('settings.tokenSaved'));
            }}
          />
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirmRemove}
        title={t('settings.removeTitle')}
        description={t('settings.removeBody')}
        confirmLabel={t('settings.removeToken')}
        loading={remove.isPending}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              setConfirmRemove(false);
              toast.show(t('settings.tokenRemoved'), 'info');
              navigate('/setup');
            },
            onError: (error) => toast.show(errorMessage(error), 'danger'),
          })
        }
      />
    </Card>
  );
}

function PasswordCard() {
  const uid = useId();
  const change = useChangePassword();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = changePasswordSchema.safeParse({ currentPassword: current, newPassword: next });
    const errs = parsed.success ? {} : fieldErrors(parsed.error);
    if (next !== confirm) errs.confirm = t('password.mismatch');
    setErrors(errs);
    if (!parsed.success || errs.confirm) return;
    try {
      await change.mutateAsync(parsed.data);
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.show(t('settings.passwordChanged'));
    } catch (error) {
      if (
        isApiError(error) &&
        (error.code === 'UNAUTHORIZED' ||
          error.code === 'FORBIDDEN' ||
          error.code === 'VALIDATION_ERROR')
      ) {
        setErrors({ currentPassword: error.message || t('settings.wrongPassword') });
      }
    }
  }

  return (
    <Card>
      <CardHeader title={t('settings.password')} />
      <CardBody>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          {change.isError && !errors.currentPassword ? (
            <Alert tone="danger">{errorMessage(change.error)}</Alert>
          ) : null}
          <Field
            id={`${uid}-cur`}
            label={t('settings.currentPassword')}
            error={errors.currentPassword}
          >
            <Input
              id={`${uid}-cur`}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              aria-invalid={!!errors.currentPassword}
              aria-describedby={describedBy(`${uid}-cur`, { error: errors.currentPassword })}
            />
          </Field>
          <Field
            id={`${uid}-new`}
            label={t('settings.newPassword')}
            error={errors.newPassword}
            hint={<PasswordStrength password={next} />}
          >
            <Input
              id={`${uid}-new`}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              aria-invalid={!!errors.newPassword}
              aria-describedby={describedBy(`${uid}-new`, {
                hint: true,
                error: errors.newPassword,
              })}
            />
          </Field>
          <Field id={`${uid}-confirm`} label={t('password.confirm')} error={errors.confirm}>
            <Input
              id={`${uid}-confirm`}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={!!errors.confirm}
              aria-describedby={describedBy(`${uid}-confirm`, { error: errors.confirm })}
            />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={change.isPending}>
              {t('settings.changePassword')}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function SessionCard() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  return (
    <Card className="h-fit">
      <CardHeader title={t('settings.session')} />
      <CardBody className="space-y-4">
        <p className="text-sm text-fg-muted">
          {t('settings.signedInAs')}{' '}
          <span className="font-medium text-fg">{me.data?.user.email}</span>
        </p>
        <Button
          variant="secondary"
          icon="logout"
          loading={logout.isPending}
          onClick={() =>
            logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) })
          }
        >
          {t('nav.logout')}
        </Button>
      </CardBody>
    </Card>
  );
}
