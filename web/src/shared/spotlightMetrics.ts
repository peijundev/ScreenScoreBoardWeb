// 居中突显的尺寸计算：宽度范围、字号缩放与头像大小（支持随宽度自动缩放）。
export const SPOTLIGHT_LIMITS = {
  width: { min: 200, max: 4000 },
  height: { min: 0, max: 3000 },
  fontScale: { min: 0.5, max: 8 },
  avatarSize: { min: 24, max: 1024 },
} as const;

/** 自动缩放基准：突显宽 520px 时字号 1 倍、头像 96px */
export const SPOTLIGHT_BASE_WIDTH = 520;
export const SPOTLIGHT_BASE_AVATAR = 96;

export interface SpotlightMetrics {
  width: number;
  height: number;
  fontScale: number;
  avatarSize: number;
  auto: boolean;
  /** true = 原卡片整体按比例放大，内部字号/头像不再单独放大 */
  proportional: boolean;
}

interface SpotlightSource {
  spotlightWidth?: unknown;
  spotlightHeight?: unknown;
  spotlightFontScale?: unknown;
  spotlightAvatarSize?: unknown;
  spotlightAutoScale?: unknown;
  spotlightSizeMode?: unknown;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function spotlightMetrics(settings: SpotlightSource): SpotlightMetrics {
  const width = clamp(
    Number(settings.spotlightWidth) || SPOTLIGHT_BASE_WIDTH,
    SPOTLIGHT_LIMITS.width.min,
    SPOTLIGHT_LIMITS.width.max,
  );
  const proportional = settings.spotlightSizeMode === 'scale';
  const rawHeight = proportional ? 0 : Number(settings.spotlightHeight) || 0;
  const height = clamp(rawHeight, SPOTLIGHT_LIMITS.height.min, SPOTLIGHT_LIMITS.height.max);
  const auto = !proportional && settings.spotlightAutoScale === true;
  const ratio = width / SPOTLIGHT_BASE_WIDTH;
  const fontScale = auto
    ? clamp(ratio, SPOTLIGHT_LIMITS.fontScale.min, SPOTLIGHT_LIMITS.fontScale.max)
    : clamp(
        Number(settings.spotlightFontScale) || 1,
        SPOTLIGHT_LIMITS.fontScale.min,
        SPOTLIGHT_LIMITS.fontScale.max,
      );
  const avatarSize = auto
    ? clamp(
        Math.round(SPOTLIGHT_BASE_AVATAR * ratio),
        SPOTLIGHT_LIMITS.avatarSize.min,
        SPOTLIGHT_LIMITS.avatarSize.max,
      )
    : clamp(
        Number(settings.spotlightAvatarSize) || SPOTLIGHT_BASE_AVATAR,
        SPOTLIGHT_LIMITS.avatarSize.min,
        SPOTLIGHT_LIMITS.avatarSize.max,
      );
  return { width, height, fontScale: round2(fontScale), avatarSize, auto, proportional };
}
