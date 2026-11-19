/** Activity: the audit log, with filters and undo. */
import { useId, useState } from 'react';
import { AUDIT_CATEGORIES, type AuditCategory, type AuditEntry } from '@burrow/shared';
import { useAuditLog, useUndoChange } from '../api/queries';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Input, Select } from '../components/ui/Field';
import { PageSpinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import { useToast } from '../components/ui/Toast';
import { useNow } from '../hooks/useNow';
import { en } from '../i18n/en';
import { t, type MessageKey } from '../i18n';
import { errorMessage } from '../lib/errors';
import { formatDateTime, formatRelative } from '../lib/format';

/** Human label of an action, falling back to its code (`host.update`). */
export function actionLabel(action: string): string {
  const key = `audit.action.${action}`;
  return key in en ? t(key as MessageKey) : action;
}

function categoryLabel(category: string): string {
  const key = `audit.category.${category}`;
  return key in en ? t(key as MessageKey) : category;
}

/** Short display of a value in the change list. */
function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.map(show).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** "Last N days" filter, computed once when chosen (a stable query key). */
function sinceIso(days: string): string | undefined {
  if (!days) return undefined;
  return new Date(Date.now() - Number(days) * 24 * 3600 * 1000).toISOString();
}

export function ActivityPage() {
  const uid = useId();
  const [category, setCategory] = useState<AuditCategory | ''>('');
  const [search, setSearch] = useState('');
  const [days, setDays] = useState('');
  const [from, setFrom] = useState<string | undefined>(undefined);
  const [onlyUndoable, setOnlyUndoable] = useState(false);
  const [confirm, setConfirm] = useState<AuditEntry | null>(null);
  const undo = useUndoChange();
  const toast = useToast();
  const now = useNow(60_000);

  const log = useAuditLog({
    category: category || undefined,
    q: search.trim() || undefined,
    from,
    undoable: onlyUndoable ? 'true' : undefined,
  });
  const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];
  const filtered = !!(category || search.trim() || days || onlyUndoable);

  return (
    <>
      <PageHeader title={t('audit.title')} description={t('audit.description')} />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <label htmlFor={`${uid}-q`} className="sr-only">
            {t('audit.search')}
          </label>
          <Input
            id={`${uid}-q`}
            type="search"
            value={search}
            placeholder={t('audit.search')}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={`${uid}-cat`} className="sr-only">
            {t('audit.category')}
          </label>
          <Select
            id={`${uid}-cat`}
            value={category}
            onChange={(e) => setCategory(e.target.value as AuditCategory | '')}
          >
            <option value="">{t('audit.allCategories')}</option>
            {AUDIT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor={`${uid}-days`} className="sr-only">
            {t('audit.period')}
          </label>
          <Select
            id={`${uid}-days`}
            value={days}
            onChange={(e) => {
              setDays(e.target.value);
              setFrom(sinceIso(e.target.value));
            }}
          >
            <option value="">{t('audit.anyTime')}</option>
            <option value="1">{t('audit.last24h')}</option>
            <option value="7">{t('audit.last7d')}</option>
            <option value="30">{t('audit.last30d')}</option>
          </Select>
        </div>
        <div className="flex h-10 items-center gap-2 text-sm">
          <Switch
            id={`${uid}-undo`}
            checked={onlyUndoable}
            onChange={setOnlyUndoable}
            label={t('audit.onlyUndoable')}
          />
          <label htmlFor={`${uid}-undo`} className="text-fg-muted">
            {t('audit.onlyUndoable')}
          </label>
        </div>
      </div>

      <Card>
        {log.isPending ? (
          <PageSpinner />
        ) : log.isError ? (
          <div className="p-4">
            <Alert tone="danger">{errorMessage(log.error)}</Alert>
          </div>
        ) : entries.length === 0 ? (
          <EmptyState icon="history" title={filtered ? t('audit.noMatch') : t('audit.empty')}>
            {filtered ? null : t('audit.emptyHint')}
          </EmptyState>
        ) : (
          <ol className="divide-y divide-border">
            {entries.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                now={now}
                undoing={undo.isPending && undo.variables === entry.id}
                onUndo={() => setConfirm(entry)}
              />
            ))}
          </ol>
        )}
      </Card>

      {log.hasNextPage ? (
        <div className="mt-4 flex justify-center">
          <Button
            variant="secondary"
            loading={log.isFetchingNextPage}
            onClick={() => void log.fetchNextPage()}
          >
            {t('audit.more')}
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirm !== null}
        tone="primary"
        title={t('audit.undoTitle')}
        description={
          confirm
            ? t('audit.undoBody', {
                action: actionLabel(confirm.action),
                target: confirm.target ?? '',
              })
            : ''
        }
        confirmLabel={t('audit.undo')}
        loading={undo.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() =>
          confirm &&
          undo.mutate(confirm.id, {
            onSuccess: () => {
              setConfirm(null);
              toast.show(t('audit.undone'));
            },
            onError: (error) => {
              setConfirm(null);
              toast.show(errorMessage(error), 'danger');
            },
          })
        }
      />
    </>
  );
}

