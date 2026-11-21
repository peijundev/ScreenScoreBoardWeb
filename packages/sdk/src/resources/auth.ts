import type { HttpClient } from '../http.js';
import { enc } from '../path.js';
import type {
  AccessSettings,
  ApiToken,
  AuthSession,
  AuthStatus,
  CreateTokenInput,
  CreateUserInput,
  MeResult,
  UpdateUserInput,
  User,
} from '../types.js';

export class AuthUsersApi {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<User[]> {
    return this.http
      .request<{ users: User[] }>('GET', '/auth/users')
      .then((result) => result.users);
  }

  create(input: CreateUserInput): Promise<User> {
    return this.http
      .request<{ user: User }>('POST', '/auth/users', { body: input })
      .then((result) => result.user);
  }

  update(userId: string, patch: UpdateUserInput): Promise<User> {
    return this.http
      .request<{ user: User }>('PATCH', `/auth/users/${enc(userId)}`, { body: patch })
      .then((result) => result.user);
  }

  delete(userId: string): Promise<{ ok: boolean }> {
    return this.http.request<{ ok: boolean }>('DELETE', `/auth/users/${enc(userId)}`);
  }

  resetPassword(userId: string, password: string): Promise<{ ok: boolean }> {
    return this.http.request<{ ok: boolean }>(
      'POST',
      `/auth/users/${enc(userId)}/password`,
      { body: { password } },
    );
  }

  sessions(userId: string): Promise<AuthSession[]> {
    return this.http
      .request<{ sessions: AuthSession[] }>(
        'GET',
        `/auth/users/${enc(userId)}/sessions`,
      )
      .then((result) => result.sessions);
  }

  revokeSession(userId: string, sessionId: string): Promise<{ ok: boolean }> {
    return this.http.request<{ ok: boolean }>(
      'DELETE',
      `/auth/users/${enc(userId)}/sessions/${enc(sessionId)}`,
    );
  }

  tokens(userId: string): Promise<ApiToken[]> {
    return this.http
      .request<{ tokens: ApiToken[] }>('GET', `/auth/users/${enc(userId)}/tokens`)
      .then((result) => result.tokens);
  }

  createToken(
    userId: string,
    name = 'API 令牌',
    expiresAt?: string | null,
  ): Promise<ApiToken> {
    return this.http.request<ApiToken>(
      'POST',
      `/auth/users/${enc(userId)}/tokens`,
      { body: { name, expiresAt } },
    );
  }

  revokeToken(userId: string, tokenId: string): Promise<{ ok: boolean }> {
    return this.http.request<{ ok: boolean }>(
      'DELETE',
      `/auth/users/${enc(userId)}/tokens/${enc(tokenId)}`,
    );
  }
}

export class AuthSessionsApi {
  constructor(private readonly http: HttpClient) {}

  list(userId?: string): Promise<AuthSession[]> {
    return this.http
      .request<{ sessions: AuthSession[] }>('GET', '/auth/sessions', {
        query: { userId },
      })
      .then((result) => result.sessions);
  }

  revoke(sessionId: string): Promise<{ ok: boolean }> {
    return this.http.request<{ ok: boolean }>(
      'DELETE',
      `/auth/sessions/${enc(sessionId)}`,
    );
  }

  logoutAll(): Promise<{ removed: number }> {
    return this.http.request<{ removed: number }>('POST', '/auth/logout-all');
  }
}

export class AuthTokensApi {
  constructor(private readonly http: HttpClient) {}

  list(userId?: string): Promise<ApiToken[]> {
    return this.http
      .request<{ tokens: ApiToken[] }>('GET', '/auth/tokens', { query: { userId } })
      .then((result) => result.tokens);
  }

  /** 明文 token 只在本次响应中返回一次，请立即安全保存。 */
  create(input: CreateTokenInput = {}): Promise<ApiToken> {
    return this.http.request<ApiToken>('POST', '/auth/tokens', {
      body: {
        name: input.name || 'API 令牌',
        userId: input.userId,
        expiresAt: input.expiresAt,
      },
    });
  }

  revoke(tokenId: string): Promise<{ ok: boolean }> {
    return this.http.request<{ ok: boolean }>(
      'DELETE',
      `/auth/tokens/${enc(tokenId)}`,
    );
  }
}

export class AuthApi {
  readonly users: AuthUsersApi;
  readonly sessions: AuthSessionsApi;
  readonly tokens: AuthTokensApi;

  constructor(private readonly http: HttpClient) {
    this.users = new AuthUsersApi(http);
    this.sessions = new AuthSessionsApi(http);
    this.tokens = new AuthTokensApi(http);
  }

  status(): Promise<AuthStatus> {
    return this.http.status();
  }

  login(username: string, password: string, remember = true): Promise<User> {
    return this.http.login({ username, password, remember });
  }

  logout(): Promise<void> {
    return this.http.logout();
  }

  setup(username: string, password: string): Promise<User> {
    return this.http
      .request<{ user: User }>('POST', '/auth/setup', { body: { username, password } })
      .then((result) => result.user);
  }

  me(): Promise<MeResult> {
    return this.http.request<MeResult>('GET', '/auth/me');
  }

  getAccess(): Promise<AccessSettings> {
    return this.http.request<AccessSettings>('GET', '/auth/access');
  }

  /**
   * 启用/关闭登录系统。`requireLogin: false` 会让所有访问者获得管理员权限。
   * 至少需要一个启用中的管理员。
   */
  updateAccess(requireLogin: boolean): Promise<AccessSettings> {
    return this.http.request<AccessSettings>('PATCH', '/auth/access', {
      body: { requireLogin },
    });
  }

  changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    return this.http.request<{ ok: boolean }>('POST', '/auth/password', {
      body: { currentPassword, newPassword },
      // 当前密码错误也是 401；这里不应触发“会话过期自动重登再试”
      skipAuthRefresh: true,
    });
  }
}
