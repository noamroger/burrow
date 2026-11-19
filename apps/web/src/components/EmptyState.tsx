import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * A small mound of earth with a burrow entrance; the icon glows inside it like
 * the lamp in the logo. Decorative only.
 */
export function BurrowArt({ icon, size = 132 }: { icon: IconName; size?: number }) {
  return (
    <div className="relative" style={{ width: size, height: size * 0.5625 }} aria-hidden>
      <svg viewBox="0 0 160 90" width={size} height={size * 0.5625} focusable="false">
        <path d="M6 86C22 40 52 22 80 22s58 18 74 64z" fill="var(--soil-1)" />
        <path
          d="M22 70c16-6 36-9 58-9s42 3 58 9M34 52c13-4 29-6 46-6s33 2 46 6"
          fill="none"
          stroke="var(--soil-3)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray="1 6"
        />
        <path d="M56 86V64a24 24 0 0 1 48 0v22z" fill="var(--sidebar)" />
        <path d="M2 86h156" stroke="var(--soil-3)" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span
        className="absolute flex items-center justify-center text-lamp"
        style={{
          left: '35%',
          width: '30%',
          top: `${(48 / 90) * 100}%`,
          height: `${(38 / 90) * 100}%`,
        }}
      >
        <Icon name={icon} size={Math.round(size * 0.15)} />
      </span>
    </div>
  );
}

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
      <div className="mb-5">
        <BurrowArt icon={icon} />
      </div>
      <h3 className="text-lg font-semibold text-fg">{title}</h3>
      {children ? (
        <div className="mt-2 max-w-md text-sm leading-relaxed text-fg-muted">{children}</div>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
