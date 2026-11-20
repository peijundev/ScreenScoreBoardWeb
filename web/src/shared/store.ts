import { create } from 'zustand';
import { connectWS, type Connection, type SendOp } from './ws';
import type { OpName } from './ops.generated';
import type { Project, RuntimeSnapshot, Snapshot } from './types';

interface AppState {
  connected: boolean;
  snapshot: Snapshot | null;
  runtime: RuntimeSnapshot | null;
  sendOp: SendOp;
}

const notConnected: SendOp = () => Promise.reject(new Error('尚未连接到服务器'));

export const useAppStore = create<AppState>(() => ({
  connected: false,
  snapshot: null,
  runtime: null,
  sendOp: notConnected,
}));

// ---------- 快照稳定化 ----------
// 服务端每次广播都是全新的 JSON 对象。这里把未变化的项目/人员/团队/设置复用旧引用，
// 让 React.memo 与 useMemo 能跳过未变化的部分，避免整屏重渲染。
function valueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => valueEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      valueEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    );
  }
  return false;
}

function stabilizeMap<T extends object>(
  prev: Record<string, T> | undefined,
  next: Record<string, T>,
): { map: Record<string, T>; changed: boolean } {
  let changed = false;
  const out: Record<string, T> = {};
  if (prev && Object.keys(prev).length !== Object.keys(next).length) changed = true;
  for (const [id, item] of Object.entries(next)) {
    const old = prev?.[id];
    if (old && valueEqual(old, item)) {
      out[id] = old;
    } else {
      out[id] = item;
      changed = true;
    }
  }
  return { map: changed || !prev ? out : prev, changed };
}

function stabilizeProject(prev: Project | undefined, next: Project): Project {
  if (!prev) return next;
  const people = stabilizeMap(prev.people, next.people);
  const teams = stabilizeMap(prev.teams, next.teams);
  const settingsEqual = valueEqual(prev.settings, next.settings);
  if (!people.changed && !teams.changed && settingsEqual &&
    prev.name === next.name && prev.createdAt === next.createdAt &&
    prev.themeId === next.themeId && prev.themeRevision === next.themeRevision) {
    return prev;
  }
  return {
    ...next,
    people: people.map,
    teams: teams.map,
    settings: settingsEqual ? prev.settings : next.settings,
  };
}

function stabilizeSnapshot(prev: Snapshot | null, next: Snapshot): Snapshot {
  if (!prev) return next;
  let changed = Object.keys(prev.projects).length !== Object.keys(next.projects).length;
  const projects: Record<string, Project> = {};
  for (const [id, project] of Object.entries(next.projects)) {
    const old = prev.projects[id];
    const stable = stabilizeProject(old, project);
    projects[id] = stable;
    if (stable !== old) changed = true;
  }
  if (!changed) return prev;
  return { ...next, projects };
}

let prevSnapshot: Snapshot | null = null;
let started = false;
let conn: Connection | null = null;

export interface StartConnectionOptions {
  onAuthLost?: (reason: 'expired' | 'forbidden') => void;
}

/** 建立唯一一条 WS 连接；重复调用无副作用 */
export function startConnection(options: StartConnectionOptions = {}): void {
  if (started) return;
  started = true;
  prevSnapshot = null;
  conn = connectWS(
    (snapshot, runtime) => {
      prevSnapshot = stabilizeSnapshot(prevSnapshot, snapshot);
      useAppStore.setState({ snapshot: prevSnapshot, runtime });
    },
    (status) => useAppStore.setState({ connected: status === 'connected' }),
    {
      onAuthLost: (reason) => {
        stopConnection();
        options.onAuthLost?.(reason);
      },
    },
  );
  useAppStore.setState({ sendOp: conn.sendOp });
}

/** 停止连接并清空快照；登出/会话失效时调用 */
export function stopConnection(): void {
  started = false;
  const current = conn;
  conn = null;
  if (current) current.close();
  prevSnapshot = null;
  useAppStore.setState({
    connected: false,
    snapshot: null,
    runtime: null,
    sendOp: notConnected,
  });
}

/** 按创建时间升序的项目列表 */
export function projectsOf(snapshot: Snapshot | null): Project[] {
  if (!snapshot) return [];
  return Object.values(snapshot.projects).sort((a, b) => a.createdAt - b.createdAt);
}

/** 指定 id 的项目，不存在则退回最早创建的项目 */
export function projectOf(snapshot: Snapshot | null, projectId: string | null): Project | null {
  if (!snapshot) return null;
  if (projectId && snapshot.projects[projectId]) return snapshot.projects[projectId];
  return projectsOf(snapshot)[0] ?? null;
}

/** 项目级 op：自动带上 projectId */
export function projectOp(
  projectId: string,
  op: OpName,
  payload?: Record<string, unknown>,
): Promise<unknown> {
  return useAppStore.getState().sendOp(op, { projectId, ...(payload ?? {}) });
}
