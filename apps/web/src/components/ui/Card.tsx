import { createContext, useContext, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * A plain surface with a hairline border. No drop shadow: cards sit flat on the
 * page so that dialogs and toasts, which do cast one, read as "above" it.
 */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-2xl border border-border bg-surface', className)}>
      {children}
    </section>
  );
}

/**
 * Heading level of card titles. Cards are h2 on most pages; inside a titled
 * group (Settings), the group provides 3.
 */
export const CardHeadingLevel = createContext<2 | 3>(2);

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
  const Heading = useContext(CardHeadingLevel) === 3 ? 'h3' : 'h2';
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 pb-1 sm:px-6 sm:pt-5">
      <div className="min-w-0">
        <Heading id={id} className="text-lg font-semibold text-fg">
          {title}
        </Heading>
        {description ? (
          <p className="mt-1 max-w-[68ch] text-sm leading-relaxed text-fg-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-4 py-4 sm:px-6 sm:pb-6', className)}>{children}</div>;
}
