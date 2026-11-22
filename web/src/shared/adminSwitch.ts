// 管理端复选框外观：苹果风格开关滑条。本地偏好，存入 localStorage。
export interface AdminSwitchPrefs {
  enabled: boolean;
  /** 滑条宽度（高度按比例推导），单位 px */
  size: number;
  durationMs: number;
}

export const ADMIN_SWITCH_DEFAULTS: AdminSwitchPrefs = {
  enabled: true,
  size: 44,
  durationMs: 180,
};

export const ADMIN_SWITCH_LIMITS = {
  size: { min: 32, max: 64 },
  durationMs: { min: 80, max: 600 },
} as const;

/** 高度 / 宽度，接近 iOS 与 macOS 开关的胶囊比例 */
export const ADMIN_SWITCH_ASPECT = 0.56;

export const ADMIN_SWITCH_STORAGE_KEYS = {
  enabled: 'admin-switch-enabled',
  size: 'admin-switch-size',
  durationMs: 'admin-switch-duration',
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'on' || value === 'true' || value === '1' || value === 1) return true;
  if (value === 'off' || value === 'false' || value === '0' || value === 0) return false;
  return ADMIN_SWITCH_DEFAULTS.enabled;
}

export function switchHeightFor(size: number): number {
  const normalized = Math.round(
    clamp(size, ADMIN_SWITCH_LIMITS.size.min, ADMIN_SWITCH_LIMITS.size.max),
  );
  return Math.max(18, Math.round(normalized * ADMIN_SWITCH_ASPECT));
}

export function normalizeAdminSwitchPrefs(
  input: { enabled?: unknown; size?: unknown; durationMs?: unknown } = {},
): AdminSwitchPrefs {
  const size = Number(input.size);
  const duration = Number(input.durationMs);
  return {
    enabled: normalizeEnabled(input.enabled),
    size: Number.isFinite(size)
      ? Math.round(clamp(size, ADMIN_SWITCH_LIMITS.size.min, ADMIN_SWITCH_LIMITS.size.max))
      : ADMIN_SWITCH_DEFAULTS.size,
    durationMs: Number.isFinite(duration)
      ? Math.round(clamp(duration, ADMIN_SWITCH_LIMITS.durationMs.min, ADMIN_SWITCH_LIMITS.durationMs.max))
      : ADMIN_SWITCH_DEFAULTS.durationMs,
  };
}

function readRaw(key: string): string | undefined {
  const value = localStorage.getItem(key);
  return value === null || value.trim() === '' ? undefined : value;
}

export function readAdminSwitchPrefs(): AdminSwitchPrefs {
  try {
    if (typeof localStorage === 'undefined') return { ...ADMIN_SWITCH_DEFAULTS };
    return normalizeAdminSwitchPrefs({
      enabled: readRaw(ADMIN_SWITCH_STORAGE_KEYS.enabled),
      size: readRaw(ADMIN_SWITCH_STORAGE_KEYS.size),
      durationMs: readRaw(ADMIN_SWITCH_STORAGE_KEYS.durationMs),
    });
  } catch {
    return { ...ADMIN_SWITCH_DEFAULTS };
  }
}

export function saveAdminSwitchPrefs(patch: Partial<AdminSwitchPrefs>): AdminSwitchPrefs {
  const current = readAdminSwitchPrefs();
  const next = normalizeAdminSwitchPrefs({
    enabled: patch.enabled ?? current.enabled,
    size: patch.size ?? current.size,
    durationMs: patch.durationMs ?? current.durationMs,
  });
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(ADMIN_SWITCH_STORAGE_KEYS.enabled, next.enabled ? 'on' : 'off');
      localStorage.setItem(ADMIN_SWITCH_STORAGE_KEYS.size, String(next.size));
      localStorage.setItem(ADMIN_SWITCH_STORAGE_KEYS.durationMs, String(next.durationMs));
    }
  } catch {
    // ignore
  }
  return next;
}

/** 应用外观：开关状态与尺寸写入 <html> 的 data 属性与 CSS 变量。 */
export function applyAdminSwitchPrefs(prefs: AdminSwitchPrefs): AdminSwitchPrefs {
  const normalized = normalizeAdminSwitchPrefs(prefs);
  try {
    const rootEl = typeof document === 'undefined' ? null : document.documentElement;
    if (rootEl) {
      rootEl.dataset.adminSwitch = normalized.enabled ? 'on' : 'off';
      rootEl.style.setProperty('--switch-w', normalized.size + 'px');
      rootEl.style.setProperty('--switch-h', switchHeightFor(normalized.size) + 'px');
      rootEl.style.setProperty('--switch-dur', normalized.durationMs + 'ms');
    }
  } catch {
    // ignore
  }
  return normalized;
}
