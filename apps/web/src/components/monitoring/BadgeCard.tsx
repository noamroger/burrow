/** Public status badge of a host: turn on, preview, copy the embed code, rotate, turn off. */
import { useId, useState } from 'react';
import type { HostMonitorSummary } from '@burrow/shared';
import { useBadge } from '../../api/queries';
import { t } from '../../i18n';
import { errorMessage } from '../../lib/errors';
import { Alert } from '../ui/Alert';
import { Button, IconButton } from '../ui/Button';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Field, Input, Select } from '../ui/Field';
import { useToast } from '../ui/Toast';

/** Origin the badge is served from. Overridable so a public hostname can be used. */
export function badgeUrl(origin: string, token: string, theme: string, label: string): string {
  const params = new URLSearchParams();
  if (theme !== 'soil') params.set('theme', theme);
  if (label.trim()) params.set('label', label.trim());
  const query = params.toString();
  return `${origin}/api/badge/${token}.svg${query ? `?${query}` : ''}`;
}

export function BadgeCard({
  summary,
  publicOrigin,
}: {
  summary: HostMonitorSummary;
  /** `https://<public hostname>` when one is set, otherwise this page's origin. */
  publicOrigin?: string | null;
}) {
  const uid = useId();
  const { enable, disable } = useBadge(summary.hostId);
  const toast = useToast();
  const [theme, setTheme] = useState<'soil' | 'chalk'>('soil');
  const [label, setLabel] = useState('');
  const [confirm, setConfirm] = useState<'rotate' | 'off' | null>(null);
  const token = summary.badgeToken;
  const origin = publicOrigin ?? window.location.origin;
  const error = enable.error ?? disable.error;

  const url = token ? badgeUrl(origin, token, theme, label) : '';
  const alt = `${label.trim() || summary.hostname} status`;
  const snippets = token
    ? [
        { id: 'markdown', label: t('badge.markdown'), code: `![${alt}](${url})` },
        { id: 'html', label: t('badge.html'), code: `<img src="${url}" alt="${alt}" height="28">` },
        { id: 'url', label: t('badge.url'), code: url },
      ]
    : [];

  const copy = (code: string) =>
    void navigator.clipboard
      ?.writeText(code)
      .then(() => toast.show(t('badge.copied'), 'info'))
      .catch(() => undefined);

  return (
    <Card>
      <CardHeader
        title={t('badge.title')}
        description={t('badge.hint')}
        actions={
          token ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                icon="restart"
                onClick={() => setConfirm('rotate')}
              >
                {t('badge.rotate')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm('off')}>
                {t('badge.disable')}
              </Button>
            </>
          ) : null
        }
      />
      <CardBody className="space-y-4">
        {error ? <Alert tone="danger">{errorMessage(error)}</Alert> : null}
        {!token ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-prose text-sm text-fg-muted">{t('badge.offBody')}</p>
            <Button icon="eye" loading={enable.isPending} onClick={() => enable.mutate()}>
              {t('badge.enable')}
            </Button>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`${uid}-label`} label={t('badge.label')} aside={t('common.optional')}>
                <Input
                  id={`${uid}-label`}
                  value={label}
                  maxLength={40}
                  placeholder={summary.hostname}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </Field>
              <Field id={`${uid}-theme`} label={t('badge.theme')}>
                <Select
                  id={`${uid}-theme`}
                  value={theme}
                  onChange={(e) => setTheme(e.target.value as 'soil' | 'chalk')}
                >
                  <option value="soil">{t('badge.themeSoil')}</option>
                  <option value="chalk">{t('badge.themeChalk')}</option>
                </Select>
              </Field>
            </div>
            <div
              className={
                theme === 'soil'
                  ? 'rounded-lg border border-border bg-surface-2 p-4'
                  : 'rounded-lg border border-border bg-[#1d1612] p-4'
              }
            >
              {/* Served by this Burrow, same origin: always previewable. */}
              <img
                src={badgeUrl('', token, theme, label)}
                alt={alt}
                height={28}
                className="h-7 w-auto"
              />
            </div>
            <ul className="space-y-2">
              {snippets.map((s) => (
                <li key={s.id} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-xs font-medium text-fg-muted">{s.label}</span>
                  <code className="min-w-0 flex-1 truncate rounded bg-surface-2 px-2 py-1.5 font-mono text-xs text-fg">
                    {s.code}
                  </code>
                  <IconButton
                    icon="copy"
                    size="sm"
                    label={t('badge.copy', { what: s.label })}
                    onClick={() => copy(s.code)}
                  />
                </li>
              ))}
            </ul>
            {!publicOrigin ? (
              <p className="text-xs leading-relaxed text-fg-muted">{t('badge.reachHint')}</p>
            ) : null}
          </>
        )}
      </CardBody>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'rotate' ? t('badge.rotateTitle') : t('badge.disableTitle')}
        description={t('badge.confirmBody')}
        confirmLabel={confirm === 'rotate' ? t('badge.rotate') : t('badge.disable')}
        tone={confirm === 'rotate' ? 'primary' : 'danger'}
        loading={enable.isPending || disable.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const action = confirm === 'rotate' ? enable : disable;
          action.mutate(undefined, { onSettled: () => setConfirm(null) });
        }}
      />
    </Card>
  );
}
