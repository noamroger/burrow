import { Link } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { t } from '../i18n';

export function NotFoundPage() {
  return (
    <EmptyState
      icon="tunnel"
      title={t('notFound.title')}
      action={
        <Link to="/" className="font-medium text-accent underline underline-offset-2">
          {t('notFound.back')}
        </Link>
      }
    >
      {t('notFound.body')}
    </EmptyState>
  );
}
