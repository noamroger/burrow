import { useTheme } from '../hooks/useTheme';
import { t } from '../i18n';
import { cn } from '../lib/cn';
import type { ThemePreference } from '../lib/theme';
import { Icon, type IconName } from './Icon';

const OPTIONS: Array<{
  value: ThemePreference;
  icon: IconName;
  label: 'theme.system' | 'theme.light' | 'theme.dark';
}> = [
  { value: 'system', icon: 'monitor', label: 'theme.system' },
  { value: 'light', icon: 'sun', label: 'theme.light' },
  { value: 'dark', icon: 'moon', label: 'theme.dark' },
];

/** Three-way theme switch (system / light / dark), persisted in localStorage. */
export function ThemeToggle({ className }: { className?: string }) {
  const { preference, setTheme } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label={t('theme.label')}
      className={cn('inline-flex rounded-lg bg-black/20 p-0.5', className)}
    >
      {OPTIONS.map((opt) => {
        const active = preference === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={t(opt.label)}
            title={t(opt.label)}
            onClick={() => setTheme(opt.value)}
            className={cn(
              'flex h-7 w-8 items-center justify-center rounded-md transition-colors',
              active
                ? 'bg-sidebar-active text-sidebar-fg shadow-sm'
                : 'text-sidebar-muted hover:text-sidebar-fg',
            )}
          >
            <Icon name={opt.icon} size={14} />
          </button>
        );
      })}
    </div>
  );
}
