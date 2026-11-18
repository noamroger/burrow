import { REQUIRED_TOKEN_PERMISSIONS, type PermissionCheck } from '@burrow/shared';
import { t } from '../i18n';
import { cn } from '../lib/cn';
import { Icon } from './Icon';

export const API_TOKENS_URL = 'https://dash.cloudflare.com/profile/api-tokens';

/** The least-privilege permissions the token needs, with the reason for each. */
export function RequiredPermissionsTable() {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{t('token.permissionsCaption')}</caption>
        <thead className="bg-surface-2 text-xs text-fg-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              {t('token.permission')}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t('token.access')}
            </th>
            <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">
              {t('token.why')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {REQUIRED_TOKEN_PERMISSIONS.map((p) => (
            <tr key={`${p.scope}-${p.group}`}>
              <td className="px-3 py-2 align-top">
                <span className="text-fg-muted">{p.scope} › </span>
                <span className="font-medium text-fg">{p.group}</span>
                <p className="mt-0.5 text-xs text-fg-muted sm:hidden">{p.why}</p>
              </td>
              <td className="px-3 py-2 align-top">
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-xs font-semibold',
                    p.level === 'Edit'
                      ? 'bg-accent-soft text-accent'
                      : 'bg-surface-2 text-fg-muted',
                  )}
                >
                  {p.level}
                </span>
              </td>
              <td className="hidden px-3 py-2 align-top text-fg-muted sm:table-cell">{p.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Step-by-step instructions to create the token on the Cloudflare dashboard. */
export function TokenGuide() {
  const steps = [
    t('token.step1'),
    t('token.step2'),
    t('token.step3'),
    t('token.step4'),
    t('token.step5'),
  ];
  return (
    <ol className="space-y-2 text-sm text-fg">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-3">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
            {i + 1}
          </span>
          <span className="pt-0.5 leading-relaxed">
            {i === 0 ? (
              <>
                {step}{' '}
                <a
                  href={API_TOKENS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-accent underline underline-offset-2"
                >
                  dash.cloudflare.com/profile/api-tokens
                  <Icon name="externalLink" size={12} />
                </a>
              </>
            ) : (
              step
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Result of the server's permission checks for a saved token. */
export function PermissionChecks({ checks }: { checks: PermissionCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <ul className="space-y-1.5" aria-label={t('token.checksTitle')}>
      {checks.map((check) => (
        <li key={check.name} className="flex items-start gap-2 text-sm">
          <span
            className={cn(
              'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full',
              check.ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger',
            )}
          >
            <Icon name={check.ok ? 'check' : 'x'} size={11} strokeWidth={3} />
          </span>
          <span className="min-w-0">
            <span className="text-fg">{check.name}</span>
            <span className="sr-only">
              : {check.ok ? t('token.checkOk') : t('token.checkMissing')}
            </span>
            {check.message ? (
              <span className="block text-xs text-fg-muted">{check.message}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
