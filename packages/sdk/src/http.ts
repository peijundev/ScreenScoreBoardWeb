import { ScreenScoreBoardError } from './errors.js';
import type { AuthStatus, Query, User } from './types.js';

const SESSION_COOKIE = 'ssb_session';
const CSRF_COOKIE = 'ssb_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ClientOptions {
  /** 服务根地址，例如 https://score.example.com；默认 http://127.0.0.1:3000 */
  baseUrl?: string;
  /** API 令牌，推荐用于 AI / 自动化；与 Cookie 会话二选一 */
  token?: string;
  username?: string;
  password?: string;
  /** 账号密码登录时是否申请长期会话，默认 true */
  remember?: boolean;
  /** 已有会话 Cookie，例如从安全存储恢复 */
  cookie?: string;
  /** 已有 CSRF Token；Node 下可省略，登录响应会自动捕获 */
  csrfToken?: string;
  /** 自定义 fetch（测试、旧 Node 或特殊运行时） */
  fetch?: typeof fetch;
  /** 每个请求都附加的请求头 */
  headers?: HeadersInit;
  /** 请求超时，默认 30000ms；0 表示不超时 */
  timeoutMs?: number;
  /** 浏览器 Cookie 策略，默认 same-origin；跨源且服务端允许凭据时可设为 include */
  credentials?: RequestCredentials;
}

export interface LoginInput {
  username?: string;
  password?: string;
  remember?: boolean;
}

export interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
  /** 原始请求体（上传二进制时使用） */
  rawBody?: BodyInit;
  headers?: HeadersInit;
  signal?: AbortSignal;
  timeoutMs?: number;
  contentType?: string;
  /** 内部使用：登录/状态请求不触发自动登录 */
  skipAutoLogin?: boolean;
  /** 内部使用：不触发 401 自动重登 */
  skipAuthRefresh?: boolean;
  /** 内部使用：登录请求不附加认证头 */
  skipAuthHeaders?: boolean;
  /** 内部使用：CSRF 失败后不重试 */
  skipCsrfRetry?: boolean;
}

export interface ApiResponse<T> {
  data: T;
  meta: Record<string, unknown>;
  response: Response;
}

export interface SessionState {
  cookie?: string;
  csrfToken?: string;
}

export interface McpHttpOptions {
  sessionId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function safeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

function readBrowserCookie(name: string): string | undefined {
  if (typeof document === 'undefined' || typeof document.cookie !== 'string') return undefined;
  const match = new RegExp('(?:^|;\\s*)' + name + '=([^;]*)').exec(document.cookie);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function setCookieValues(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    try {
      return withGetSetCookie.getSetCookie();
    } catch (_) {
      // 某些 fetch 实现会抛出，继续走兼容路径
    }
  }
  const raw = headers.get('set-cookie');
  return raw ? [raw] : [];
}

function isErrorCode(body: unknown, code: string): boolean {
  return Boolean(body) && typeof body === 'object' &&
    (body as { error?: { code?: string } }).error?.code === code;
}

export class HttpClient {
  readonly baseUrl: string;
  readonly apiBase: string;
  readonly mcpUrl: string;

  private readonly fetchImpl: typeof fetch;
  private readonly defaultHeaders: Headers;
  private readonly timeoutMs: number;
  private readonly credentials: RequestCredentials;
  private readonly browser: boolean;

  private token?: string;
  private username?: string;
  private password?: string;
  private remember: boolean;
  private sessionToken?: string;
  private csrfToken?: string;
  private sessionActive = false;
  private loginPromise: Promise<User> | null = null;

  constructor(options: ClientOptions = {}) {
    const rawBase = (options.baseUrl || 'http://127.0.0.1:3000').trim();
    let url: URL;
    try {
      url = new URL(rawBase);
    } catch (_) {
      throw new ScreenScoreBoardError('baseUrl 不是合法 URL：' + rawBase, {
        code: 'INVALID_BASE_URL',
      });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ScreenScoreBoardError('baseUrl 只支持 http/https', { code: 'INVALID_BASE_URL' });
    }
    url.hash = '';
    url.search = '';
    let pathname = url.pathname.replace(/\/+$/, '');
    // 宽容处理：传入完整 API 地址时自动去掉 /api/v1
    if (pathname.endsWith('/api/v1')) pathname = pathname.slice(0, -'/api/v1'.length).replace(/\/+$/, '');
    url.pathname = pathname || '/';
    this.baseUrl = url.toString().replace(/\/+$/, '');
    this.apiBase = this.baseUrl + '/api/v1';
    this.mcpUrl = this.baseUrl + '/mcp';

    const fetchImpl = options.fetch ||
      (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);
    if (!fetchImpl) {
      throw new ScreenScoreBoardError('当前环境没有 fetch，请通过 options.fetch 注入', {
        code: 'FETCH_UNAVAILABLE',
      });
    }
    this.fetchImpl = fetchImpl;
    this.defaultHeaders = new Headers(options.headers || {});
    this.timeoutMs = options.timeoutMs == null ? 30_000 : Math.max(0, Number(options.timeoutMs) || 0);
    this.credentials = options.credentials || 'same-origin';
    this.browser = typeof document !== 'undefined' && typeof document.cookie === 'string';
    this.username = options.username?.trim() || undefined;
    this.password = options.password;
    this.remember = options.remember !== false;
    this.token = options.token?.trim() || undefined;
    if (options.cookie) this.applyCookieHeader(options.cookie);
    if (options.csrfToken) this.csrfToken = options.csrfToken;
    if (this.sessionToken || options.cookie || options.csrfToken) this.sessionActive = true;
    if (this.token) this.sessionActive = false;
  }

