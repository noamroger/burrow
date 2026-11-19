import { Link } from 'react-router';
import { BurrowArt } from '../components/EmptyState';
import { t } from '../i18n';

export function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <BurrowArt icon="tunnel" size={220} />
      <h1 className="mt-6 text-3xl font-semibold text-fg">{t('notFound.title')}</h1>
      <p className="mt-2 max-w-sm text-fg-muted">{t('notFound.body')}</p>
      <Link
        to="/"
        className="mt-6 inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium text-fg hover:border-soil-3 hover:bg-surface-2"
      >
        {t('notFound.back')}
      </Link>
    </div>
  );
}
