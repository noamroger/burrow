import { useId, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { loginSchema, type MfaChallenge } from '@burrow/shared';
import { isApiError } from '../api/client';
import { authApi } from '../api/endpoints';
import { useCompleteLogin, useLogin, useMe, useSetupStatus } from '../api/queries';
import { Card, CardBody } from '../components/ui/Card';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { describedBy, Field, Input } from '../components/ui/Field';
import { t } from '../i18n';
import { errorMessage } from '../lib/errors';
import { getPasskey, isPasskeyCancelled, passkeySupport } from '../lib/passkeys';
import { fieldErrors } from '../lib/zod';
import { AuthShell, FullPageSpinner } from './FullPage';

/** Only allow same-app redirects after login. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

/** Ask the browser for a passkey and sign in with it (after the password when `ticket` is set). */
async function passkeySignIn(ticket?: string) {
  const { challengeId, options } = await authApi.passkeyOptions(ticket);
  const response = await getPasskey(options);
  return authApi.passkeyVerify(challengeId, response);
}

export function LoginPage() {
  const uid = useId();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const status = useSetupStatus();
  const me = useMe();
  const login = useLogin();
  const passkey = useCompleteLogin(passkeySignIn);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [expired, setExpired] = useState(false);

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
    setExpired(false);
    try {
      const res = await login.mutateAsync(parsed.data);
      if ('mfaRequired' in res) {
        setChallenge(res);
        return;
      }
      navigate(next, { replace: true });
    } catch {
      /* shown below */
    }
  }

  async function signInWithPasskey(ticket?: string) {
    try {
      await passkey.mutateAsync(ticket);
      navigate(next, { replace: true });
    } catch (error) {
      if (isApiError(error, 'MFA_EXPIRED') && ticket) restart(true);
    }
  }

  function restart(wasExpired = false) {
    setChallenge(null);
    setPassword('');
    setExpired(wasExpired);
    login.reset();
    passkey.reset();
  }

  if (challenge) {
    return (
      <SecondStep
        challenge={challenge}
        onDone={() => navigate(next, { replace: true })}
        onExpired={() => restart(true)}
        onBack={() => restart()}
        onPasskey={() => void signInWithPasskey(challenge.ticket)}
        passkeyPending={passkey.isPending}
        passkeyError={
          passkey.error && !isPasskeyCancelled(passkey.error) ? errorMessage(passkey.error) : null
        }
      />
    );
  }

  const loginError = login.error
    ? isApiError(login.error, 'UNAUTHORIZED')
      ? t('login.invalid')
      : errorMessage(login.error)
    : passkey.error && !isPasskeyCancelled(passkey.error)
      ? errorMessage(passkey.error)
      : null;
  const canUsePasskey = passkeySupport() === 'ok';

  return (
    <AuthShell>
      <Card>
        <CardBody className="space-y-5 py-6 sm:px-6">
          <div>
            <h2 className="text-lg font-semibold">{t('login.title')}</h2>
            <p className="text-sm text-fg-muted">{t('login.subtitle')}</p>
          </div>
          {expired ? <Alert tone="warning">{t('login.mfaExpired')}</Alert> : null}
          {loginError ? <Alert tone="danger">{loginError}</Alert> : null}
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <Field id={`${uid}-email`} label={t('login.email')} error={errors.email}>
              <Input
                id={`${uid}-email`}
                type="email"
                autoComplete="username webauthn"
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
          {canUsePasskey ? (
            <>
              <div className="flex items-center gap-3 text-xs text-fg-muted" aria-hidden>
                <span className="h-px flex-1 bg-border" />
                {t('login.or')}
                <span className="h-px flex-1 bg-border" />
              </div>
              <Button
                variant="secondary"
                icon="key"
                className="w-full"
                loading={passkey.isPending}
                onClick={() => void signInWithPasskey()}
              >
                {t('login.withPasskey')}
              </Button>
            </>
          ) : null}
        </CardBody>
      </Card>
    </AuthShell>
  );
}

