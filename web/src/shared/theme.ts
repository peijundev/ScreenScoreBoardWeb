/** 主题 v2 的共享类型（前端编辑器/显示端共用） */

export const THEME_FORMAT = 'screenscoreboard.theme';
export const THEME_VERSION = 2;

export interface ThemeMeta {
  id: string;
  name: string;
  author: string;
  description: string;
  baseStyle: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface ThemeCanvas {
  width: number;
  height: number;
  background: {
    type: 'none' | 'color' | 'image';
    color: string;
    image: string;
  };
}

export interface ThemePoint {
  x: number;
  y: number;
  in: { x: number; y: number };
  out: { x: number; y: number };
  mode: 'corner' | 'smooth';
}

export type ThemeNodeType = 'rect' | 'ellipse' | 'line' | 'path' | 'text' | 'image';

export interface ThemeNode {
  id: string;
  type: ThemeNodeType;
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  rotation: number;
  opacity: number;
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeWidth: number;
  points: ThemePoint[];
  closed: boolean;
  text: string;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  textAlign: 'left' | 'center' | 'right';
  src: string;
  name: string;
  visible: boolean;
  locked: boolean;
}

export interface ThemeLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: 'normal' | 'multiply' | 'screen' | 'overlay';
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  nodes: ThemeNode[];
}

export type ThemeWidgetType =
  | 'text' | 'title' | 'score' | 'rank' | 'avatar' | 'image' | 'progress'
  | 'clock' | 'countdown' | 'name' | 'bio' | 'teamName' | 'memberCount';

export type ThemeWidgetSurface = 'canvas' | 'card' | 'teamCard' | 'memberChip';

export type ThemeWidgetSlot =
  | 'rank' | 'avatar' | 'name' | 'bio' | 'score' | 'bar'
  | 'teamName' | 'teamTotal' | 'members' | 'extra';

export interface ThemeWidget {
  id: string;
  type: ThemeWidgetType;
  surface: ThemeWidgetSurface;
  slot?: ThemeWidgetSlot;
  x: number;
  y: number;
  w: number;
  h: number;
  props: Record<string, unknown>;
  bind: Record<string, unknown>;
  visible: boolean;
}

export interface ThemeScript {
  enabled: boolean;
  source: string;
  entry: string;
}

export interface ThemeV2 {
  format: typeof THEME_FORMAT;
  version: typeof THEME_VERSION;
  meta: ThemeMeta;
  canvas: ThemeCanvas;
  layers: ThemeLayer[];
  widgets: ThemeWidget[];
  settings: Record<string, unknown>;
  script: ThemeScript;
}

export interface ThemeSummary {
  id: string;
  name: string;
  author: string;
  description: string;
  baseStyle: string;
  revision: number;
  updatedAt: number;
  bytes: number;
  layers: number;
  widgets: number;
}

export function emptyTheme(name = '新主题'): ThemeV2 {
  const now = Date.now();
  return {
    format: THEME_FORMAT,
    version: THEME_VERSION,
    meta: {
      id: '',
      name,
      author: '',
      description: '',
      baseStyle: 'custom',
      createdAt: now,
      updatedAt: now,
      revision: 0,
    },
    canvas: {
      width: 1920,
      height: 1080,
      background: { type: 'none', color: '#000000', image: '' },
    },
    layers: [],
    widgets: [],
    settings: {},
    script: { enabled: false, source: '', entry: 'drawTheme' },
  };
}
