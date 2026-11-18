import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-xl border border-border bg-surface shadow-sm', className)}>
      {children}
    </section>
  );
}

/** Card header: title, optional description, optional actions on the right. */
export function CardHeader({
  title,
  description,
  actions,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  id?: string;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
      <div className="min-w-0">
        <h2 id={id} className="text-base font-semibold text-fg">
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-sm text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-4 py-4 sm:px-5', className)}>{children}</div>;
}
