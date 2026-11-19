/**
 * Create / edit form for a proxy host.
 *
 * Validation uses the same zod schema as the server (`proxyHostInputSchema`),
 * so the user sees the server's rules before submitting. API errors are shown
 * at the top of the form; DNS_CONFLICT gets a dedicated explanation.
 */
import { useId, useMemo, useState, type FormEvent } from 'react';
import {
  ACCESS_SESSION_DURATIONS,
  buildHostname,
  findTemplate,
  proxyHostInputSchema,
  SERVICE_TEMPLATES,
  TEMPLATE_CATEGORIES,
  templateServiceUrl,
  type AccessSessionDuration,
  type ServiceTemplate,
  type ProxyHost,
  type ProxyHostInput,
  type TunnelSummary,
  type Zone,
} from '@burrow/shared';
import { isApiError } from '../api/client';
import { t } from '../i18n';
import { errorMessage } from '../lib/errors';
import { fieldErrors } from '../lib/zod';
import { Icon } from './Icon';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { Checkbox, describedBy, Field, Input, Select, Textarea } from './ui/Field';

export interface HostFormValues {
  subdomain: string;
  /** Burrow tunnel id as a string; '' keeps the current (or default) tunnel. */
  tunnelId: string;
  zoneId: string;
  service: string;
  path: string;
  enabled: boolean;
  noTLSVerify: boolean;
  httpHostHeader: string;
  originServerName: string;
  /** Cloudflare Access: require sign-in. */
  accessEnabled: boolean;
  /** Free text, one email per line (commas and spaces also work). */
  accessEmails: string;
  accessEmailDomains: string;
  accessSessionDuration: AccessSessionDuration;
  /** Template id, '' for none. */
  template: string;
}

