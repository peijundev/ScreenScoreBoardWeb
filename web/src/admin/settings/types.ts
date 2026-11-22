import type { JSX } from 'react';
import type { Project, Settings } from '../../shared/types';
import type { OpName } from '../../shared/ops.generated';

export interface Ctx {
  project: Project;
  settings: Settings;
  /** 单键 patch（默认 300ms 合并防抖，immediate 立即发送） */
  set: (key: string, value: unknown, immediate?: boolean) => void;
  /** 项目级 op */
  op: (op: OpName, payload?: Record<string, unknown>) => Promise<unknown>;
}

type Disabled = (s: Settings) => boolean;
type Visible = (s: Settings) => boolean;

export type Field =
  | {
      t: 'range';
      k: string;
      label: string;
      min: number;
      max: number;
      step: number;
      fmt?: 'num' | 'auto' | 'pct' | 'x';
      unit?: string;
      disabled?: Disabled;
      visible?: Visible;
    }
  | { t: 'num'; k: string; label: string; min?: number; max?: number; disabled?: Disabled; visible?: Visible }
  | { t: 'select'; k: string; label: string; opts: Array<[string, string]>; disabled?: Disabled; visible?: Visible }
  | { t: 'check'; k: string; label: string; disabled?: Disabled; visible?: Visible }
  | { t: 'checkValue'; k: string; on: string; off: string; label: string; disabled?: Disabled; visible?: Visible }
  | { t: 'text'; k: string; label: string; max?: number; placeholder?: string; visible?: Visible }
  | { t: 'color'; k: string; label: string; disabled?: Disabled; visible?: Visible }
  | { t: 'colorToggle'; k: string; label: string; fallback?: (s: Settings) => string; disabled?: Disabled; visible?: Visible }
  | { t: 'font'; k: string; ck: string; label: string; customLabel: string; visible?: Visible }
  | { t: 'custom'; id: string; visible?: Visible };

export type SettingsTab = 'layout' | 'appearance' | 'font' | 'effect';

export interface Group {
  title: string;
  tab: SettingsTab;
  advanced?: boolean;
  /** 仅在该条件成立时显示整个分组（例如只有选择对应特效才显示其参数） */
  visible?: (s: Settings) => boolean;
  fields: Field[];
}

export type CustomRenderer = (ctx: Ctx) => JSX.Element;
