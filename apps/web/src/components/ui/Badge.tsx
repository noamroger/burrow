import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-fg-muted',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  accent: 'bg-accent-soft text-accent',
};

const dots: Record<Tone, string> = {
  neutral: 'bg-fg-muted',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  accent: 'bg-accent',
};

export function Badge({
  tone = 'neutral',
  dot = false,
  pulse = false,
  children,
  className,
}: {
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {dot ? <StatusDot tone={tone} pulse={pulse} /> : null}
      {children}
    </span>
  );
}

export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  tone: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} aria-hidden>
      {pulse ? (
        <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', dots[tone])} />
      ) : null}
      <span className={cn('relative inline-flex size-2 rounded-full', dots[tone])} />
    </span>
  );
}
