import { useId, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { loginSchema } from '@burrow/shared';
import { isApiError } from '../api/client';
import { useLogin, useMe, useSetupStatus } from '../api/queries';
import { Card, CardBody } from '../components/ui/Card';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { describedBy, Field, Input } from '../components/ui/Field';
import { t } from '../i18n';
import { errorMessage } from '../lib/errors';
import { fieldErrors } from '../lib/zod';
import { AuthShell, FullPageSpinner } from './FullPage';

/** Only allow same-app redirects after login. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function LoginPage() {
  const uid = useId();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const status = useSetupStatus();
  const me = useMe();
  const login = useLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const next = safeNext(params.get('next'));

  if (status.isPending || me.isPending) return <FullPageSpinner />;
  if (status.data && !status.data.userCreated) return <Navigate to="/setup" replace />;
  if (me.data) return <Navigate to={next} replace />;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    try {
      await login.mutateAsync(parsed.data);
      navigate(next, { replace: true });
    } catch {
      /* shown below */
    }
  }

  const loginError = login.error
    ? isApiError(login.error, 'UNAUTHORIZED')
      ? t('login.invalid')
      : errorMessage(login.error)
    : null;

  return (
    <AuthShell>
      <Card>
        <CardBody className="space-y-5 py-6 sm:px-6">
          <div>
            <h2 className="text-lg font-semibold">{t('login.title')}</h2>
            <p className="text-sm text-fg-muted">{t('login.subtitle')}</p>
          </div>
          {loginError ? <Alert tone="danger">{loginError}</Alert> : null}
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
            <Field id={`${uid}-password`} label={t('login.password')} error={errors.password}>
              <Input
                id={`${uid}-password`}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!errors.password}
                aria-describedby={describedBy(`${uid}-password`, { error: errors.password })}
              />
            </Field>
            <Button type="submit" className="w-full" loading={login.isPending}>
              {t('login.submit')}
            </Button>
          </form>
        </CardBody>
      </Card>
    </AuthShell>
  );
}
