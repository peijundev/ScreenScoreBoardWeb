import {
  HttpClient,
  type ApiResponse,
  type ClientOptions,
  type LoginInput,
  type RequestOptions,
  type SessionState,
} from './http.js';
import { McpClient, type McpClientOptions } from './mcp.js';
import type { User } from './types.js';
import { AuthApi } from './resources/auth.js';
import { DataApi } from './resources/data.js';
import { OpsApi } from './resources/ops.js';
import { PeopleApi } from './resources/people.js';
import { ProjectsApi } from './resources/projects.js';
import { ScoresApi } from './resources/scores.js';
import { SettingsApi } from './resources/settings.js';
import { SpotlightApi } from './resources/spotlight.js';
import { SystemApi } from './resources/system.js';
import { TeamsApi } from './resources/teams.js';
import { ThemesApi } from './resources/themes.js';
import { RuntimeApi } from './resources/runtime.js';

export interface ScreenScoreBoardClientOptions extends ClientOptions {
  mcp?: McpClientOptions;
}

/**
 * ScreenScoreBoard REST v1 + MCP 客户端。
 *
 * - `token`：推荐用于 AI / 自动化，不需要 CSRF。
 * - `username` + `password`：首次请求前自动登录，Node 下自动维护 Cookie 与 CSRF。
 * - `http.request()`：未封装端点的统一逃生通道。
 */
export class ScreenScoreBoardClient {
  readonly http: HttpClient;
  readonly api: HttpClient;
  readonly auth: AuthApi;
  readonly system: SystemApi;
  readonly projects: ProjectsApi;
  readonly people: PeopleApi;
  readonly teams: TeamsApi;
  readonly scores: ScoresApi;
  readonly spotlight: SpotlightApi;
  readonly settings: SettingsApi;
  readonly runtime: RuntimeApi;
  readonly themes: ThemesApi;
  readonly ops: OpsApi;
  readonly data: DataApi;
  readonly mcp: McpClient;

  constructor(options: ScreenScoreBoardClientOptions = {}) {
    this.http = new HttpClient(options);
    this.api = this.http;
    this.auth = new AuthApi(this.http);
    this.system = new SystemApi(this.http);
    this.projects = new ProjectsApi(this.http);
    this.people = new PeopleApi(this.http);
    this.teams = new TeamsApi(this.http);
    this.scores = new ScoresApi(this.http);
    this.spotlight = new SpotlightApi(this.http);
    this.settings = new SettingsApi(this.http);
    this.runtime = new RuntimeApi(this.http);
    this.themes = new ThemesApi(this.http);
    this.ops = new OpsApi(this.http);
    this.data = new DataApi(this.http);
    this.mcp = new McpClient(this.http, options.mcp);
  }

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  login(input: LoginInput = {}): Promise<User> {
    return this.http.login(input);
  }

  logout(): Promise<void> {
    return this.http.logout();
  }

  getSession(): SessionState {
    return this.http.getSession();
  }

  setToken(token?: string): void {
    this.http.setToken(token);
  }

  setSession(session: SessionState): void {
    this.http.setSession(session);
  }

  clearSession(): void {
    this.http.clearSession();
  }

  request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    return this.http.request<T>(method, path, options);
  }

  requestEnvelope<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    return this.http.requestEnvelope<T>(method, path, options);
  }

  requestRaw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    return this.http.requestRaw(method, path, options);
  }

  requestText(method: string, path: string, options: RequestOptions = {}): Promise<string> {
    return this.http.requestText(method, path, options);
  }

  requestBinary(method: string, path: string, options: RequestOptions = {}): Promise<Uint8Array> {
    return this.http.requestBinary(method, path, options);
  }
}

export const ScoreboardClient = ScreenScoreBoardClient;
export type ScoreboardClient = ScreenScoreBoardClient;
