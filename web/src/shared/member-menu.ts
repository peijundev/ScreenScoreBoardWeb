import type { CSSProperties } from 'react';

export type MemberMenuAction = 'score' | 'spotlight';
export type MemberMenuTargetType = 'person' | 'team';

export interface MemberMenuButton {
  id: string;
  label: string;
  enabled: boolean;
  buzz: boolean;
  /** 仅抢答进行中可用；其余时间按钮禁用。 */
  onlyDuringBuzz: boolean;
  action: MemberMenuAction;
  targetType: MemberMenuTargetType;
  targetId: string;
  delta: number;
  durationMs: number;
  height: number;
  fontSize: number;
  radius: number;
  color: string;
  textColor: string;
  image: string;
}

/** 每个队员账号单独一份菜单；userId 对应用户记录，绑定项目由用户记录维护。 */
export interface MemberMenuConfig {
  userId: string;
  enabled: boolean;
  columns: number;
  gap: number;
  /** 列数为 1 且只有一个按钮时：none 保持配置尺寸，adaptive 按屏幕可用区域自适应铺满。 */
  fillMode: 'none' | 'adaptive';
  buttons: MemberMenuButton[];
}

export const MEMBER_MENU_LIMIT = 24;
export const MEMBER_MENU_ENTRY_LIMIT = 200;

export const MEMBER_MENU_DEFAULTS = {
  enabled: true,
  buzz: true,
  onlyDuringBuzz: false,
  action: 'score' as MemberMenuAction,
  targetType: 'person' as MemberMenuTargetType,
  delta: 1,
  durationMs: 0,
  height: 120,
  fontSize: 28,
  radius: 16,
  color: '#e8a33d',
  textColor: '',
  image: '',
};

export const MEMBER_MENU_LAYOUT_DEFAULTS = {
  enabled: true,
  columns: 2,
  gap: 16,
  fillMode: 'none' as const,
};

/** 根据背景色选择可读文字色；背景图存在时统一用白字 + 阴影。 */
export function contrastText(hex: string): string {
  const value = hex.replace('#', '');
  if (value.length !== 6) return '#fff';
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  if (![r, g, b].every(Number.isFinite)) return '#fff';
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#111' : '#fff';
}

/** 队员按钮与「人员功能菜单」预览共用同一套样式，避免预览与实际不一致。 */
export function memberButtonStyle(button: MemberMenuButton): CSSProperties {
  const hasImage = Boolean(button.image);
  return {
    width: '100%',
    minHeight: button.height,
    fontSize: button.fontSize,
    borderRadius: button.radius,
    backgroundColor: button.color,
    color: button.textColor || (hasImage ? '#fff' : contrastText(button.color)),
    backgroundImage: hasImage
      ? `linear-gradient(rgba(0,0,0,0.18), rgba(0,0,0,0.18)), url('/${button.image}')`
      : undefined,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    textShadow: hasImage ? '0 1px 4px rgba(0,0,0,0.75)' : undefined,
  };
}
