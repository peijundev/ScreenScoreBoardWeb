import { create } from 'zustand';
import { connectWS, type SendOp } from './ws';
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

let started = false;

/** 建立唯一一条 WS 连接；重复调用无副作用 */
export function startConnection(): void {
  if (started) return;
  started = true;
  const conn = connectWS(
    (snapshot, runtime) => useAppStore.setState({ snapshot, runtime }),
    (status) => useAppStore.setState({ connected: status === 'connected' }),
  );
  useAppStore.setState({ sendOp: conn.sendOp });
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
