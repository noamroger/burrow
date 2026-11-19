import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Icon, type IconName } from '../Icon';
import type { Tone } from './Badge';

const styles: Partial<Record<Tone, { box: string; icon: IconName }>> = {
  info: { box: 'border-info/30 bg-info-soft text-fg', icon: 'info' },
  warning: { box: 'border-warning/30 bg-warning-soft text-fg', icon: 'alert' },
  danger: { box: 'border-danger/30 bg-danger-soft text-fg', icon: 'alert' },
  success: { box: 'border-success/30 bg-success-soft text-fg', icon: 'check' },
};

const iconColor: Partial<Record<Tone, string>> = {
  info: 'text-info',
  warning: 'text-warning',
  danger: 'text-danger',
  success: 'text-success',
};

export function Alert({
  tone = 'info',
  title,
  children,
  className,
  action,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  const style = styles[tone]!;
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-xl border px-4 py-3.5 text-sm', style.box, className)}
    >
      <Icon name={style.icon} size={18} className={cn('mt-px shrink-0', iconColor[tone])} />
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? (
          <div className="text-fg-muted [&_a]:text-accent [&_a]:underline">{children}</div>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
