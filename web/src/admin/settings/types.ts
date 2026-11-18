import type { JSX } from 'react';
import type { Project, Settings } from '../../shared/types';

export interface Ctx {
  project: Project;
  settings: Settings;
  /** 单键 patch（默认 300ms 合并防抖，immediate 立即发送） */
  set: (key: string, value: unknown, immediate?: boolean) => void;
  /** 项目级 op */
  op: (op: string, payload?: Record<string, unknown>) => Promise<unknown>;
}

type Disabled = (s: Settings) => boolean;

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
    }
  | { t: 'num'; k: string; label: string; min?: number; max?: number; disabled?: Disabled }
  | { t: 'select'; k: string; label: string; opts: Array<[string, string]>; disabled?: Disabled }
  | { t: 'check'; k: string; label: string; disabled?: Disabled }
  | { t: 'checkValue'; k: string; on: string; off: string; label: string; disabled?: Disabled }
  | { t: 'text'; k: string; label: string; max?: number; placeholder?: string }
  | { t: 'color'; k: string; label: string; disabled?: Disabled }
  | { t: 'colorToggle'; k: string; label: string; fallback?: (s: Settings) => string; disabled?: Disabled }
  | { t: 'font'; k: string; ck: string; label: string; customLabel: string }
  | { t: 'custom'; id: string };

export type SettingsTab = 'layout' | 'appearance' | 'font' | 'effect';

export interface Group {
  title: string;
  tab: SettingsTab;
  advanced?: boolean;
  fields: Field[];
}

export type CustomRenderer = (ctx: Ctx) => JSX.Element;
