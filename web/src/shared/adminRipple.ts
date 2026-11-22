// Android 主题的 Material 3 涟漪偏好：管理端本地设置，存入 localStorage。
export interface AdminRipplePrefs {
  enabled: boolean;
  durationMs: number;
  opacity: number;
}

export const ADMIN_RIPPLE_DEFAULTS: AdminRipplePrefs = {
  enabled: true,
  durationMs: 450,
  opacity: 0.14,
};

export const ADMIN_RIPPLE_LIMITS = {
  durationMs: { min: 120, max: 1200 },
  opacity: { min: 0.05, max: 0.45 },
} as const;

export const ADMIN_RIPPLE_STORAGE_KEYS = {
  enabled: 'admin-android-ripple',
  durationMs: 'admin-android-ripple-duration',
  opacity: 'admin-android-ripple-opacity',
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'on' || value === 'true' || value === '1' || value === 1) return true;
  if (value === 'off' || value === 'false' || value === '0' || value === 0) return false;
  return ADMIN_RIPPLE_DEFAULTS.enabled;
}

export function normalizeAdminRipplePrefs(
  input: { enabled?: unknown; durationMs?: unknown; opacity?: unknown } = {},
): AdminRipplePrefs {
  const duration = Number(input.durationMs);
  const opacity = Number(input.opacity);
  return {
    enabled: normalizeEnabled(input.enabled),
    durationMs: Number.isFinite(duration)
      ? Math.round(clamp(duration, ADMIN_RIPPLE_LIMITS.durationMs.min, ADMIN_RIPPLE_LIMITS.durationMs.max))
      : ADMIN_RIPPLE_DEFAULTS.durationMs,
    opacity: Number.isFinite(opacity)
      ? Math.round(clamp(opacity, ADMIN_RIPPLE_LIMITS.opacity.min, ADMIN_RIPPLE_LIMITS.opacity.max) * 100) / 100
      : ADMIN_RIPPLE_DEFAULTS.opacity,
  };
}

function readRaw(key: string): string | undefined {
  const value = localStorage.getItem(key);
  return value === null || value.trim() === '' ? undefined : value;
}

export function readAdminRipplePrefs(): AdminRipplePrefs {
  try {
    if (typeof localStorage === 'undefined') return { ...ADMIN_RIPPLE_DEFAULTS };
    return normalizeAdminRipplePrefs({
      enabled: readRaw(ADMIN_RIPPLE_STORAGE_KEYS.enabled),
      durationMs: readRaw(ADMIN_RIPPLE_STORAGE_KEYS.durationMs),
      opacity: readRaw(ADMIN_RIPPLE_STORAGE_KEYS.opacity),
    });
  } catch {
    return { ...ADMIN_RIPPLE_DEFAULTS };
  }
}

export function saveAdminRipplePrefs(patch: Partial<AdminRipplePrefs>): AdminRipplePrefs {
  const current = readAdminRipplePrefs();
  const next = normalizeAdminRipplePrefs({
    enabled: patch.enabled ?? current.enabled,
    durationMs: patch.durationMs ?? current.durationMs,
    opacity: patch.opacity ?? current.opacity,
  });
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(ADMIN_RIPPLE_STORAGE_KEYS.enabled, next.enabled ? 'on' : 'off');
      localStorage.setItem(ADMIN_RIPPLE_STORAGE_KEYS.durationMs, String(next.durationMs));
      localStorage.setItem(ADMIN_RIPPLE_STORAGE_KEYS.opacity, String(next.opacity));
    }
  } catch {
    // ignore
  }
  return next;
}
