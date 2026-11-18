import { useCallback, useEffect, useState } from 'react';
import {
  applyTheme,
  readThemePreference,
  writeThemePreference,
  type ThemePreference,
} from '../lib/theme';

/** Current theme preference plus a setter that persists it and updates <html class="dark">. */
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);

  useEffect(() => {
    applyTheme(preference);
    if (preference !== 'system' || !window.matchMedia) return;
    // Follow OS changes live while in "system" mode.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference]);

  const setTheme = useCallback((pref: ThemePreference) => {
    writeThemePreference(pref);
    setPreference(pref);
  }, []);

  return { preference, setTheme };
}
