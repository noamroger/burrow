/** Settings › Drift detection: how often Burrow compares, and what it does. */
import { useCheckDrift, useDrift, useDriftSettings } from '../../api/queries';
import { useNow } from '../../hooks/useNow';
import { t } from '../../i18n';
import { errorMessage } from '../../lib/errors';
import { formatRelative } from '../../lib/format';
import { Button } from '../ui/Button';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { Switch } from '../ui/Switch';
import { useToast } from '../ui/Toast';

export function DriftCard() {
  const drift = useDrift();
  const check = useCheckDrift();
  const settings = useDriftSettings();
  const toast = useToast();
  const now = useNow();
  const report = drift.data;
  const onError = (error: unknown) => toast.show(errorMessage(error), 'danger');

  return (
    <Card>
      <CardHeader
        title={t('drift.settingsTitle')}
        description={
          report && report.intervalSeconds === 0
            ? t('drift.settingsHintManual')
            : t('drift.settingsHint', {
                minutes: Math.max(1, Math.round((report?.intervalSeconds ?? 300) / 60)),
              })
        }
      />
      <CardBody className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">{t('drift.autoRepair')}</p>
            <p className="text-xs text-fg-muted">{t('drift.autoRepairHint')}</p>
          </div>
          <Switch
            checked={report?.autoRepair ?? false}
            label={t('drift.autoRepair')}
            disabled={!report || settings.isPending}
            onChange={(autoRepair) => settings.mutate(autoRepair, { onError })}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-fg-muted">
            {report?.checkedAt
              ? t('drift.lastCheck', { when: formatRelative(report.checkedAt, now) })
              : t('drift.neverChecked')}
          </p>
          <Button
            variant="secondary"
            size="sm"
            icon="sync"
            loading={check.isPending}
            onClick={() =>
              check.mutate(undefined, {
                onSuccess: (r) =>
                  toast.show(
                    r.error
                      ? t('drift.checkFailed', { error: r.error })
                      : r.items.length === 0
                        ? t('drift.clean')
                        : t('drift.body', { count: r.items.length }),
                    r.error || r.items.length > 0 ? 'danger' : 'success',
                  ),
                onError,
              })
            }
          >
            {t('drift.checkNow')}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
