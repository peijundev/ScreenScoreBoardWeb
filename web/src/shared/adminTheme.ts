// 管理端本地主题偏好：不进入 DEFAULT_SETTINGS，也不广播给显示端。
export type AdminTheme =
  | 'breeze-dark' | 'breeze-light'
  | 'adwaita-dark' | 'adwaita-light'
  | 'macos-dark' | 'macos-light'
  | 'android-dark' | 'android-light';

export interface AdminThemeOption {
  id: AdminTheme;
  label: string;
  group: string;
  dark: boolean;
}

export const ADMIN_THEMES: AdminThemeOption[] = [
  { id: 'breeze-dark', label: 'Breeze 深色', group: 'KDE Breeze', dark: true },
  { id: 'breeze-light', label: 'Breeze 浅色', group: 'KDE Breeze', dark: false },
  { id: 'adwaita-dark', label: 'Adwaita 深色', group: 'Adwaita', dark: true },
  { id: 'adwaita-light', label: 'Adwaita 浅色', group: 'Adwaita', dark: false },
  { id: 'macos-dark', label: 'macOS 深色', group: 'macOS', dark: true },
  { id: 'macos-light', label: 'macOS 浅色', group: 'macOS', dark: false },
  { id: 'android-dark', label: 'Android 深色', group: 'Android Material 3', dark: true },
  { id: 'android-light', label: 'Android 浅色', group: 'Android Material 3', dark: false },
];

export const DEFAULT_ADMIN_THEME: AdminTheme = 'macos-light';
export const ADMIN_THEME_STORAGE_KEY = 'admin-theme';

const VALID_THEMES = new Set<string>(ADMIN_THEMES.map((item) => item.id));
// 旧版本只存 dark/light，升级后自动落到对应的 Breeze 主题。
const LEGACY_THEMES: Record<string, AdminTheme> = {
  dark: 'breeze-dark',
  light: 'breeze-light',
};

export function normalizeAdminTheme(value: unknown): AdminTheme {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (VALID_THEMES.has(raw)) return raw as AdminTheme;
  return LEGACY_THEMES[raw] || DEFAULT_ADMIN_THEME;
}

export function readAdminTheme(): AdminTheme {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_ADMIN_THEME;
    return normalizeAdminTheme(localStorage.getItem(ADMIN_THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_ADMIN_THEME;
  }
}

export function applyAdminTheme(
  theme: AdminTheme,
  options: { persist?: boolean } = {},
): AdminTheme {
  const normalized = normalizeAdminTheme(theme);
  try {
    if (typeof document !== 'undefined' && document.body) {
      document.body.dataset.theme = normalized;
    }
  } catch {
    // ignore
  }
  if (options.persist !== false) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(ADMIN_THEME_STORAGE_KEY, normalized);
      }
    } catch {
      // ignore
    }
  }
  return normalized;
}
