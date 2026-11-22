// 与服务端 server/state.js 的数据模型保持一致（Phase 2 将按 DEFAULT_SETTINGS 生成完整的 155 键类型）

export interface Layout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Person {
  id: string;
  name: string;
  avatar: string | null;
  cardImage: string | null;
  score: number;
  teamId: string | null;
  layout: Layout | null;
  memberLayout: Layout | null;
  bio?: string;
  createdAt: number;
  order?: number;
}

export interface Team {
  id: string;
  name: string;
  avatar: string | null;
  cardImage: string | null;
  layout: Layout | null;
  bio?: string;
  captainId?: string | null;
  createdAt: number;
  order?: number;
}

import type { SettingsFields } from './settings.generated';

// 完整字段由 server/state.js 的 DEFAULT_SETTINGS 生成；动态键通过索引签名访问
export type Settings = SettingsFields & Record<string, any>;

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  people: Record<string, Person>;
  teams: Record<string, Team>;
  settings: Settings;
  themeId?: string | null;
  themeRevision?: number;
}

export interface Snapshot {
  version: number;
  projects: Record<string, Project>;
}

export type CountdownState = 'running' | 'paused' | 'ended' | string;

export interface CountdownRuntime {
  state: CountdownState;
  endsAt?: number;
  remainingMs?: number;
  durationMs?: number;
}

export interface UndoLabel {
  index: number;
  label: string;
}

export interface ScoreLogEntry {
  at: number;
  label: string;
  delta: number;
}

export interface SpotlightRuntimeEvent {
  seq: number;
  targetType: 'person' | 'team' | string;
  targetId: string;
  at: number;
  durationMs?: number;
}

export interface RuntimeSnapshot {
  undoCounts: Record<string, number>;
  undoLabels?: Record<string, UndoLabel[]>;
  scoreLogs?: Record<string, ScoreLogEntry[]>;
  countdowns: Record<string, CountdownRuntime>;
  spotlightEvents?: Record<string, SpotlightRuntimeEvent[]>;
  serverNow?: number;
}
