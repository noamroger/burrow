/** Settings › Homepage: the dashboard of the exposed services, private or public. */
import { useId, useState, type FormEvent } from 'react';
import { homepageSettingsSchema, type HomepageSettings } from '@burrow/shared';
import { useHomepageSettings, useSaveHomepageSettings } from '../../api/queries';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { fieldErrors } from '../../lib/zod';
import { Icon } from '../Icon';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { Checkbox, Field, Input, describedBy } from '../ui/Field';
import { PageSpinner } from '../ui/Spinner';
import { Switch } from '../ui/Switch';
import { useToast } from '../ui/Toast';

/** Where the homepage can be opened: the public hostname when set, else this Burrow. */
export function homepageUrl(settings: HomepageSettings, origin: string): string {
  return settings.publicHostname ? `https://${settings.publicHostname}/home` : `${origin}/home`;
}

export function HomepageCard() {
  const settings = useHomepageSettings();
  return (
    <Card>
      <CardHeader title={t('homepage.title')} description={t('homepage.hint')} />
      <CardBody>
        {settings.isError ? (
          <Alert tone="danger">{errorMessage(settings.error)}</Alert>
        ) : !settings.data ? (
          <PageSpinner />
        ) : (
          // Remounted with the saved values after each save.
          <HomepageForm key={JSON.stringify(settings.data)} initial={settings.data} />
        )}
      </CardBody>
    </Card>
  );
}

function HomepageForm({ initial }: { initial: HomepageSettings }) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const save = useSaveHomepageSettings();
  const toast = useToast();
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = <K extends keyof HomepageSettings>(key: K, value: HomepageSettings[K]) =>
    setValues((v) => ({ ...v, [key]: value }));
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);

  function submit(event: FormEvent) {
    event.preventDefault();
    const input = {
      ...values,
      publicHostname: values.visibility === 'public' ? values.publicHostname : '',
    };
    const parsed = homepageSettingsSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    save.mutate(parsed.data, {
      onSuccess: () => toast.show(t('homepage.saved'), 'success'),
      onError: (error) => toast.show(errorMessage(error), 'danger'),
    });
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">{t('homepage.enabled')}</p>
          <p className="text-xs text-fg-muted">{t('homepage.enabledHint')}</p>
        </div>
        <Switch
          checked={values.enabled}
          label={t('homepage.enabled')}
          onChange={(enabled) => set('enabled', enabled)}
        />
      </div>

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-fg">{t('homepage.visibility')}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(['private', 'public'] as const).map((v) => (
            <label
              key={v}
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-colors',
                values.visibility === v
                  ? 'border-accent bg-accent-soft/50'
                  : 'border-border hover:bg-surface-2/60',
              )}
            >
              <input
                type="radio"
                name={id('visibility')}
                value={v}
                checked={values.visibility === v}
                onChange={() => set('visibility', v)}
                className="mt-0.5 accent-[var(--accent)]"
              />
              <span>
                <span className="block font-medium">{t(`homepage.visibility.${v}`)}</span>
                <span className="block text-xs text-fg-muted">
                  {t(`homepage.visibility.${v}Hint`)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={id('title')} label={t('homepage.pageTitle')} error={errors.title}>
          <Input
            id={id('title')}
            value={values.title}
            onChange={(e) => set('title', e.target.value)}
            maxLength={60}
            aria-invalid={!!errors.title}
          />
        </Field>
        <Field id={id('subtitle')} label={t('homepage.subtitle')} aside={t('common.optional')}>
          <Input
            id={id('subtitle')}
            value={values.subtitle}
            onChange={(e) => set('subtitle', e.target.value)}
            maxLength={140}
          />
        </Field>
      </div>

      <Checkbox
        id={id('showStatus')}
        checked={values.showStatus}
        onChange={(e) => set('showStatus', e.target.checked)}
        label={t('homepage.showStatus')}
        description={t('homepage.showStatusHint')}
      />

      {values.visibility === 'public' ? (
        <Field
          id={id('publicHostname')}
          label={t('homepage.publicHostname')}
          aside={t('common.optional')}
          hint={t('homepage.publicHostnameHint')}
          error={errors.publicHostname}
        >
          <Input
            id={id('publicHostname')}
            value={values.publicHostname}
            onChange={(e) => set('publicHostname', e.target.value)}
            placeholder="home.example.com"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
            aria-invalid={!!errors.publicHostname}
            aria-describedby={describedBy(id('publicHostname'), {
              hint: true,
              error: errors.publicHostname,
            })}
          />
        </Field>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        {initial.enabled ? (
          <a
            href={homepageUrl(initial, window.location.origin)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
          >
            {t('homepage.open')}
            <Icon name="externalLink" size={14} />
          </a>
        ) : (
          <span />
        )}
        <Button type="submit" size="sm" loading={save.isPending} disabled={!dirty}>
          {t('homepage.save')}
        </Button>
      </div>
    </form>
  );
}
