import { useCallback, useEffect, useState } from 'react';
import {
  ADMIN_RIPPLE_STORAGE_KEYS,
  normalizeAdminRipplePrefs,
  readAdminRipplePrefs,
  saveAdminRipplePrefs,
  type AdminRipplePrefs,
} from '../../shared/adminRipple';

const RIPPLE_EVENT = 'ssb-admin-ripple-change';

export interface AdminRippleState {
  ripple: AdminRipplePrefs;
  updateRipple: (patch: Partial<AdminRipplePrefs>) => void;
}

/** Android 涟漪偏好：持久化，并在 Toolbar / MobileNav 的多个选择器间同步。 */
export function useAdminRipple(): AdminRippleState {
  const [ripple, setRipple] = useState<AdminRipplePrefs>(() => readAdminRipplePrefs());

  useEffect(() => {
    function onChange(event: Event): void {
      setRipple(normalizeAdminRipplePrefs((event as CustomEvent<Partial<AdminRipplePrefs>>).detail));
    }
    function onStorage(event: StorageEvent): void {
      if (
        event.key === ADMIN_RIPPLE_STORAGE_KEYS.enabled ||
        event.key === ADMIN_RIPPLE_STORAGE_KEYS.durationMs ||
        event.key === ADMIN_RIPPLE_STORAGE_KEYS.opacity
      ) {
        setRipple(readAdminRipplePrefs());
      }
    }
    window.addEventListener(RIPPLE_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(RIPPLE_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const updateRipple = useCallback((patch: Partial<AdminRipplePrefs>) => {
    const next = saveAdminRipplePrefs(patch);
    setRipple(next);
    try {
      window.dispatchEvent(new CustomEvent(RIPPLE_EVENT, { detail: next }));
    } catch {
      // ignore
    }
  }, []);

  return { ripple, updateRipple };
}
