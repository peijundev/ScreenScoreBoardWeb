/** 主题脚本：受限绘制指令与上下文构建（显示端专用，不执行主题里的任意 DOM 操作） */
import type {
  CountdownRuntime, Project, RuntimeSnapshot, Settings, CountdownState,
} from '../../shared/types';

export const MAX_SCRIPT_COMMANDS = 200;
export const MAX_SCRIPT_PATH = 4000;
export const MAX_SCRIPT_TEXT = 200;

export type ThemeScriptCommand =
  | {
      op: 'rect'; x: number; y: number; w: number; h: number; rx: number;
      fill: string; stroke: string; strokeWidth: number; opacity: number;
    }
  | {
      op: 'ellipse'; x: number; y: number; w: number; h: number;
      fill: string; stroke: string; strokeWidth: number; opacity: number;
    }
  | {
      op: 'line'; x1: number; y1: number; x2: number; y2: number;
      stroke: string; strokeWidth: number; opacity: number;
    }
  | {
      op: 'text'; x: number; y: number; text: string; size: number;
      color: string; opacity: number; align: 'left' | 'center' | 'right';
      weight: number; font: string;
    }
  | {
      op: 'path'; d: string; fill: string; stroke: string;
      strokeWidth: number; opacity: number;
    }
  | {
      op: 'polygon'; points: string; fill: string; stroke: string;
      strokeWidth: number; opacity: number;
    };

export interface ThemeScriptPerson {
  id: string;
  name: string;
  score: number;
  teamId: string | null;
  rank: number;
}

export interface ThemeScriptTeam {
  id: string;
  name: string;
  total: number;
  memberCount: number;
}

export interface ThemeScriptContext {
  t: number;
  frame: number;
  width: number;
  height: number;
  projectName: string;
  title: string;
  accent: string;
  theme: string;
  displayStyle: string;
  people: ThemeScriptPerson[];
  teams: ThemeScriptTeam[];
  maxScore: number;
  totalScore: number;
  countdown: {
    state: CountdownState;
    remainingMs: number;
    durationMs: number;
  } | null;
}

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]*$/;
const FONT_RE = /^[A-Za-z0-9 _.,'"\-一-龥]{1,60}$/;
const ENTRY_RE = /^[A-Za-z_$][\w$]{0,63}$/;

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(-100000, Math.min(100000, n));
}

function frac(v: unknown, fallback = 1): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function color(v: unknown, fallback: string): string {
  if (v === 'none' || v === 'transparent') return v;
  return typeof v === 'string' && COLOR_RE.test(v) ? v : fallback;
}

function opacity(v: unknown): number {
  return frac(v, 1);
}

