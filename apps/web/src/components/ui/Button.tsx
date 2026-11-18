import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { Icon, type IconName } from '../Icon';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
}

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover shadow-sm',
  secondary: 'bg-surface text-fg border border-border hover:bg-surface-2 shadow-sm',
  ghost: 'text-fg-muted hover:text-fg hover:bg-surface-2',
  danger: 'bg-danger text-white hover:opacity-90 shadow-sm dark:text-bg',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-sm gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    icon,
    loading = false,
    disabled,
    className,
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-60',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Spinner size={size === 'sm' ? 14 : 16} />
      ) : icon ? (
        <Icon name={icon} size={size === 'sm' ? 14 : 16} />
      ) : null}
      {children}
    </button>
  );
});

/** Square icon-only button. `label` is required for screen readers. */
export function IconButton({
  icon,
  label,
  className,
  size = 'md',
  ...rest
}: Omit<ButtonProps, 'children' | 'icon'> & { icon: IconName; label: string }) {
  return (
    <Button
      variant="ghost"
      size={size}
      aria-label={label}
      title={label}
      icon={icon}
      className={cn(size === 'sm' ? 'w-8 px-0' : 'w-10 px-0', className)}
      {...rest}
    />
  );
}
