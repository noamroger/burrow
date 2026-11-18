import { t } from '../i18n';
import { cn } from '../lib/cn';

/** The Burrow mark: a tunnel entrance in a mound of earth (same as public/logo.svg). */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      aria-hidden
      focusable="false"
    >
      <rect width="64" height="64" rx="14" fill="#B5562F" />
      <path
        d="M0 46c10-3 21-4 32-4s22 1 32 4v4c0 7.7-6.3 14-14 14H14C6.3 64 0 57.7 0 50z"
        fill="#8E3F1F"
      />
      <path d="M16 46V35c0-8.8 7.2-16 16-16s16 7.2 16 16v11z" fill="#2A1A12" />
      <path d="M22 46V36c0-5.5 4.5-10 10-10s10 4.5 10 10v10z" fill="#1A0F0A" />
      <circle cx="32" cy="38" r="3.2" fill="#F4C27A" />
      <path d="M8 46h48" stroke="#F3E3D3" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ className, size = 30 }: { className?: string; size?: number }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark size={size} />
      <span className="text-lg font-semibold tracking-tight">{t('app.name')}</span>
    </span>
  );
}
