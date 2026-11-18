import type { ReactNode } from 'react';
import { t } from '../../i18n';
import { Button } from './Button';
import { Dialog } from './Dialog';

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  tone?: 'danger' | 'primary';
}

/** A small "are you sure?" dialog, used instead of window.confirm(). */
export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  loading,
  tone = 'danger',
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      size="sm"
      busy={loading}
      role="alertdialog"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            {t('common.cancel')}
          </Button>
          <Button variant={tone} onClick={onConfirm} loading={loading} data-autofocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
