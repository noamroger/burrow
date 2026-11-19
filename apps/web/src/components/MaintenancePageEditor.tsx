/**
 * Editor for a maintenance page, with a live preview.
 *
 * Two modes: a simple design (title, message, colours, logo) or a complete
 * HTML document. The preview renders with the same function the server
 * uses, inside a sandboxed iframe (no scripts run in the admin UI).
 */
import { useId, useRef, useState, type ChangeEvent } from 'react';
import { renderMaintenancePage, type MaintenancePage } from '@burrow/shared';
import { t } from '../i18n';
import { cn } from '../lib/cn';
import { Button } from './ui/Button';
import { Checkbox, describedBy, Field, Input, Textarea } from './ui/Field';

/** Uploaded logos are stored inline: keep them small. */
export const MAX_LOGO_BYTES = 300 * 1024;

export interface MaintenancePageEditorProps {
  value: MaintenancePage;
  onChange: (page: MaintenancePage) => void;
  /** Hostname used in the preview. */
  hostname?: string;
  until?: string | null;
  errors?: Record<string, string>;
}

export function MaintenancePageEditor({
  value,
  onChange,
  hostname = 'app.example.com',
  until = null,
  errors = {},
}: MaintenancePageEditorProps) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const fileRef = useRef<HTMLInputElement>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const set = <K extends keyof MaintenancePage>(key: K, v: MaintenancePage[K]) =>
    onChange({ ...value, [key]: v });

  const preview = renderMaintenancePage(value, {
    hostname,
    until,
    formatUntil: (iso) => new Date(iso).toLocaleString(),
  });

  function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(file.type)) {
      setLogoError(t('maintenance.logoType'));
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError(t('maintenance.logoTooLarge'));
      return;
    }
    setLogoError(null);
    const reader = new FileReader();
    reader.onload = () => set('logoUrl', String(reader.result));
    reader.readAsDataURL(file);
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-4">
        <div
          role="radiogroup"
          aria-label={t('maintenance.mode')}
          className="inline-flex rounded-lg border border-border bg-surface-2 p-0.5"
        >
          {(['simple', 'html'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={value.mode === mode}
              onClick={() => set('mode', mode)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                value.mode === mode
                  ? 'bg-surface text-fg shadow-sm'
                  : 'text-fg-muted hover:text-fg',
              )}
            >
              {t(`maintenance.mode.${mode}`)}
            </button>
          ))}
        </div>

        {value.mode === 'simple' ? (
          <>
            <Field id={id('title')} label={t('maintenance.titleField')} error={errors.title}>
              <Input
                id={id('title')}
                value={value.title}
                onChange={(e) => set('title', e.target.value)}
              />
            </Field>
            <Field
              id={id('message')}
              label={t('maintenance.message')}
              hint={t('maintenance.placeholders')}
              error={errors.message}
            >
              <Textarea
                id={id('message')}
                rows={4}
                value={value.message}
                onChange={(e) => set('message', e.target.value)}
                aria-describedby={describedBy(id('message'), { hint: true })}
              />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              {(['accentColor', 'backgroundColor', 'textColor'] as const).map((key) => (
                <ColorField
                  key={key}
                  id={id(key)}
                  label={t(`maintenance.${key}`)}
                  value={value[key]}
                  error={errors[key]}
                  onChange={(v) => set(key, v)}
                />
              ))}
            </div>
            <Field
              id={id('logo')}
              label={t('maintenance.logo')}
              aside={t('common.optional')}
              hint={t('maintenance.logoHint')}
              error={logoError ?? errors.logoUrl}
            >
              <div className="flex gap-2">
                <Input
                  id={id('logo')}
                  value={
                    value.logoUrl.startsWith('data:')
                      ? t('maintenance.logoUploaded')
                      : value.logoUrl
                  }
                  readOnly={value.logoUrl.startsWith('data:')}
                  onChange={(e) => set('logoUrl', e.target.value)}
                  placeholder="https://example.com/logo.svg"
                  aria-describedby={describedBy(id('logo'), { hint: true })}
                />
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                  className="sr-only"
                  tabIndex={-1}
                  onChange={upload}
                />
                <Button variant="secondary" icon="upload" onClick={() => fileRef.current?.click()}>
                  {t('maintenance.upload')}
                </Button>
                {value.logoUrl ? (
                  <Button variant="ghost" onClick={() => set('logoUrl', '')}>
                    {t('maintenance.removeLogo')}
                  </Button>
                ) : null}
              </div>
            </Field>
            <Checkbox
              id={id('showHostname')}
              checked={value.showHostname}
              onChange={(e) => set('showHostname', e.target.checked)}
              label={t('maintenance.showHostname')}
            />
          </>
        ) : (
          <Field
            id={id('html')}
            label={t('maintenance.html')}
            hint={t('maintenance.htmlHint')}
            error={errors.html}
          >
            <Textarea
              id={id('html')}
              rows={16}
              value={value.html}
              spellCheck={false}
              className="font-mono text-xs"
              placeholder="<!doctype html>…"
              onChange={(e) => set('html', e.target.value)}
              aria-describedby={describedBy(id('html'), { hint: true })}
            />
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              onClick={() =>
                set(
                  'html',
                  renderMaintenancePage(
                    { ...value, mode: 'simple' },
                    {
                      hostname: '{{hostname}}',
                      until: null,
                    },
                  ),
                )
              }
            >
              {t('maintenance.startFromSimple')}
            </Button>
          </Field>
        )}
      </div>

      <div className="space-y-1.5">
        <p className="text-sm font-medium text-fg">{t('maintenance.preview')}</p>
        <iframe
          title={t('maintenance.preview')}
          sandbox=""
          srcDoc={preview}
          className="h-96 w-full rounded-lg border border-border bg-white lg:h-[28rem]"
        />
        <p className="text-xs text-fg-muted">{t('maintenance.previewHint')}</p>
      </div>
    </div>
  );
}

function ColorField({
  id,
  label,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field id={id} label={label} error={error}>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          aria-label={label}
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
          onChange={(e) => onChange(e.target.value)}
          className="size-10 shrink-0 cursor-pointer rounded-lg border border-border bg-surface p-1"
        />
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono"
          spellCheck={false}
        />
      </div>
    </Field>
  );
}