/** Split a free-text list on new lines, commas, semicolons and spaces. */
export function splitList(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export const SERVICE_EXAMPLES = [
  { url: 'http://192.168.1.20:8080', label: 'host.serviceExampleLan' },
  { url: 'http://my-container:3000', label: 'host.serviceExampleDocker' },
  { url: 'http://100.64.0.10', label: 'host.serviceExampleTailscale' },
] as const;

export function initialValues(host: ProxyHost | undefined, zones: Zone[]): HostFormValues {
  if (host) {
    return {
      subdomain: host.subdomain,
      tunnelId: host.tunnelId !== null ? String(host.tunnelId) : '',
      zoneId: host.zoneId,
      service: host.service,
      path: host.path,
      enabled: host.enabled,
      noTLSVerify: host.options.noTLSVerify,
      httpHostHeader: host.options.httpHostHeader,
      originServerName: host.options.originServerName,
      accessEnabled: host.access.enabled,
      accessEmails: host.access.emails.join('\n'),
      accessEmailDomains: host.access.emailDomains.join('\n'),
      accessSessionDuration: host.access.sessionDuration,
      template: host.template ?? '',
    };
  }
  return {
    subdomain: '',
    tunnelId: '',
    zoneId: zones[0]?.id ?? '',
    service: '',
    path: '',
    enabled: true,
    noTLSVerify: false,
    httpHostHeader: '',
    originServerName: '',
    accessEnabled: false,
    accessEmails: '',
    accessEmailDomains: '',
    accessSessionDuration: '24h',
    template: '',
  };
}

/**
 * Apply a template: the service URL and origin options are replaced, the
 * subdomain is only filled when empty. An address the user already typed
 * (host or IP) is kept.
 */
export function applyTemplate(values: HostFormValues, template: ServiceTemplate): HostFormValues {
  const typed = /^[a-z+]+:\/\/([^/:]+)/i.exec(values.service.trim())?.[1];
  return {
    ...values,
    template: template.id,
    subdomain: values.subdomain.trim() ? values.subdomain : template.subdomain,
    service: templateServiceUrl(template, typed ?? template.container),
    noTLSVerify: template.options.noTLSVerify,
    httpHostHeader: template.options.httpHostHeader,
    originServerName: template.options.originServerName,
  };
}

export function toInput(values: HostFormValues): ProxyHostInput {
  return {
    subdomain: values.subdomain,
    ...(values.tunnelId ? { tunnelId: Number(values.tunnelId) } : {}),
    zoneId: values.zoneId,
    service: values.service,
    path: values.path,
    enabled: values.enabled,
    options: {
      noTLSVerify: values.noTLSVerify,
      httpHostHeader: values.httpHostHeader,
      originServerName: values.originServerName,
    },
    access: {
      enabled: values.accessEnabled,
      emails: splitList(values.accessEmails),
      emailDomains: splitList(values.accessEmailDomains),
      sessionDuration: values.accessSessionDuration,
    },
    template: values.template || null,
  };
}

/** True when saving this input changes the host's Cloudflare Access protection. */
export function accessChanged(before: ProxyHost | undefined, after: ProxyHost): boolean {
  const a = after.access;
  if (!before) return a.enabled;
  const b = before.access;
  if (!a.enabled && !b.enabled) return false;
  const same = (x: string[], y: string[]) =>
    x.length === y.length && [...x].sort().every((v, i) => v === [...y].sort()[i]);
  return (
    a.enabled !== b.enabled ||
    a.sessionDuration !== b.sessionDuration ||
    !same(a.emails, b.emails) ||
    !same(a.emailDomains, b.emailDomains) ||
    after.hostname !== before.hostname
  );
}

/** First error under a key prefix (`access.emails.2` → shown on the emails field). */
function errorUnder(errors: Record<string, string>, prefix: string): string | undefined {
  const key = Object.keys(errors).find((k) => k === prefix || k.startsWith(`${prefix}.`));
  return key ? errors[key] : undefined;
}

/** Field errors for the form, keyed like the zod paths (`options.httpHostHeader`). */
export function validateHost(values: HostFormValues): Record<string, string> {
  const result = proxyHostInputSchema.safeParse(toInput(values));
  if (result.success) return {};
  const errors = fieldErrors(result.error);
  // The schema's zoneId message is a regex failure: make it human.
  if (errors.zoneId) errors.zoneId = t('host.zoneRequired');
  if (errors.subdomain && values.subdomain.trim() === '')
    errors.subdomain = t('host.subdomainRequired');
  if (errors.service && values.service.trim() === '') errors.service = t('host.serviceRequired');
  return errors;
}

export interface HostFormProps {
  host?: ProxyHost;
  /** Zones the host can be published in (enabled zones). */
  zones: Zone[];
  /** Tunnels to choose from. The picker is shown only when there are several. */
  tunnels?: TunnelSummary[];
  onSubmit: (input: ProxyHostInput) => Promise<unknown>;
  onCancel: () => void;
}

export function HostForm({ host, zones, tunnels = [], onSubmit, onCancel }: HostFormProps) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const [values, setValues] = useState(() => initialValues(host, zones));
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<unknown>(null);

  // Editing a host whose zone was disabled since: keep it selectable.
  const zoneOptions = useMemo(() => {
    if (!host || zones.some((z) => z.id === host.zoneId)) return zones;
    return [...zones, { id: host.zoneId, name: host.zoneName, enabled: false, hostCount: 0 }];
  }, [host, zones]);

  const zone = zoneOptions.find((z) => z.id === values.zoneId);
  const errors = submitted ? validateHost(values) : {};
  const fqdn = zone ? buildHostname(values.subdomain || '', zone.name) : '';

  const set = <K extends keyof HostFormValues>(key: K, value: HostFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setServerError(null);
    if (Object.keys(validateHost(values)).length > 0) return;
    setSubmitting(true);
    try {
      await onSubmit(toInput(values));
    } catch (error) {
      setServerError(error);
    } finally {
      setSubmitting(false);
    }
  }

  const advancedSet =
    values.noTLSVerify || values.httpHostHeader !== '' || values.originServerName !== '';

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      {serverError ? <ServerError error={serverError} hostname={fqdn} /> : null}

      <TemplatePicker
        id={id('template')}
        value={values.template}
        onChange={(templateId) => {
          const template = findTemplate(templateId);
          setValues((v) => (template ? applyTemplate(v, template) : { ...v, template: '' }));
        }}
      />

      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium text-fg">{t('host.publicHostname')}</legend>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-start">
          <div>
            <label htmlFor={id('subdomain')} className="sr-only">
              {t('host.subdomain')}
            </label>
            <Input
              id={id('subdomain')}
              value={values.subdomain}
              onChange={(e) => set('subdomain', e.target.value)}
              placeholder={t('host.subdomainPlaceholder')}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={!!errors.subdomain}
              aria-describedby={describedBy(id('subdomain'), { error: errors.subdomain })}
            />
            {errors.subdomain ? (
              <p
                id={`${id('subdomain')}-error`}
                className="mt-1.5 text-xs font-medium text-danger"
                role="alert"
              >
                {errors.subdomain}
              </p>
            ) : null}
          </div>
          <span className="hidden h-10 items-center text-lg text-fg-muted sm:flex" aria-hidden>
            .
          </span>
          <div>
            <label htmlFor={id('zone')} className="sr-only">
              {t('host.zone')}
            </label>
            <Select
              id={id('zone')}
              value={values.zoneId}
              onChange={(e) => set('zoneId', e.target.value)}
              aria-invalid={!!errors.zoneId}
              aria-describedby={describedBy(id('zone'), { error: errors.zoneId })}
            >
              {zoneOptions.length === 0 ? <option value="">{t('host.noZones')}</option> : null}
              {zoneOptions.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </Select>
            {errors.zoneId ? (
              <p
                id={`${id('zone')}-error`}
                className="mt-1.5 text-xs font-medium text-danger"
                role="alert"
              >
                {errors.zoneId}
              </p>
            ) : null}
          </div>
        </div>
        <p
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted"
          aria-live="polite"
        >
          <span>{t('host.fqdnPreview')}</span>
          <code
            data-testid="fqdn-preview"
            className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[13px] text-fg"
          >
            https://{fqdn || '…'}
            {values.path ? (
              <span className="text-fg-muted">{values.path.replace(/^\^/, '')}</span>
            ) : null}
          </code>
        </p>
        <p className="text-xs text-fg-muted">{t('host.subdomainHint')}</p>
      </fieldset>

      <Field
        id={id('service')}
        label={t('host.service')}
        error={errors.service}
        hint={
          <span className="flex flex-wrap items-center gap-1.5">
            <span>{t('host.serviceExamples')}</span>
            {SERVICE_EXAMPLES.map((ex) => (
              <button
                key={ex.url}
                type="button"
                onClick={() => set('service', ex.url)}
                className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-fg hover:border-accent"
                title={t(ex.label)}
              >
                {ex.url}
              </button>
            ))}
          </span>
        }
      >
        <Input
          id={id('service')}
          value={values.service}
          onChange={(e) => set('service', e.target.value)}
          placeholder="http://192.168.1.20:8080"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="font-mono"
          aria-invalid={!!errors.service}
          aria-describedby={describedBy(id('service'), { hint: true, error: errors.service })}
        />
      </Field>

      {tunnels.length > 1 ? (
        <Field id={id('tunnel')} label={t('host.tunnel')} hint={t('host.tunnelHint')}>
          <Select
            id={id('tunnel')}
            value={values.tunnelId || String(tunnels.find((x) => x.isDefault)?.id ?? '')}
            onChange={(e) => set('tunnelId', e.target.value)}
            aria-describedby={describedBy(id('tunnel'), { hint: true })}
          >
            {tunnels.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
                {x.isDefault ? ` (${t('tunnels.default')})` : ''}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <Field
        id={id('path')}
        label={t('host.path')}
        aside={t('common.optional')}
        error={errors.path}
        hint={t('host.pathHint')}
      >
        <Input
          id={id('path')}
          value={values.path}
          onChange={(e) => set('path', e.target.value)}
          placeholder="^/api"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          aria-describedby={describedBy(id('path'), { hint: true, error: errors.path })}
        />
      </Field>

      <fieldset className="space-y-4 rounded-lg border border-border px-3.5 py-3.5">
        <legend className="sr-only">{t('host.access.legend')}</legend>
        <Checkbox
          id={id('accessEnabled')}
          checked={values.accessEnabled}
          onChange={(e) => set('accessEnabled', e.target.checked)}
          label={
            <span className="inline-flex items-center gap-1.5">
              <Icon name="shield" size={14} className="text-accent" />
              {t('host.access.enabled')}
            </span>
          }
          description={t('host.access.enabledHint')}
        />
        {values.accessEnabled ? (
          <div className="space-y-4 border-t border-border pt-4">
            <Field
              id={id('accessEmails')}
              label={t('host.access.emails')}
              hint={t('host.access.emailsHint')}
              error={errorUnder(errors, 'access.emails')}
            >
              <Textarea
                id={id('accessEmails')}
                value={values.accessEmails}
                onChange={(e) => set('accessEmails', e.target.value)}
                placeholder={'me@example.com\nfriend@example.net'}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                rows={3}
                className="font-mono"
                aria-invalid={!!errorUnder(errors, 'access.emails')}
                aria-describedby={describedBy(id('accessEmails'), {
                  hint: true,
                  error: errorUnder(errors, 'access.emails'),
                })}
              />
            </Field>
            <Field
              id={id('accessEmailDomains')}
              label={t('host.access.emailDomains')}
              aside={t('common.optional')}
              hint={t('host.access.emailDomainsHint')}
              error={errorUnder(errors, 'access.emailDomains')}
            >
              <Input
                id={id('accessEmailDomains')}
                value={values.accessEmailDomains}
                onChange={(e) => set('accessEmailDomains', e.target.value)}
                placeholder="family.example"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
                aria-invalid={!!errorUnder(errors, 'access.emailDomains')}
                aria-describedby={describedBy(id('accessEmailDomains'), {
                  hint: true,
                  error: errorUnder(errors, 'access.emailDomains'),
                })}
              />
            </Field>
            <Field
              id={id('accessSessionDuration')}
              label={t('host.access.sessionDuration')}
              hint={t('host.access.sessionDurationHint')}
            >
              <Select
                id={id('accessSessionDuration')}
                value={values.accessSessionDuration}
                onChange={(e) =>
                  set('accessSessionDuration', e.target.value as AccessSessionDuration)
                }
                aria-describedby={describedBy(id('accessSessionDuration'), { hint: true })}
              >
                {ACCESS_SESSION_DURATIONS.map((d) => (
                  <option key={d} value={d}>
                    {t(`host.access.duration.${d}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="text-xs leading-relaxed text-fg-muted">
              {t('host.access.wholeHostname', { hostname: fqdn || '…' })}
            </p>
            <Alert tone="info" title={t('host.access.delayTitle')}>
              {t('host.access.delayBody')}
            </Alert>
          </div>
        ) : null}
      </fieldset>

      <details className="group rounded-lg border border-border" open={advancedSet || undefined}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2.5 text-sm font-medium text-fg select-none">
          <span>{t('host.advanced')}</span>
          <Icon
            name="chevronDown"
            className="text-fg-muted transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="space-y-4 border-t border-border px-3.5 py-4">
          <Checkbox
            id={id('noTLSVerify')}
            checked={values.noTLSVerify}
            onChange={(e) => set('noTLSVerify', e.target.checked)}
            label={<code className="font-mono">noTLSVerify</code>}
            description={t('host.noTLSVerifyHint')}
          />
          <Field
            id={id('httpHostHeader')}
            label={<code className="font-mono">httpHostHeader</code>}
            hint={t('host.httpHostHeaderHint')}
            error={errors['options.httpHostHeader']}
          >
            <Input
              id={id('httpHostHeader')}
              value={values.httpHostHeader}
              onChange={(e) => set('httpHostHeader', e.target.value)}
              placeholder="app.internal"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={describedBy(id('httpHostHeader'), { hint: true })}
            />
          </Field>
          <Field
            id={id('originServerName')}
            label={<code className="font-mono">originServerName</code>}
            hint={t('host.originServerNameHint')}
            error={errors['options.originServerName']}
          >
            <Input
              id={id('originServerName')}
              value={values.originServerName}
              onChange={(e) => set('originServerName', e.target.value)}
              placeholder="app.internal"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={describedBy(id('originServerName'), { hint: true })}
            />
          </Field>
          <Checkbox
            id={id('enabled')}
            checked={values.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
            label={t('host.enabled')}
            description={t('host.enabledHint')}
          />
        </div>
      </details>

      <div className="sticky -bottom-5 -mx-5 -mb-5 flex flex-col-reverse gap-2 border-t border-border bg-surface px-5 py-3.5 sm:flex-row sm:justify-end sm:rounded-b-2xl">
        <Button variant="secondary" onClick={onCancel} disabled={submitting}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" loading={submitting}>
          {host ? t('host.save') : t('host.create')}
        </Button>
      </div>
    </form>
  );
}

function ServerError({ error, hostname }: { error: unknown; hostname: string }) {
  if (isApiError(error, 'DNS_CONFLICT')) {
    return (
      <Alert tone="danger" title={t('host.dnsConflictTitle', { hostname })}>
        <p>{t('host.dnsConflictBody')}</p>
        {error.message ? <p className="mt-1 text-xs opacity-80">{error.message}</p> : null}
      </Alert>
    );
  }
  if (isApiError(error, 'ACCESS_CONFLICT')) {
    return (
      <Alert tone="danger" title={t('host.access.conflictTitle', { hostname })}>
        {error.message}
      </Alert>
    );
  }
  if (isApiError(error, 'CONFLICT')) {
    return (
      <Alert tone="danger" title={t('host.conflictTitle')}>
        {error.message}
      </Alert>
    );
  }
  return (
    <Alert tone="danger" title={t('host.saveFailed')}>
      {errorMessage(error)}
    </Alert>
  );
}

function TemplatePicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (templateId: string) => void;
}) {
  const template = findTemplate(value);
  return (
    <div className="space-y-2.5">
      <Field id={id} label={t('host.template.label')} aside={t('common.optional')}>
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t('host.template.none')}</option>
          {TEMPLATE_CATEGORIES.map((category) => {
            const items = SERVICE_TEMPLATES.filter((x) => x.category === category);
            if (items.length === 0) return null;
            return (
              <optgroup key={category} label={t(`host.template.category.${category}`)}>
                {items.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </Select>
      </Field>
      {template ? <TemplateNotes template={template} /> : null}
    </div>
  );
}

function TemplateNotes({ template }: { template: ServiceTemplate }) {
  const facts = [
    template.websockets ? t('host.template.websockets') : null,
    template.options.noTLSVerify ? t('host.template.noTLSVerify') : null,
    template.recommendAccess ? t('host.template.recommendAccess') : null,
  ].filter((x): x is string => !!x);
  if (facts.length === 0 && template.notes.length === 0) {
    return <p className="text-xs text-fg-muted">{template.description}</p>;
  }
  return (
    <Alert tone="info" title={t('host.template.notesTitle', { name: template.name })}>
      <ul className="list-disc space-y-1 pl-4" data-testid="template-notes">
        {[...facts, ...template.notes].map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </Alert>
  );
}
