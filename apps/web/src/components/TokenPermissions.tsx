import type { ReactNode } from 'react';
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
                {'optional' in p && p.optional ? (
                  <span className="ml-1.5 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-fg-muted">
                    {t('common.optional')}
                  </span>
                ) : null}
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

/** A value to pick in one of the Cloudflare dashboard dropdowns, drawn like a select. */
function DropdownValue({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-xs font-medium whitespace-nowrap text-fg shadow-sm">
      {children}
      <Icon name="chevronDown" size={11} className="text-fg-muted" />
    </span>
  );
}

function Step({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <p className="leading-relaxed text-fg">{title}</p>
        {children}
      </div>
    </li>
  );
}

/**
 * Step-by-step instructions to create the token on the Cloudflare dashboard,
 * written against the labels of the "Create Custom Token" page. Shown in the
 * first-run setup and in the "Replace token" dialog.
 */
export function TokenGuide() {
  return (
    <ol className="space-y-4 text-sm">
      <Step n={1} title={t('token.guide.open')}>
        <a
          href={API_TOKENS_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium break-all text-accent underline underline-offset-2"
        >
          dash.cloudflare.com/profile/api-tokens
          <Icon name="externalLink" size={12} />
        </a>
      </Step>
      <Step n={2} title={t('token.guide.custom')} />
      <Step n={3} title={t('token.guide.permissions')}>
        <ul className="space-y-2" aria-label={t('token.permissionsCaption')}>
          {REQUIRED_TOKEN_PERMISSIONS.map((p) => (
            <li
              key={`${p.scope}-${p.group}`}
              className="rounded-lg border border-border bg-surface-2/60 px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <DropdownValue>{p.scope}</DropdownValue>
                <DropdownValue>{p.group}</DropdownValue>
                <DropdownValue>{p.level}</DropdownValue>
                {'optional' in p && p.optional ? (
                  <span className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-fg-muted">
                    {t('common.optional')}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-fg-muted">{p.why}</p>
            </li>
          ))}
        </ul>
        <p className="flex gap-2 rounded-lg bg-accent-soft/60 px-3 py-2 text-xs leading-relaxed text-fg">
          <Icon name="info" size={14} className="mt-px shrink-0 text-accent" />
          <span>{t('token.guide.zoneTip')}</span>
        </p>
      </Step>
      <Step n={4} title={t('token.guide.resources')}>
        <dl className="space-y-1.5 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <dt className="w-full font-medium text-fg-muted sm:w-36">Account Resources</dt>
            <dd className="flex flex-wrap items-center gap-1.5">
              <DropdownValue>Include</DropdownValue>
              <DropdownValue>{t('token.guide.yourAccount')}</DropdownValue>
            </dd>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <dt className="w-full font-medium text-fg-muted sm:w-36">Zone Resources</dt>
            <dd className="flex flex-wrap items-center gap-1.5">
              <DropdownValue>Include</DropdownValue>
              <DropdownValue>Specific zone</DropdownValue>
              <DropdownValue>{t('token.guide.yourDomain')}</DropdownValue>
            </dd>
          </div>
        </dl>
        <p className="text-xs text-fg-muted">{t('token.guide.resourcesHint')}</p>
      </Step>
      <Step n={5} title={t('token.guide.create')} />
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
              check.ok
                ? 'bg-success-soft text-success'
                : check.optional
                  ? 'bg-surface-2 text-fg-muted'
                  : 'bg-danger-soft text-danger',
            )}
          >
            <Icon
              name={check.ok ? 'check' : check.optional ? 'info' : 'x'}
              size={11}
              strokeWidth={3}
            />
          </span>
          <span className="min-w-0">
            <span className="text-fg">{check.name}</span>
            <span className="sr-only">
              :{' '}
              {check.ok
                ? t('token.checkOk')
                : check.optional
                  ? t('token.checkOptional')
                  : t('token.checkMissing')}
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
