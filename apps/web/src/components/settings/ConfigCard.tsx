/** Settings › Configuration: export to a JSON file, import one back (with a preview). */
import { useId, useRef, useState } from 'react';
import { configDocumentSchema, type ConfigDocument, type ConfigImportReport } from '@burrow/shared';
import { configApi } from '../../api/endpoints';
import { useImportConfig } from '../../api/queries';
import { t } from '../../i18n';
import { errorMessage } from '../../lib/errors';
import { Icon } from '../Icon';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { Dialog } from '../ui/Dialog';
import { Checkbox } from '../ui/Field';
import { useToast } from '../ui/Toast';

export function ConfigCard() {
  const uid = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const importConfig = useImportConfig();
  const toast = useToast();
  const [doc, setDoc] = useState<ConfigDocument | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [replace, setReplace] = useState(false);
  const [preview, setPreview] = useState<ConfigImportReport | null>(null);

  const mode = replace ? 'replace' : 'merge';

  async function onFile(file: File | undefined) {
    setFileError(null);
    setPreview(null);
    importConfig.reset();
    if (!file) return;
    try {
      const raw: unknown = JSON.parse(await file.text());
      const parsed = configDocumentSchema.safeParse(raw);
      if (!parsed.success) {
        setFileError(t('config.invalidFile', { error: parsed.error.issues[0]?.message ?? '' }));
        return;
      }
      setDoc(raw as ConfigDocument);
      setPreview(await importConfig.mutateAsync({ config: parsed.data, mode, dryRun: true }));
    } catch (error) {
      setFileError(error instanceof SyntaxError ? t('config.notJson') : errorMessage(error));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function refreshPreview(nextReplace: boolean) {
    setReplace(nextReplace);
    if (!doc) return;
    const report = await importConfig
      .mutateAsync({ config: doc, mode: nextReplace ? 'replace' : 'merge', dryRun: true })
      .catch(() => null);
    if (report) setPreview(report);
  }

  async function apply() {
    if (!doc) return;
    const report = await importConfig.mutateAsync({ config: doc, mode }).catch(() => null);
    if (!report) return;
    close();
    toast.show(
      report.sync && !report.sync.ok ? t('config.importedWithErrors') : t('config.imported'),
      report.sync && !report.sync.ok ? 'danger' : 'success',
    );
  }

  function close() {
    setDoc(null);
    setPreview(null);
    setReplace(false);
  }

  return (
    <Card>
      <CardHeader title={t('config.title')} description={t('config.hint')} />
      <CardBody className="space-y-3">
        {fileError ? <Alert tone="danger">{fileError}</Alert> : null}
        {importConfig.isError && !doc ? (
          <Alert tone="danger">{errorMessage(importConfig.error)}</Alert>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <a
            href={configApi.exportUrl}
            download
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium text-fg shadow-sm hover:bg-surface-2"
          >
            <Icon name="download" size={16} />
            {t('config.export')}
          </a>
          <Button
            variant="secondary"
            icon="upload"
            loading={importConfig.isPending && !doc}
            onClick={() => fileRef.current?.click()}
          >
            {t('config.import')}
          </Button>
          <input
            ref={fileRef}
            id={`${uid}-file`}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label={t('config.import')}
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        </div>
        <p className="text-xs text-fg-muted">{t('config.noSecrets')}</p>
      </CardBody>

      <Dialog
        open={doc !== null && preview !== null}
        onClose={close}
        busy={importConfig.isPending}
        title={t('config.previewTitle')}
        description={t('config.previewHint')}
        size="lg"
      >
        {preview ? (
          <div className="space-y-4 text-sm">
            {importConfig.isError ? (
              <Alert tone="danger">{errorMessage(importConfig.error)}</Alert>
            ) : null}
            <Checkbox
              id={`${uid}-replace`}
              checked={replace}
              onChange={(e) => void refreshPreview(e.target.checked)}
              label={t('config.replace')}
              description={t('config.replaceHint')}
            />
            <ReportList title={t('config.created')} items={preview.hosts.created} />
            <ReportList title={t('config.updated')} items={preview.hosts.updated} />
            <ReportList title={t('config.removed')} items={preview.hosts.removed} danger />
            <ReportList title={t('config.zonesEnabled')} items={preview.zonesEnabled} />
            <ReportList
              title={t('config.tunnelsAdded')}
              items={[...preview.tunnelsCreated, ...preview.tunnelsImported]}
            />
            <p className="text-fg-muted">
              {t('config.unchanged', { count: preview.hosts.unchanged.length })}
            </p>
            {preview.warnings.length > 0 ? (
              <Alert tone="warning" title={t('config.warnings')}>
                <ul className="list-disc pl-4">
                  {preview.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={close}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => void apply()} loading={importConfig.isPending}>
                {t('config.apply')}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </Card>
  );
}

function ReportList({
  title,
  items,
  danger,
}: {
  title: string;
  items: string[];
  danger?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className={danger ? 'font-medium text-danger' : 'font-medium'}>
        {title} ({items.length})
      </p>
      <ul className="mt-1 space-y-0.5 font-mono text-xs text-fg-muted">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}
