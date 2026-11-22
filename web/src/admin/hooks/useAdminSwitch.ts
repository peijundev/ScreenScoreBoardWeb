import { useCallback, useEffect, useState } from 'react';
import {
  ADMIN_SWITCH_STORAGE_KEYS,
  applyAdminSwitchPrefs,
  normalizeAdminSwitchPrefs,
  readAdminSwitchPrefs,
  saveAdminSwitchPrefs,
  type AdminSwitchPrefs,
} from '../../shared/adminSwitch';

const SWITCH_EVENT = 'ssb-admin-switch-change';

export interface AdminSwitchState {
  prefs: AdminSwitchPrefs;
  updateSwitch: (patch: Partial<AdminSwitchPrefs>) => void;
}

/** 苹果风格开关偏好：持久化，并在多个选择器实例间同步。 */
export function useAdminSwitch(): AdminSwitchState {
  const [prefs, setPrefs] = useState<AdminSwitchPrefs>(() => readAdminSwitchPrefs());

  useEffect(() => {
    applyAdminSwitchPrefs(prefs);
  }, [prefs]);

  useEffect(() => {
    function onChange(event: Event): void {
      setPrefs(normalizeAdminSwitchPrefs((event as CustomEvent<Partial<AdminSwitchPrefs>>).detail));
    }
    function onStorage(event: StorageEvent): void {
      if (
        event.key === ADMIN_SWITCH_STORAGE_KEYS.enabled ||
        event.key === ADMIN_SWITCH_STORAGE_KEYS.size ||
        event.key === ADMIN_SWITCH_STORAGE_KEYS.durationMs
      ) {
        setPrefs(readAdminSwitchPrefs());
      }
    }
    window.addEventListener(SWITCH_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SWITCH_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const updateSwitch = useCallback((patch: Partial<AdminSwitchPrefs>) => {
    const next = saveAdminSwitchPrefs(patch);
    applyAdminSwitchPrefs(next);
    setPrefs(next);
    try {
      window.dispatchEvent(new CustomEvent(SWITCH_EVENT, { detail: next }));
    } catch {
      // ignore
    }
  }, []);

  return { prefs, updateSwitch };
}