function SecondStep({
  challenge,
  onDone,
  onExpired,
  onBack,
  onPasskey,
  passkeyPending,
  passkeyError,
}: {
  challenge: MfaChallenge;
  onDone: () => void;
  onExpired: () => void;
  onBack: () => void;
  onPasskey: () => void;
  passkeyPending: boolean;
  passkeyError: string | null;
}) {
  const uid = useId();
  const hasTotp = challenge.methods.includes('totp');
  const hasPasskey = challenge.methods.includes('passkey') && passkeySupport() === 'ok';
  const hasRecovery = challenge.methods.includes('recovery');
  const [mode, setMode] = useState<'totp' | 'recovery'>(hasTotp ? 'totp' : 'recovery');
  const [showCode, setShowCode] = useState(hasTotp || !hasPasskey);
  const [code, setCode] = useState('');
  const verify = useCompleteLogin(authApi.verifyCode);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!code.trim()) return;
    try {
      await verify.mutateAsync({ ticket: challenge.ticket, code });
      onDone();
    } catch (error) {
      if (isApiError(error, 'MFA_EXPIRED')) onExpired();
      else setCode('');
    }
  }

  const codeError = verify.error
    ? isApiError(verify.error, 'UNAUTHORIZED')
      ? t('login.codeInvalid')
      : errorMessage(verify.error)
    : null;

  return (
    <AuthShell>
      <Card>
        <CardBody className="space-y-5 py-6 sm:px-6">
          <div>
            <h2 className="text-lg font-semibold">{t('login.mfaTitle')}</h2>
            <p className="text-sm text-fg-muted">
              {hasTotp ? t('login.mfaSubtitle') : t('login.mfaSubtitlePasskey')}
            </p>
          </div>
          {passkeyError ? <Alert tone="danger">{passkeyError}</Alert> : null}

          {hasPasskey ? (
            <Button
              variant={hasTotp ? 'secondary' : 'primary'}
              icon="key"
              className="w-full"
              loading={passkeyPending}
              onClick={onPasskey}
            >
              {t('login.usePasskey')}
            </Button>
          ) : null}

          {showCode ? (
            <form onSubmit={submit} noValidate className="space-y-4">
              <Field
                id={`${uid}-code`}
                label={mode === 'totp' ? t('login.code') : t('login.recoveryCode')}
                hint={mode === 'totp' ? t('login.codeHint') : t('login.recoveryHint')}
                error={codeError}
              >
                <Input
                  id={`${uid}-code`}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode={mode === 'totp' ? 'numeric' : 'text'}
                  autoComplete="one-time-code"
                  maxLength={mode === 'totp' ? 6 : 11}
                  placeholder={mode === 'totp' ? '123456' : 'abcde-fghjk'}
                  className="font-mono tracking-widest"
                  aria-invalid={!!codeError}
                  aria-describedby={describedBy(`${uid}-code`, { hint: true, error: codeError })}
                  autoFocus
                />
              </Field>
              <Button type="submit" className="w-full" loading={verify.isPending}>
                {t('login.verify')}
              </Button>
            </form>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <button
              type="button"
              className="font-medium text-fg-muted underline-offset-2 hover:text-fg hover:underline"
              onClick={onBack}
            >
              {t('login.back')}
            </button>
            {hasRecovery && (mode === 'totp' || !showCode) ? (
              <button
                type="button"
                className="font-medium text-accent underline-offset-2 hover:underline"
                onClick={() => {
                  setMode('recovery');
                  setShowCode(true);
                  setCode('');
                  verify.reset();
                }}
              >
                {t('login.useRecovery')}
              </button>
            ) : hasTotp && mode === 'recovery' ? (
              <button
                type="button"
                className="font-medium text-accent underline-offset-2 hover:underline"
                onClick={() => {
                  setMode('totp');
                  setCode('');
                  verify.reset();
                }}
              >
                {t('login.useApp')}
              </button>
            ) : null}
          </div>
        </CardBody>
      </Card>
    </AuthShell>
  );
}
