import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { cn } from '../../lib/cn';
import { Icon } from '../Icon';

/** ids of the hint and error elements of a field, for `aria-describedby`. */
export function describedBy(
  id: string,
  opts: { hint?: ReactNode; error?: string | null },
): string | undefined {
  const ids = [opts.hint ? `${id}-hint` : null, opts.error ? `${id}-error` : null].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

export interface FieldProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  /** Shown right of the label, e.g. "optional". */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Label + control + hint + error, wired together for assistive technologies. */
export function Field({ id, label, hint, error, aside, children, className }: FieldProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {aside ? <span className="text-xs text-fg-muted">{aside}</span> : null}
      </div>
      {children}
      {hint ? (
        <div id={`${id}-hint`} className="text-xs leading-relaxed text-fg-muted">
          {hint}
        </div>
      ) : null}
      {error ? (
        <p
          id={`${id}-error`}
          className="flex items-start gap-1 text-xs font-medium text-danger"
          role="alert"
        >
          <Icon name="alert" size={14} className="mt-px shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

const controlClass =
  'block w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg shadow-sm placeholder:text-fg-muted/70 ' +
  'transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring/30 ' +
  'disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(controlClass, 'h-10', className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <div className="relative">
        <select
          ref={ref}
          className={cn(controlClass, 'h-10 appearance-none pr-9', className)}
          {...rest}
        >
          {children}
        </select>
        <Icon
          name="chevronDown"
          className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-fg-muted"
        />
      </div>
    );
  },
);

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  description?: ReactNode;
}

/** Checkbox with a label and an optional one-line explanation. */
export function Checkbox({ id, label, description, className, ...rest }: CheckboxProps) {
  return (
    <div className={cn('flex items-start gap-3', className)}>
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 rounded border-border accent-[var(--accent)]"
        aria-describedby={description ? `${id}-desc` : undefined}
        {...rest}
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {description ? (
          <p id={`${id}-desc`} className="text-xs leading-relaxed text-fg-muted">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}
