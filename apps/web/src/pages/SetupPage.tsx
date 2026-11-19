/**
 * First-run wizard, driven by GET /api/setup/status:
 *
 *   1. admin       create the admin account     (userCreated = false)
 *   2. cloudflare  paste and verify the token   (cloudflareConfigured = false)
 *   3. zones       choose where hosts may live  (local step, right after 2)
 *   4. done        go to the dashboard
 *
 * Reloading the page resumes at the first unfinished server-side step.
 */
import { useId, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router';
import { createAdminSchema } from '@burrow/shared';
import { useCreateAdmin, useMe, useSetupStatus, useZones } from '../api/queries';
import { Icon } from '../components/Icon';
import { PasswordStrength } from '../components/PasswordStrength';
import { RequiredPermissionsTable, TokenGuide } from '../components/TokenPermissions';
import { TokenForm } from '../components/TokenForm';
import { ZoneList } from '../components/ZoneList';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody } from '../components/ui/Card';
import { describedBy, Field, Input } from '../components/ui/Field';
import { t, type MessageKey } from '../i18n';
import { cn } from '../lib/cn';
import { errorMessage } from '../lib/errors';
import { fieldErrors } from '../lib/zod';
import { AuthShell, FullPageError, FullPageSpinner } from './FullPage';

type Step = 'admin' | 'cloudflare' | 'zones' | 'done';
const STEPS: Array<{ id: Step; label: MessageKey }> = [
  { id: 'admin', label: 'setup.steps.admin' },
  { id: 'cloudflare', label: 'setup.steps.cloudflare' },
  { id: 'zones', label: 'setup.steps.zones' },
  { id: 'done', label: 'setup.steps.done' },
];

export function SetupPage() {
  const status = useSetupStatus();
  const me = useMe();
  // Steps after the token are not tracked by the server: keep them locally.
  const [localStep, setLocalStep] = useState<'zones' | 'done' | null>(null);

  if (status.isPending || me.isPending) return <FullPageSpinner />;
  if (status.isError)
    return <FullPageError error={status.error} onRetry={() => void status.refetch()} />;

  const { userCreated, cloudflareConfigured } = status.data;
  let step: Step;
  if (!userCreated) step = 'admin';
  else if (!me.data) return <Navigate to="/login?next=/setup" replace />;
  else if (!cloudflareConfigured) step = 'cloudflare';
  else if (localStep) step = localStep;
  else return <Navigate to="/" replace />;

  return (
    <AuthShell wide>
      <Stepper current={step} />
      {step === 'admin' ? <AdminStep /> : null}
      {step === 'cloudflare' ? <CloudflareStep onDone={() => setLocalStep('zones')} /> : null}
      {step === 'zones' ? <ZonesStep onDone={() => setLocalStep('done')} /> : null}
      {step === 'done' ? <DoneStep /> : null}
    </AuthShell>
  );
}

