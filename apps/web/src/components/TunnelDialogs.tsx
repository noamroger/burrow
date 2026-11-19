/**
 * Dialogs of the Tunnels page: create a new tunnel, import an existing one.
 */
import { useId, useState, type FormEvent } from 'react';
import { createTunnelSchema, type ImportTunnelResult } from '@burrow/shared';
import { useAvailableTunnels, useCreateTunnel, useImportTunnel } from '../api/queries';
import { t } from '../i18n';
import { errorMessage } from '../lib/errors';
import { fieldErrors } from '../lib/zod';
import { TunnelStatusBadge } from './TunnelStatusBadge';
import { Alert } from './ui/Alert';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Checkbox, describedBy, Field, Input } from './ui/Field';
import { PageSpinner } from './ui/Spinner';

export function CreateTunnelDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const uid = useId();
  const create = useCreateTunnel();
  const [name, setName] = useState('');
  const [runConnector, setRunConnector] = useState(true);
  const [error, setError] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = createTunnelSchema.safeParse({ name, runConnector });
    if (!parsed.success) {
      setError(fieldErrors(parsed.error).name);
      return;
    }
    setError(undefined);
    const tunnel = await create.mutateAsync(parsed.data).catch(() => null);
    if (!tunnel) return;
    setName('');
    onCreated(tunnel.id);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={create.isPending}
      title={t('tunnels.createTitle')}
      description={t('tunnels.createHint')}
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        {create.isError ? <Alert tone="danger">{errorMessage(create.error)}</Alert> : null}
        <Field id={`${uid}-name`} label={t('tunnels.name')} error={error}>
          <Input
            id={`${uid}-name`}
            value={name}
            placeholder="homelab-2"
            onChange={(e) => setName(e.target.value)}
            aria-invalid={!!error}
            aria-describedby={describedBy(`${uid}-name`, { error })}
          />
        </Field>
        <Checkbox
          id={`${uid}-run`}
          checked={runConnector}
          onChange={(e) => setRunConnector(e.target.checked)}
          label={t('tunnels.runConnector')}
          description={t('tunnels.runConnectorHint')}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={create.isPending}>
            {t('tunnels.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ImportTunnelDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (id: number) => void;
}) {
  const uid = useId();
  const available = useAvailableTunnels(open);
  const importTunnel = useImportTunnel();
  const [selected, setSelected] = useState<string | null>(null);
  const [importRoutes, setImportRoutes] = useState(true);
  const [runConnector, setRunConnector] = useState(false);
  const [result, setResult] = useState<ImportTunnelResult | null>(null);

  const close = () => {
    setResult(null);
    setSelected(null);
    importTunnel.reset();
    onClose();
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    const res = await importTunnel
      .mutateAsync({ cfId: selected, importRoutes, runConnector })
      .catch(() => null);
    if (res) setResult(res);
  }

  if (result) {
    const imported = result.routes.filter((r) => !r.skipped);
    const skipped = result.routes.filter((r) => r.skipped);
    return (
      <Dialog
        open={open}
        onClose={close}
        title={t('tunnels.importDone', { name: result.tunnel.name })}
        size="lg"
      >
        <div className="space-y-4 text-sm">
          <p>
            {t('tunnels.importSummary', { imported: imported.length, skipped: skipped.length })}
          </p>
          {result.routes.length > 0 ? (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {result.routes.map((r) => (
                <li key={`${r.hostname}|${r.path}`} className="flex flex-col gap-1 px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {r.hostname}
                      {r.path ? <span className="text-fg-muted"> {r.path}</span> : null}
                    </span>
                    <Badge tone={r.skipped ? 'warning' : 'success'}>
                      {r.skipped ? t('tunnels.routeSkipped') : t('tunnels.routeImported')}
                    </Badge>
                  </div>
                  <code className="font-mono text-xs text-fg-muted">{r.service}</code>
                  {r.skipped ? <span className="text-xs text-fg-muted">{r.skipped}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex justify-end">
            <Button
              onClick={() => {
                const id = result.tunnel.id;
                close();
                onImported(id);
              }}
            >
              {t('common.close')}
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      busy={importTunnel.isPending}
      title={t('tunnels.importTitle')}
      description={t('tunnels.importHint')}
      size="lg"
    >
      <form onSubmit={submit} className="space-y-4">
        {importTunnel.isError ? (
          <Alert tone="danger">{errorMessage(importTunnel.error)}</Alert>
        ) : null}
        {available.isPending ? (
          <PageSpinner />
        ) : available.isError ? (
          <Alert tone="danger">{errorMessage(available.error)}</Alert>
        ) : available.data.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('tunnels.importNone')}</p>
        ) : (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">{t('tunnels.importPick')}</legend>
            {available.data.map((tunnel) => {
              const disabled = tunnel.configSrc !== 'cloudflare';
              return (
                <label
                  key={tunnel.cfId}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-4 py-3 has-[:checked]:border-accent has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
                >
                  <input
                    type="radio"
                    name={`${uid}-tunnel`}
                    value={tunnel.cfId}
                    disabled={disabled}
                    checked={selected === tunnel.cfId}
                    onChange={() => setSelected(tunnel.cfId)}
                    className="mt-1 accent-[var(--accent)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{tunnel.name}</span>
                      <TunnelStatusBadge status={tunnel.status} />
                    </span>
                    <span className="block text-xs text-fg-muted">
                      {disabled
                        ? t('tunnels.importLocal')
                        : tunnel.routeCount === null
                          ? t('tunnels.importRoutesUnknown')
                          : t('tunnels.importRouteCount', { count: tunnel.routeCount })}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}
        <Checkbox
          id={`${uid}-routes`}
          checked={importRoutes}
          onChange={(e) => setImportRoutes(e.target.checked)}
          label={t('tunnels.importRoutes')}
          description={t('tunnels.importRoutesHint')}
        />
        <Checkbox
          id={`${uid}-run`}
          checked={runConnector}
          onChange={(e) => setRunConnector(e.target.checked)}
          label={t('tunnels.runConnector')}
          description={t('tunnels.importRunHint')}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            icon="download"
            disabled={!selected}
            loading={importTunnel.isPending}
          >
            {t('tunnels.import')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
