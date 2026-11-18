import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
        <Icon name={icon} size={26} />
      </div>
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {children ? (
        <div className="mt-2 max-w-md text-sm leading-relaxed text-fg-muted">{children}</div>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