function Stepper({ current }: { current: Step }) {
  const index = STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="mb-6 flex items-center gap-2" aria-label={t('setup.progress')}>
      {STEPS.map((step, i) => {
        const done = i < index;
        const active = i === index;
        return (
          <li
            key={step.id}
            className="flex flex-1 items-center gap-2"
            aria-current={active ? 'step' : undefined}
          >
            <span
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                done && 'bg-accent text-accent-fg',
                active && 'bg-accent-soft text-accent ring-2 ring-accent',
                !done && !active && 'bg-surface-2 text-fg-muted',
              )}
            >
              {done ? <Icon name="check" size={14} strokeWidth={3} /> : i + 1}
            </span>
            <span
              className={cn(
                'hidden text-sm sm:inline',
                active ? 'font-medium text-fg' : 'text-fg-muted',
              )}
            >
              {t(step.label)}
            </span>
            {i < STEPS.length - 1 ? <span className="h-px flex-1 bg-border" aria-hidden /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function StepCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardBody className="space-y-5 py-6 sm:px-7">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-fg-muted">{description}</p>
        </div>
        {children}
      </CardBody>
    </Card>
  );
}

/* ------------------------------- 1. admin ------------------------------ */

function AdminStep() {
  const uid = useId();
  const create = useCreateAdmin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = createAdminSchema.safeParse({ email, password });
    const next = parsed.success ? {} : fieldErrors(parsed.error);
    if (password !== confirm) next.confirm = t('password.mismatch');
    setErrors(next);
    if (!parsed.success || next.confirm) return;
    try {
      await create.mutateAsync(parsed.data);
    } catch {
      /* shown below */
    }
  }

  return (
    <StepCard title={t('setup.admin.title')} description={t('setup.admin.description')}>
      {create.isError ? <Alert tone="danger">{errorMessage(create.error)}</Alert> : null}
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <Field id={`${uid}-email`} label={t('login.email')} error={errors.email}>
          <Input
            id={`${uid}-email`}
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={!!errors.email}
            aria-describedby={describedBy(`${uid}-email`, { error: errors.email })}
            autoFocus
          />
        </Field>
        <Field
          id={`${uid}-password`}
          label={t('login.password')}
          error={errors.password}
          hint={<PasswordStrength password={password} />}
        >
          <Input
            id={`${uid}-password`}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!errors.password}
            aria-describedby={describedBy(`${uid}-password`, {
              hint: true,
              error: errors.password,
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
          <Button type="submit" loading={create.isPending}>
            {t('setup.admin.submit')}
          </Button>
        </div>
      </form>
    </StepCard>
  );
}

/* ----------------------------- 2. cloudflare ---------------------------- */

function CloudflareStep({ onDone }: { onDone: () => void }) {
  return (
    <StepCard title={t('setup.cloudflare.title')} description={t('setup.cloudflare.description')}>
      <section aria-labelledby="token-guide" className="space-y-3">
        <h3 id="token-guide" className="text-sm font-semibold">
          {t('setup.cloudflare.howTo')}
        </h3>
        <TokenGuide />
      </section>
      <section aria-labelledby="token-perms" className="space-y-3">
        <h3 id="token-perms" className="text-sm font-semibold">
          {t('token.permissionsCaption')}
        </h3>
        <RequiredPermissionsTable />
        <p className="text-xs text-fg-muted">{t('setup.cloudflare.scopeHint')}</p>
      </section>
      <div className="border-t border-border pt-5">
        <TokenForm onSaved={onDone} submitLabel={t('setup.cloudflare.submit')} />
      </div>
    </StepCard>
  );
}

/* ------------------------------- 3. zones ------------------------------- */

function ZonesStep({ onDone }: { onDone: () => void }) {
  const zones = useZones();
  const enabled = zones.data?.filter((z) => z.enabled).length ?? 0;
  return (
    <StepCard title={t('setup.zones.title')} description={t('setup.zones.description')}>
      <ZoneList />
      <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-fg-muted">
          {enabled === 0 ? t('setup.zones.noneYet') : t('setup.zones.later')}
        </p>
        <Button onClick={onDone} variant={enabled === 0 ? 'secondary' : 'primary'}>
          {enabled === 0 ? t('setup.zones.skip') : t('common.continue')}
        </Button>
      </div>
    </StepCard>
  );
}

/* -------------------------------- 4. done ------------------------------- */

function DoneStep() {
  return (
    <Card>
      <CardBody className="flex flex-col items-center gap-4 py-10 text-center sm:px-8">
        <span className="flex size-14 items-center justify-center rounded-full bg-success-soft text-success">
          <Icon name="check" size={28} strokeWidth={2.5} />
        </span>
        <div>
          <h2 className="text-lg font-semibold">{t('setup.done.title')}</h2>
          <p className="mt-1 max-w-md text-sm text-fg-muted">{t('setup.done.description')}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link
            to="/?new=1"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
          >
            <Icon name="plus" />
            {t('setup.done.addHost')}
          </Link>
          <Link
            to="/"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium text-fg hover:bg-surface-2"
          >
            {t('setup.done.dashboard')}
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}
