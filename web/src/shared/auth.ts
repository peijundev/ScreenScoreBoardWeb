import { create } from 'zustand';

export type Role = 'admin' | 'operator' | 'member' | 'viewer';

export interface AuthUser {
  id: string;
  username: string;
  displayName?: string;
  role: Role;
  /** 队员账号绑定的项目与人员；其他角色为 null。 */
  memberProjectId?: string | null;
  memberPersonId?: string | null;
  disabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastLoginAt?: string | null;
}

export interface AuthStatus {
  authEnabled: boolean;
  openAccess?: boolean;
  requireLogin?: boolean;
  setupRequired: boolean;
  setupAllowed: boolean;
  authenticated: boolean;
  user: AuthUser | null;
}

export interface AccessSettings {
  requireLogin: boolean;
  openAccess: boolean;
  activeAdmins: number;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  ip: string;
  userAgent: string;
  remember: boolean;
  current: boolean;
}

export interface TokenInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

interface ApiEnvelope<T> {
  data: T;
  error?: { code?: string; message?: string };
}

export function readCsrfToken(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('ssb_csrf='));
  return match ? decodeURIComponent(match.slice('ssb_csrf='.length)) : '';
}

function isSafeMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

async function parseEnvelope<T>(res: Response): Promise<T> {
  let body: ApiEnvelope<T> | null = null;
  try {
    body = (await res.json()) as ApiEnvelope<T>;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = body?.error?.message || '请求失败 (' + res.status + ')';
    const error = new Error(message) as Error & { code?: string; status?: number };
    error.code = body?.error?.code;
    error.status = res.status;
    throw error;
  }
  return (body?.data ?? null) as T;
}

/** 带 Cookie、CSRF 与 401/403 处理的同源请求 */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const method = String(init.method || 'GET').toUpperCase();
  const send = async (csrf: string): Promise<Response> => {
    const headers = new Headers(init.headers || {});
    if (!isSafeMethod(method) && csrf) headers.set('X-CSRF-Token', csrf);
    return fetch(input, {
      ...init,
      method,
      headers,
      credentials: 'same-origin',
    });
  };
  let res = await send(readCsrfToken());
  const publicAuthEndpoint = /\/api\/v1\/auth\/(status|login|logout|setup)(\?|$)/.test(input);
  if (res.status === 401 && !publicAuthEndpoint) {
    useAuthStore.getState().markAuthLost();
  }
  if (res.status === 403) {
    let code = '';
    try {
      const body = (await res.clone().json()) as ApiEnvelope<unknown>;
      code = body?.error?.code || '';
    } catch {
      code = '';
    }
    if (code === 'CSRF_FAILED') {
      try {
        await getAuthStatus();
        res = await send(readCsrfToken());
      } catch {
        // 保留原始 403
      }
    }
  }
  return res;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const res = await fetch('/api/v1/auth/status', { credentials: 'same-origin' });
  return parseEnvelope<AuthStatus>(res);
}

export async function login(
  username: string,
  password: string,
  remember: boolean,
): Promise<AuthUser> {
  const res = await authFetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, remember }),
  });
  const data = await parseEnvelope<{ user: AuthUser }>(res);
  return data.user;
}

