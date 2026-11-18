import { useId, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * CSS-only tooltip shown on hover and keyboard focus. The trigger is wrapped
 * in a focusable element and linked with `aria-describedby`, so screen readers
 * announce the content too.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom';
  className?: string;
}) {
  const id = useId();
  return (
    <span className={cn('group relative inline-flex', className)}>
      <span tabIndex={0} aria-describedby={id} className="inline-flex rounded-full">
        {children}
      </span>
      <span
        id={id}
        role="tooltip"
        className={cn(
          'pointer-events-none invisible absolute left-1/2 z-30 w-max max-w-72 -translate-x-1/2 rounded-md',
          'bg-fg px-2.5 py-1.5 text-xs leading-snug font-normal break-words whitespace-normal text-bg opacity-0 shadow-lg',
          'transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100',
          side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
        )}
      >
        {content}
      </span>
    </span>
  );
}