  get isBrowser(): boolean {
    return this.browser;
  }

  get hasToken(): boolean {
    return Boolean(this.token);
  }

  getSession(): SessionState {
    return {
      cookie: this.cookieHeader() || undefined,
      csrfToken: this.getCsrfToken(),
    };
  }

  setToken(token?: string): void {
    this.token = token?.trim() || undefined;
    if (this.token) {
      this.sessionToken = undefined;
      this.csrfToken = undefined;
      this.sessionActive = false;
    }
  }

  clearToken(): void {
    this.token = undefined;
  }

  setSession(session: SessionState = {}): void {
    this.token = undefined;
    this.sessionToken = undefined;
    this.csrfToken = undefined;
    this.sessionActive = false;
    if (session.cookie) this.applyCookieHeader(session.cookie);
    if (session.csrfToken) this.csrfToken = session.csrfToken;
    if (this.sessionToken || this.csrfToken) this.sessionActive = true;
  }

  clearSession(): void {
    this.sessionToken = undefined;
    this.csrfToken = undefined;
    this.sessionActive = false;
  }

  async login(input: LoginInput = {}): Promise<User> {
    if (input.username !== undefined) this.username = input.username;
    if (input.password !== undefined) this.password = input.password;
    if (input.remember !== undefined) this.remember = input.remember;
    if (!this.username || !this.password) {
      throw new ScreenScoreBoardError('登录需要 username 与 password', { code: 'AUTH_REQUIRED' });
    }
    return this.loginOnce();
  }

  async logout(): Promise<void> {
    try {
      if (this.token || this.sessionToken || this.sessionActive || this.getCsrfToken()) {
        await this.request('POST', '/auth/logout', {
          skipAutoLogin: true,
          skipAuthRefresh: true,
        });
      }
    } catch (_) {
      // 服务端登出失败也要清掉本地状态，避免 SDK 继续带着失效凭据
    } finally {
      this.clearToken();
      this.clearSession();
    }
  }

  async status(): Promise<AuthStatus> {
    const { data, response } = await this.requestEnvelope<AuthStatus>('GET', '/auth/status', {
      skipAutoLogin: true,
      skipAuthRefresh: true,
    });
    this.captureCookies(response);
    this.sessionActive = Boolean(data.authenticated);
    return data;
  }

  /** 读取/补发 CSRF Cookie；浏览器下会重新读取 document.cookie。 */
  async refreshCsrf(): Promise<string | undefined> {
    if (this.browser) {
      const fromCookie = readBrowserCookie(CSRF_COOKIE);
      if (fromCookie) {
        this.csrfToken = fromCookie;
        return fromCookie;
      }
    }
    try {
      const { response } = await this.requestEnvelope('GET', '/auth/status', {
        skipAutoLogin: true,
        skipAuthRefresh: true,
        skipCsrfRetry: true,
      });
      this.captureCookies(response);
    } catch (_) {
      // 状态接口失败时保留原 CSRF，让后续请求给出真实错误
    }
    return this.getCsrfToken();
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const { data } = await this.requestEnvelope<T>(method, path, options);
    return data;
  }

  async requestEnvelope<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    if (!options.skipAutoLogin) await this.ensureAuth();
    let response = await this.send(method, path, options);
    let json = await this.readJson(response);

    if (!options.skipCsrfRetry && !this.token &&
      response.status === 403 && isErrorCode(json, 'CSRF_FAILED')) {
      const csrf = await this.refreshCsrf();
      if (csrf) {
        response = await this.send(method, path, options);
        json = await this.readJson(response);
      }
    }

