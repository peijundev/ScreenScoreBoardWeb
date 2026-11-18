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
  createdAt: number;
  order?: number;
}

// Phase 0 只声明常用字段；其余 150+ 项在 Phase 2 由 settings schema 收敛类型
export type Settings = Record<string, any> & {
  title: string;
  theme: 'dark' | 'light';
  density: 'comfortable' | 'compact';
  displayStyle: string;
  columns: number;
  sortBy: string;
  sortOrder: string;
  accent: string;
  layoutMode: 'auto' | 'free';
  titleSize: number;
  titleColor: string;
  titleFont: string;
  bgType: 'color' | 'image';
  bgImage: string | null;
  bgImageBlur: boolean;
  bgImageBlurAmount: number;
  scrimOpacity: number;
  bgScrimEnabled: boolean;
  featureBio: boolean;
  bioFont: string;
  bioFontCustom: string;
  bioSize: number;
  bioColor: string;
  bioOpacity: number;
  bioItalic: boolean;
};

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  people: Record<string, Person>;
  teams: Record<string, Team>;
  settings: Settings;
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

export interface RuntimeSnapshot {
  undoCounts: Record<string, number>;
  undoLabels?: Record<string, UndoLabel[]>;
  scoreLogs?: Record<string, ScoreLogEntry[]>;
  countdowns: Record<string, CountdownRuntime>;
  serverNow?: number;
}