function strokeWidth(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function safeText(v: unknown, max = MAX_SCRIPT_TEXT): string {
  if (typeof v !== 'string') return '';
  return v.slice(0, max).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** 入口函数名会拼进沙箱里的 new Function，必须严格白名单。 */
export function safeScriptEntry(v: unknown): string {
  return typeof v === 'string' && ENTRY_RE.test(v) ? v : 'drawTheme';
}

/** 把脚本返回值收敛为可安全渲染到 SVG 的有限指令集。 */
export function sanitizeThemeScriptCommands(input: unknown): ThemeScriptCommand[] {
  if (!Array.isArray(input)) return [];
  const out: ThemeScriptCommand[] = [];
  for (const raw of input.slice(0, MAX_SCRIPT_COMMANDS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const c = raw as Record<string, unknown>;
    switch (c.op) {
      case 'rect':
        out.push({
          op: 'rect',
          x: num(c.x), y: num(c.y),
          w: Math.max(0, num(c.w)), h: Math.max(0, num(c.h)),
          rx: Math.max(0, num(c.rx)),
          fill: color(c.fill, '#ffffff'),
          stroke: color(c.stroke, 'none'),
          strokeWidth: strokeWidth(c.strokeWidth),
          opacity: opacity(c.opacity),
        });
        break;
      case 'ellipse':
        out.push({
          op: 'ellipse',
          x: num(c.x), y: num(c.y),
          w: Math.max(0, num(c.w)), h: Math.max(0, num(c.h)),
          fill: color(c.fill, '#ffffff'),
          stroke: color(c.stroke, 'none'),
          strokeWidth: strokeWidth(c.strokeWidth),
          opacity: opacity(c.opacity),
        });
        break;
      case 'line':
        out.push({
          op: 'line',
          x1: num(c.x1), y1: num(c.y1), x2: num(c.x2), y2: num(c.y2),
          stroke: color(c.stroke, '#ffffff'),
          strokeWidth: strokeWidth(c.strokeWidth) || 1,
          opacity: opacity(c.opacity),
        });
        break;
      case 'text': {
        const text = safeText(c.text, MAX_SCRIPT_TEXT);
        if (!text) break;
        const align = c.align === 'left' || c.align === 'right' ? c.align : 'center';
        out.push({
          op: 'text',
          x: num(c.x), y: num(c.y), text,
          size: Math.max(1, Math.min(500, num(c.size, 32) || 32)),
          color: color(c.color, '#ffffff'),
          opacity: opacity(c.opacity),
          align,
          weight: Math.max(100, Math.min(900, Math.round(num(c.weight, 700) / 100) * 100)),
          font: typeof c.font === 'string' && FONT_RE.test(c.font) ? c.font : 'system',
        });
        break;
      }
      case 'path': {
        const d = safeText(c.d, MAX_SCRIPT_PATH);
        if (!d || !PATH_RE.test(d)) break;
        out.push({
          op: 'path', d,
          fill: color(c.fill, 'none'),
          stroke: color(c.stroke, 'none'),
          strokeWidth: strokeWidth(c.strokeWidth),
          opacity: opacity(c.opacity),
        });
        break;
      }
      case 'polygon': {
        if (!Array.isArray(c.points) || c.points.length < 3) break;
        const points: string[] = [];
        for (const point of c.points.slice(0, 64)) {
          if (!Array.isArray(point) || point.length < 2) continue;
          points.push(num(point[0]) + ',' + num(point[1]));
        }
        if (points.length < 3) break;
        out.push({
          op: 'polygon', points: points.join(' '),
          fill: color(c.fill, '#ffffff'),
          stroke: color(c.stroke, 'none'),
          strokeWidth: strokeWidth(c.strokeWidth),
          opacity: opacity(c.opacity),
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function buildPeople(project: Project): ThemeScriptPerson[] {
  const sorted = Object.values(project.people).sort((a, b) => (
    b.score - a.score || String(a.name).localeCompare(String(b.name))
  ));
  let rank = 0;
  let previous: number | null = null;
  return sorted.slice(0, 300).map((p, index) => {
    if (previous === null || p.score !== previous) {
      rank = index + 1;
      previous = p.score;
    }
    return {
      id: String(p.id),
      name: String(p.name || '').slice(0, 40),
      score: Number(p.score) || 0,
      teamId: p.teamId ? String(p.teamId) : null,
      rank,
    };
  });
}

function buildTeams(project: Project): ThemeScriptTeam[] {
  const counts = new Map<string, { total: number; count: number }>();
  for (const p of Object.values(project.people)) {
    if (!p.teamId) continue;
    const current = counts.get(p.teamId) || { total: 0, count: 0 };
    current.total += Number(p.score) || 0;
    current.count += 1;
    counts.set(p.teamId, current);
  }
  return Object.values(project.teams).slice(0, 100).map((t) => {
    const stats = counts.get(t.id) || { total: 0, count: 0 };
    return {
      id: String(t.id),
      name: String(t.name || '').slice(0, 40),
      total: stats.total,
      memberCount: stats.count,
    };
  });
}

function buildCountdown(
  countdown: CountdownRuntime | null | undefined,
  serverNow: number,
): ThemeScriptContext['countdown'] {
  if (!countdown) return null;
  let remaining = Number(countdown.remainingMs);
  if (!Number.isFinite(remaining) && Number.isFinite(Number(countdown.endsAt))) {
    remaining = Math.max(0, Number(countdown.endsAt) - serverNow);
  }
  return {
    state: String(countdown.state || 'ended'),
    remainingMs: Math.max(0, Number.isFinite(remaining) ? remaining : 0),
    durationMs: Math.max(0, Number(countdown.durationMs) || 0),
  };
}

export function buildThemeScriptContext({
  project, settings, runtime, countdown, t, frame, width, height,
}: {
  project: Project;
  settings: Settings;
  runtime: RuntimeSnapshot | null;
  countdown: CountdownRuntime | null;
  t: number;
  frame: number;
  width: number;
  height: number;
}): ThemeScriptContext {
  const people = buildPeople(project);
  const teams = buildTeams(project);
  const scores = people.map((p) => p.score);
  return {
    t,
    frame,
    width,
    height,
    projectName: String(project.name || '').slice(0, 60),
    title: String(settings.title || '').slice(0, 80),
    accent: String(settings.accent || ''),
    theme: String(settings.theme || ''),
    displayStyle: String(settings.displayStyle || ''),
    people,
    teams,
    maxScore: scores.length ? Math.max(...scores) : 0,
    totalScore: scores.reduce((sum, score) => sum + score, 0),
    countdown: buildCountdown(countdown, Number(runtime?.serverNow) || Date.now()),
  };
}
