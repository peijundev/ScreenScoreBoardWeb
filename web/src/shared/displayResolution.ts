// 显示端逻辑分辨率：'auto' 跟随窗口，或 'WxH'（如 3840x2160）按画布渲染并等比缩放。
export interface DisplayResolutionSize {
  w: number;
  h: number;
}

export const DISPLAY_RESOLUTION_LIMITS = {
  minW: 320,
  maxW: 15360,
  minH: 240,
  maxH: 8640,
} as const;

export const DISPLAY_RESOLUTION_AUTO = 'auto';

/** 内容排版基准：固定分辨率时按 1920×1080 布局，再按强度放大到目标画布 */
export const DISPLAY_RESOLUTION_UI_BASE = { w: 1920, h: 1080 } as const;

/** 默认放大强度 50%：4K 下内容放大 1.5 倍，而不是直接 2 倍 */
export const DISPLAY_RESOLUTION_SCALE_DEFAULT = 50;

/**
 * 内容缩放系数：分辨率相对 1080p 的倍数按 strength（0–100%）插值。
 * 0% 保持 1080p 尺寸，100% 完全按分辨率放大（4K 为 2 倍）。
 */
export function displayContentScale(width: number, height: number, strength: unknown): number {
  const full = Math.min(width / DISPLAY_RESOLUTION_UI_BASE.w, height / DISPLAY_RESOLUTION_UI_BASE.h);
  const raw = Number(strength);
  const pct = Number.isFinite(raw)
    ? Math.min(100, Math.max(0, raw)) / 100
    : DISPLAY_RESOLUTION_SCALE_DEFAULT / 100;
  return Math.max(0.1, Math.min(10, 1 + (full - 1) * pct));
}

export function parseDisplayResolution(value: unknown): DisplayResolutionSize | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(value.trim());
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w < DISPLAY_RESOLUTION_LIMITS.minW || w > DISPLAY_RESOLUTION_LIMITS.maxW) return null;
  if (h < DISPLAY_RESOLUTION_LIMITS.minH || h > DISPLAY_RESOLUTION_LIMITS.maxH) return null;
  return { w, h };
}

export function formatDisplayResolution(w: number, h: number): string {
  return Math.round(w) + 'x' + Math.round(h);
}