function EntryRow({
  entry,
  now,
  undoing,
  onUndo,
}: {
  entry: AuditEntry;
  now: number;
  undoing: boolean;
  onUndo: () => void;
}) {
  const [open, setOpen] = useState(false);
  const changes = entry.details?.changes ?? [];
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
      <time
        dateTime={entry.createdAt}
        title={formatDateTime(entry.createdAt)}
        className="shrink-0 text-xs text-fg-muted tabular-nums sm:w-28 sm:pt-0.5"
      >
        {formatRelative(entry.createdAt, now)}
      </time>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium">{actionLabel(entry.action)}</span>
          {entry.target ? (
            <code className="font-mono text-xs break-all text-fg">{entry.target}</code>
          ) : null}
          {entry.undoneAt ? <Badge tone="neutral">{t('audit.undoneBadge')}</Badge> : null}
          {entry.revertOf ? (
            <Badge tone="info">{t('audit.revertOf', { id: entry.revertOf })}</Badge>
          ) : null}
        </p>
        <p className="text-xs text-fg-muted">
          <Icon name="user" size={12} className="mr-1 inline align-[-1px]" />
          {entry.actor.label}
          {entry.actor.ip ? ` · ${entry.actor.ip}` : ''}
          {entry.details?.note ? ` · ${entry.details.note}` : ''}
          <span className="sr-only"> · #{entry.id}</span>
        </p>
        {changes.length > 0 ? (
          <div>
            <button
              type="button"
              className="text-xs font-medium text-accent underline-offset-2 hover:underline"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {open
                ? t('audit.hideChanges')
                : t(changes.length === 1 ? 'audit.showChange' : 'audit.showChanges', {
                    count: changes.length,
                  })}
            </button>
            {open ? (
              <dl className="mt-2 space-y-1 rounded-lg bg-surface-2 p-2.5 text-xs">
                {changes.map((c) => (
                  <div key={c.field} className="grid gap-1 sm:grid-cols-[10rem_1fr]">
                    <dt className="font-mono text-fg-muted">{c.field}</dt>
                    <dd className="min-w-0 break-all">
                      <span className="text-danger line-through decoration-danger/50">
                        {show(c.before)}
                      </span>{' '}
                      <span aria-hidden>→</span>
                      <span className="sr-only">{t('audit.becomes')}</span>{' '}
                      <span className="text-success">{show(c.after)}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        ) : null}
      </div>
      {entry.undoable ? (
        <Button
          size="sm"
          variant="secondary"
          icon="undo"
          className="self-start"
          loading={undoing}
          onClick={onUndo}
        >
          {t('audit.undo')}
        </Button>
      ) : null}
    </li>
  );
}
