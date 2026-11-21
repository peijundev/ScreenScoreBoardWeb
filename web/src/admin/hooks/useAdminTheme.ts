import { useCallback, useEffect, useState } from 'react';
import {
  ADMIN_THEME_STORAGE_KEY,
  applyAdminTheme,
  normalizeAdminTheme,
  readAdminTheme,
  type AdminTheme,
} from '../../shared/adminTheme';

const THEME_EVENT = 'ssb-admin-theme-change';

export interface AdminThemeState {
  theme: AdminTheme;
  setTheme: (next: AdminTheme) => void;
}

/** 管理端主题状态：应用、持久化，并在 Toolbar/MobileNav 等挂载实例间同步。 */
export function useAdminTheme(): AdminThemeState {
  const [theme, setThemeState] = useState<AdminTheme>(() => readAdminTheme());

  useEffect(() => {
    applyAdminTheme(theme, { persist: false });
  }, [theme]);

  useEffect(() => {
    function onChange(event: Event): void {
      setThemeState(normalizeAdminTheme((event as CustomEvent<unknown>).detail));
    }
    function onStorage(event: StorageEvent): void {
      if (event.key === ADMIN_THEME_STORAGE_KEY) {
        setThemeState(normalizeAdminTheme(event.newValue));
      }
    }
    window.addEventListener(THEME_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(THEME_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setTheme = useCallback((next: AdminTheme) => {
    const applied = applyAdminTheme(next);
    setThemeState(applied);
    try {
      window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: applied }));
    } catch {
      // ignore
    }
  }, []);

  return { theme, setTheme };
}
