import { t } from '../../i18n';

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className="animate-spin"
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Centered spinner for a page or a card that is loading. */
export function PageSpinner() {
  return (
    <div className="flex min-h-40 items-center justify-center text-fg-muted">
      <Spinner size={24} label={t('common.loading')} />
    </div>
  );
}