    if (!options.skipAuthRefresh && !this.token && this.username && this.password &&
      response.status === 401) {
      this.clearSession();
      await this.loginOnce();
      response = await this.send(method, path, options);
      json = await this.readJson(response);
    }

    if (!response.ok || (json && typeof json === 'object' && 'error' in json)) {
      throw this.errorFromResponse(response, json);
    }

    let data: T;
    let meta: Record<string, unknown> = {};
    if (json && typeof json === 'object' && 'data' in json) {
      const envelope = json as { data: T; meta?: Record<string, unknown> };
      data = envelope.data;
      meta = envelope.meta || {};
    } else {
      data = json as T;
    }
    return { data, meta, response };
  }

  /** 返回原始响应；非 2xx 会抛出 ScreenScoreBoardError。适合导出/下载。 */
  async requestRaw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    if (!options.skipAutoLogin) await this.ensureAuth();
    const response = await this.send(method, path, options);
    if (!response.ok) {
      const json = await this.readJson(response);
      throw this.errorFromResponse(response, json);
    }
    return response;
  }

  async requestText(method: string, path: string, options: RequestOptions = {}): Promise<string> {
    const response = await this.requestRaw(method, path, options);
    return response.text();
  }

  async requestBinary(method: string, path: string, options: RequestOptions = {}): Promise<Uint8Array> {
    const response = await this.requestRaw(method, path, options);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** 发送 MCP JSON-RPC 请求；返回原始 JSON 与响应（含 Mcp-Session-Id）。 */
  async mcpRequest(
    message: unknown,
    options: McpHttpOptions = {},
  ): Promise<{ json: unknown; response: Response }> {
    await this.ensureAuth();

    const doSend = (): Promise<Response> => {
      const headers = new Headers(this.defaultHeaders);
      headers.set('Accept', 'application/json');
      headers.set('Content-Type', 'application/json');
      this.applyAuthHeaders(headers, 'POST');
      if (options.sessionId) headers.set('Mcp-Session-Id', options.sessionId);
      return this.execute(
        new URL(this.mcpUrl),
        {
          method: 'POST',
          headers,
          body: JSON.stringify(message),
          credentials: this.credentials,
        },
        options.timeoutMs,
        options.signal,
      );
    };

    let response = await doSend();
    let json = await this.readJson(response);
    if (!this.token && response.status === 403 && isErrorCode(json, 'CSRF_FAILED')) {
      const csrf = await this.refreshCsrf();
      if (csrf) {
        response = await doSend();
        json = await this.readJson(response);
      }
    }
    if (!this.token && this.username && this.password && response.status === 401) {
      this.clearSession();
      await this.loginOnce();
      response = await doSend();
      json = await this.readJson(response);
    }
    if (!response.ok) throw this.errorFromResponse(response, json);
    return { json, response };
  }

  private async ensureAuth(): Promise<void> {
    if (this.token || this.sessionToken || this.sessionActive) return;
    if (this.username && this.password) {
      await this.loginOnce();
      return;
    }
    if (this.browser) {
      const csrf = readBrowserCookie(CSRF_COOKIE);
      if (csrf) this.csrfToken = csrf;
    }
  }

  private loginOnce(): Promise<User> {
    if (!this.loginPromise) {
      this.loginPromise = this.loginInternal().finally(() => {
        this.loginPromise = null;
      });
    }
    return this.loginPromise;
  }

  private async loginInternal(): Promise<User> {
    if (!this.username || !this.password) {
      throw new ScreenScoreBoardError('登录需要 username 与 password', { code: 'AUTH_REQUIRED' });
    }
    const response = await this.send('POST', '/auth/login', {
      body: {
        username: this.username,
        password: this.password,
        remember: this.remember,
      },
      skipAutoLogin: true,
      skipAuthRefresh: true,
      skipAuthHeaders: true,
      skipCsrfRetry: true,
    });
    const json = await this.readJson(response);
    if (!response.ok) throw this.errorFromResponse(response, json);
    this.captureCookies(response);
    if (this.browser) {
      this.sessionActive = true;
      this.csrfToken = readBrowserCookie(CSRF_COOKIE) || this.csrfToken;
      if (!this.csrfToken) await this.refreshCsrf();
    } else if (!this.sessionToken) {
      throw new ScreenScoreBoardError(
        '登录成功但响应没有 ssb_session Cookie；请使用支持 Set-Cookie 的 fetch，或改用 API 令牌',
        { code: 'NO_SESSION_COOKIE', status: response.status, body: json },
      );
    }
    const user = json && typeof json === 'object'
      ? (json as { data?: { user?: User } }).data?.user
      : undefined;
    if (!user) {
      throw new ScreenScoreBoardError('登录响应缺少用户信息', {
        code: 'INVALID_LOGIN_RESPONSE',
        status: response.status,
        body: json,
      });
    }
    return user;
  }

  private applyCookieHeader(cookie: string): void {
    for (const part of cookie.split(';')) {
      const index = part.indexOf('=');
      if (index <= 0) continue;
      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (name === SESSION_COOKIE && value) this.sessionToken = value;
      if (name === CSRF_COOKIE && value) this.csrfToken = value;
    }
  }

  private captureCookies(response: Response): void {
    for (const line of setCookieValues(response.headers)) {
      for (const name of [SESSION_COOKIE, CSRF_COOKIE]) {
        const match = new RegExp('(?:^|,\\s*)' + name + '=([^;,]*)').exec(line);
        if (!match) continue;
        const value = match[1].trim();
        if (name === SESSION_COOKIE) {
          this.sessionToken = value || undefined;
          this.sessionActive = Boolean(value);
        } else {
          this.csrfToken = value || undefined;
        }
      }
    }
    if (this.browser) {
      const csrf = readBrowserCookie(CSRF_COOKIE);
      if (csrf) this.csrfToken = csrf;
    }
  }

  private getCsrfToken(): string | undefined {
    if (this.csrfToken) return this.csrfToken;
    if (this.browser) return readBrowserCookie(CSRF_COOKIE);
    return undefined;
  }

  private cookieHeader(): string {
    const pairs: string[] = [];
    if (this.sessionToken) pairs.push(SESSION_COOKIE + '=' + this.sessionToken);
    if (this.csrfToken) pairs.push(CSRF_COOKIE + '=' + this.csrfToken);
    return pairs.join('; ');
  }

  private applyAuthHeaders(headers: Headers, method: string): void {
    if (this.token) {
      headers.set('Authorization', 'Bearer ' + this.token);
      return;
    }
    if (!this.browser && this.sessionToken) {
      headers.set('Cookie', this.cookieHeader());
    }
    if (!safeMethod(method)) {
      const csrf = this.getCsrfToken();
      if (csrf) headers.set('X-CSRF-Token', csrf);
    }
  }

  private async send(
    method: string,
    path: string,
    options: RequestOptions,
  ): Promise<Response> {
    const url = this.buildUrl(path, options.query);
    const headers = new Headers(this.defaultHeaders);
    headers.set('Accept', 'application/json');
    if (options.headers) {
      new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    }
    if (!options.skipAuthHeaders) this.applyAuthHeaders(headers, method);

    let body: BodyInit | undefined;
    if (options.rawBody !== undefined) {
      body = options.rawBody;
      if (options.contentType) headers.set('Content-Type', options.contentType);
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers.set('Content-Type', 'application/json');
    }

    return this.execute(
      url,
      {
        method: method.toUpperCase(),
        headers,
        body,
        credentials: this.credentials,
      },
      options.timeoutMs,
      options.signal,
    );
  }

  private buildUrl(path: string, query?: Query): URL {
    const suffix = path.startsWith('/') ? path : '/' + path;
    const url = new URL(this.apiBase + suffix);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value == null) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item != null) url.searchParams.append(key, String(item));
          }
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url;
  }

  private async execute(
    url: URL,
    init: RequestInit,
    timeoutMs?: number,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const duration = timeoutMs == null ? this.timeoutMs : Math.max(0, Number(timeoutMs) || 0);
    const timer = duration > 0
      ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, duration)
      : null;
    const onAbort = (): void => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (timedOut) {
        throw new ScreenScoreBoardError('请求超时（' + duration + 'ms）', {
          code: 'TIMEOUT',
          cause: error,
        });
      }
      if (externalSignal?.aborted) {
        throw new ScreenScoreBoardError('请求已取消', { code: 'ABORTED', cause: error });
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ScreenScoreBoardError('网络请求失败：' + message, {
        code: 'NETWORK_ERROR',
        cause: error,
      });
    } finally {
      if (timer) clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return text;
    }
  }

  private errorFromResponse(response: Response, body: unknown): ScreenScoreBoardError {
    const error = body && typeof body === 'object'
      ? (body as { error?: { code?: string; message?: string; details?: unknown } }).error
      : undefined;
    const message = error?.message ||
      (typeof body === 'string' && body.trim() ? body : response.statusText) ||
      ('HTTP ' + response.status);
    const requestId = body && typeof body === 'object'
      ? (body as { meta?: { requestId?: string } }).meta?.requestId
      : undefined;
    return new ScreenScoreBoardError(message, {
      status: response.status,
      code: error?.code || 'HTTP_ERROR',
      details: error?.details,
      requestId,
      body,
    });
  }
}
