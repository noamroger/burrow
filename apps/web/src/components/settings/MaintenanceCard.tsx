/** Settings › Maintenance page: the page hosts in maintenance mode show by default. */
import { useState } from 'react';
import { maintenancePageSchema, type MaintenancePage } from '@burrow/shared';
import { useMaintenancePage, useSaveMaintenancePage } from '../../api/queries';
import { t } from '../../i18n';
import { errorMessage } from '../../lib/errors';
import { fieldErrors } from '../../lib/zod';
import { MaintenancePageEditor } from '../MaintenancePageEditor';
import { Button } from '../ui/Button';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { PageSpinner } from '../ui/Spinner';
import { useToast } from '../ui/Toast';

export function MaintenanceCard() {
  const page = useMaintenancePage();
  return page.data ? (
    <MaintenanceCardForm saved={page.data} />
  ) : (
    <Card>
      <CardHeader
        title={t('maintenance.cardTitle')}
        description={t('maintenance.cardDescription')}
      />
      <CardBody>
        <PageSpinner />
      </CardBody>
    </Card>
  );
}

function MaintenanceCardForm({ saved }: { saved: MaintenancePage }) {
  const save = useSaveMaintenancePage();
  const toast = useToast();
  const [draft, setDraft] = useState<MaintenancePage>(saved);

  const parsed = maintenancePageSchema.safeParse(draft);
  const errors = parsed.success ? {} : fieldErrors(parsed.error);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  return (
    <Card>
      <CardHeader
        title={t('maintenance.cardTitle')}
        description={t('maintenance.cardDescription')}
        actions={
          <Button
            size="sm"
            disabled={!dirty || !parsed.success}
            loading={save.isPending}
            onClick={() =>
              save.mutate(draft, {
                onSuccess: (page) => {
                  setDraft(page);
                  toast.show(t('maintenance.saved'), 'success');
                },
                onError: (error) => toast.show(errorMessage(error), 'danger'),
              })
            }
          >
            {t('maintenance.save')}
          </Button>
        }
      />
      <CardBody>
        <MaintenancePageEditor value={draft} onChange={setDraft} errors={errors} />
      </CardBody>
    </Card>
  );
}