export async function setup(username: string, password: string): Promise<AuthUser> {
  const res = await authFetch('/api/v1/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await parseEnvelope<{ user: AuthUser }>(res);
  return data.user;
}

export async function logout(): Promise<void> {
  await authFetch('/api/v1/auth/logout', { method: 'POST' });
}

export async function getAccessSettings(): Promise<AccessSettings> {
  const res = await authFetch('/api/v1/auth/access');
  return parseEnvelope<AccessSettings>(res);
}

export async function updateAccessSettings(requireLogin: boolean): Promise<AccessSettings> {
  const res = await authFetch('/api/v1/auth/access', jsonInit('PATCH', { requireLogin }));
  return parseEnvelope<AccessSettings>(res);
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await authFetch('/api/v1/auth/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  await parseEnvelope<{ ok: boolean }>(res);
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function listUsers(): Promise<AuthUser[]> {
  const res = await authFetch('/api/v1/auth/users');
  return (await parseEnvelope<{ users: AuthUser[] }>(res)).users;
}

export async function createUser(input: {
  username: string;
  password: string;
  role: Role;
  displayName?: string;
  memberProjectId?: string | null;
  memberPersonId?: string | null;
}): Promise<AuthUser> {
  const res = await authFetch('/api/v1/auth/users', jsonInit('POST', input));
  return (await parseEnvelope<{ user: AuthUser }>(res)).user;
}

export async function updateUser(
  id: string,
  patch: {
    role?: Role;
    displayName?: string;
    disabled?: boolean;
    memberProjectId?: string | null;
    memberPersonId?: string | null;
  },
): Promise<AuthUser> {
  const res = await authFetch('/api/v1/auth/users/' + encodeURIComponent(id), jsonInit('PATCH', patch));
  return (await parseEnvelope<{ user: AuthUser }>(res)).user;
}

/** 批量停用/启用所有 role=member 的账号（全局，影响所有项目）。 */
export async function setMembersDisabled(
  disabled: boolean,
): Promise<{ count: number; total: number; disabled: boolean }> {
  const res = await authFetch(
    '/api/v1/auth/users/members/disabled',
    jsonInit('POST', { disabled }),
  );
  return parseEnvelope<{ count: number; total: number; disabled: boolean }>(res);
}

export async function resetUserPassword(id: string, password: string): Promise<void> {
  const res = await authFetch(
    '/api/v1/auth/users/' + encodeURIComponent(id) + '/password',
    jsonInit('POST', { password }),
  );
  await parseEnvelope<{ ok: boolean }>(res);
}

export async function deleteUser(id: string): Promise<void> {
  const res = await authFetch('/api/v1/auth/users/' + encodeURIComponent(id), { method: 'DELETE' });
  await parseEnvelope<{ ok: boolean }>(res);
}

export async function listSessions(userId?: string): Promise<SessionInfo[]> {
  const suffix = userId ? '?userId=' + encodeURIComponent(userId) : '';
  const res = await authFetch('/api/v1/auth/sessions' + suffix);
  return (await parseEnvelope<{ sessions: SessionInfo[] }>(res)).sessions;
}

export async function revokeSession(id: string): Promise<void> {
  const res = await authFetch('/api/v1/auth/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
  await parseEnvelope<{ ok: boolean }>(res);
}

export async function logoutAll(): Promise<number> {
  const res = await authFetch('/api/v1/auth/logout-all', { method: 'POST' });
  return (await parseEnvelope<{ removed: number }>(res)).removed;
}

export async function listTokens(userId?: string): Promise<TokenInfo[]> {
  const suffix = userId ? '?userId=' + encodeURIComponent(userId) : '';
  const res = await authFetch('/api/v1/auth/tokens' + suffix);
  return (await parseEnvelope<{ tokens: TokenInfo[] }>(res)).tokens;
}

export async function createToken(input: {
  name: string;
  expiresAt?: string | null;
  userId?: string;
}): Promise<{ token: string } & TokenInfo> {
  const res = await authFetch('/api/v1/auth/tokens', jsonInit('POST', input));
  return parseEnvelope<{ token: string } & TokenInfo>(res);
}

export async function revokeToken(id: string): Promise<void> {
  const res = await authFetch('/api/v1/auth/tokens/' + encodeURIComponent(id), { method: 'DELETE' });
  await parseEnvelope<{ ok: boolean }>(res);
}

export async function listUserSessions(userId: string): Promise<SessionInfo[]> {
  const res = await authFetch('/api/v1/auth/users/' + encodeURIComponent(userId) + '/sessions');
  return (await parseEnvelope<{ sessions: SessionInfo[] }>(res)).sessions;
}

export async function revokeUserSession(userId: string, sessionId: string): Promise<void> {
  const res = await authFetch(
    '/api/v1/auth/users/' + encodeURIComponent(userId) + '/sessions/' + encodeURIComponent(sessionId),
    { method: 'DELETE' },
  );
  await parseEnvelope<{ ok: boolean }>(res);
}

export async function listUserTokens(userId: string): Promise<TokenInfo[]> {
  const res = await authFetch('/api/v1/auth/users/' + encodeURIComponent(userId) + '/tokens');
  return (await parseEnvelope<{ tokens: TokenInfo[] }>(res)).tokens;
}

export async function createUserToken(
  userId: string,
  input: { name: string; expiresAt?: string | null },
): Promise<{ token: string } & TokenInfo> {
  const res = await authFetch(
    '/api/v1/auth/users/' + encodeURIComponent(userId) + '/tokens',
    jsonInit('POST', input),
  );
  return parseEnvelope<{ token: string } & TokenInfo>(res);
}

export async function revokeUserToken(userId: string, tokenId: string): Promise<void> {
  const res = await authFetch(
    '/api/v1/auth/users/' + encodeURIComponent(userId) + '/tokens/' + encodeURIComponent(tokenId),
    { method: 'DELETE' },
  );
  await parseEnvelope<{ ok: boolean }>(res);
}

interface AuthStore {
  loading: boolean;
  status: AuthStatus | null;
  authLost: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setStatus: (status: AuthStatus) => void;
  markAuthLost: () => void;
  login: (username: string, password: string, remember: boolean) => Promise<void>;
  setup: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  loading: true,
  status: null,
  authLost: false,
  error: null,
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const status = await getAuthStatus();
      set({ status, loading: false, authLost: false });
    } catch (error) {
      set({ loading: false, error: (error as Error).message });
    }
  },
  setStatus: (status) => set({ status, authLost: false, error: null }),
  markAuthLost: () =>
    set((state) => ({
      authLost: true,
      status: state.status
        ? { ...state.status, authenticated: false, user: null }
        : state.status,
    })),
  login: async (username, password, remember) => {
    await login(username, password, remember);
    const status = await getAuthStatus();
    set({ status, authLost: false, error: null });
  },
  setup: async (username, password) => {
    await setup(username, password);
    const status = await getAuthStatus();
    set({ status, authLost: false, error: null });
  },
  logout: async () => {
    try {
      await logout();
    } catch {
      // 即使请求失败也清空本地登录态
    }
    const status = await getAuthStatus().catch(() => null);
    set((state) => ({
      status: status || (state.status ? { ...state.status, authenticated: false, user: null } : null),
      authLost: false,
    }));
  },
}));

/** 关闭时清空敏感状态；显示端也会引入本模块，但不会用到这个函数 */
export function resetAuthStore(): void {
  useAuthStore.setState({ loading: false, status: null, authLost: false, error: null });
}
