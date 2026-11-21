/**
 * ScreenScoreBoard SDK 的公共类型。
 * 设置项只列出最常用的字段，其余字段通过索引签名透传，避免与 170+ 项设置强耦合。
 */

export type Role = 'admin' | 'operator' | 'viewer' | string;

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface Health {
  ok: boolean;
  version: string;
  uptimeSec: number;
  storage: string;
  /** 存储无冲突/保存正常；旧版服务端可能不返回 */
  storageOk?: boolean;
  wsClients: number;
  projects: number;
  ts: number;
}

export interface VersionInfo {
  version: string;
  finalForTechStack: string;
  frontend: string;
}

export interface Endpoints {
  rest: string;
  mcp: string;
  openapi: string;
  absolute?: {
    rest: string;
    mcp: string;
  };
}

export interface Layout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Settings {
  [key: string]: unknown;
  title?: string;
  displayStyle?: string;
  columns?: number;
  density?: string;
  sortBy?: string;
  sortOrder?: string;
  theme?: string;
  accent?: string;
  scoreEffect?: string;
  scoreEffectDuration?: number;
  scoreEffectOnlyPositive?: boolean;
  spotlightScope?: string;
  spotlightWidth?: number;
  spotlightHeight?: number;
  spotlightTheme?: string;
  spotlightReturnDuration?: number;
  spotlightPlayMode?: string;
  spotlightTriggerDuration?: number;
  featureSpotlightTrigger?: boolean;
  displayView?: string;
  layoutMode?: string;
}

export interface Person {
  id: string;
  name: string;
  avatar: string | null;
  cardImage: string | null;
  score: number;
  teamId: string | null;
  teamName?: string;
  bio?: string;
  layout: Layout | null;
  memberLayout: Layout | null;
  createdAt: number;
  order?: number;
}

export interface Team {
  id: string;
  name: string;
  avatar: string | null;
  cardImage: string | null;
  bio?: string;
  layout: Layout | null;
  members?: Person[];
  total?: number;
  createdAt: number;
  order?: number;
}

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

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  people: number;
  teams: number;
  themeId: string | null;
  themeRevision: number;
}

export interface ProjectDetail extends Project {
  peopleCount: number;
  teamsCount: number;
  peopleList: Person[];
  teamsList: Team[];
}

export interface CountdownRuntime {
  state: string;
  endsAt?: number;
  remainingMs?: number;
  durationMs?: number;
  endedAt?: number;
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

export interface SpotlightEvent {
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
  spotlightEvents?: Record<string, SpotlightEvent[]>;
  serverNow?: number;
}

export interface ProjectRuntime {
  serverNow?: number;
  undoCount: number;
  undoLabels: UndoLabel[];
  scoreLogs: ScoreLogEntry[];
  countdown: CountdownRuntime | null;
}

export interface Snapshot {
  version: number;
  projects: Record<string, Project>;
}

export interface StateSnapshot extends Snapshot {
  runtime: RuntimeSnapshot;
}

export interface ThemeMeta {
  id: string;
  name: string;
  author?: string;
  description?: string;
  baseStyle: string;
  revision: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface ThemeLayer {
  id?: string;
  name?: string;
  nodes?: unknown[];
  [key: string]: unknown;
}

export interface ThemeWidget {
  id?: string;
  type?: string;
  [key: string]: unknown;
}

export interface Theme {
  format?: string;
  version?: number;
  meta: ThemeMeta;
  canvas?: Record<string, unknown>;
  layers?: ThemeLayer[];
  widgets?: ThemeWidget[];
  settings?: Settings;
  script?: unknown;
  [key: string]: unknown;
}

export interface ThemeSummary {
  id: string;
  name: string;
  author?: string;
  description?: string;
  baseStyle: string;
  revision: number;
  updatedAt?: number;
  bytes?: number;
  layers?: number;
  widgets?: number;
}

export interface DuplicateThemeResult {
  themeId: string;
  theme: ThemeSummary;
}

export interface RenameThemeResult {
  themeId: string;
  theme: ThemeSummary;
}

export interface ApplyThemeResult {
  themeId: string;
  revision: number;
  applied: number;
  baseStyle: string;
}

export interface DeleteThemeResult {
  unbound: string[];
}

export interface User {
  id: string;
  username: string;
  displayName?: string;
  role: Role;
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
  user: User | null;
}

export interface AccessSettings {
  requireLogin: boolean;
  openAccess: boolean;
  activeAdmins: number;
}

export interface AuthSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt?: string;
  ip: string;
  userAgent: string;
  remember: boolean;
  current: boolean;
}

export interface ApiToken {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  /** 只在创建时返回一次 */
  token?: string;
}

export interface PersonInput {
  name?: string;
  avatar?: string | null;
  cardImage?: string | null;
  bio?: string;
  teamId?: string | null;
}

export interface AddPersonInput extends PersonInput {
  name: string;
}

export interface AddTeamInput {
  name: string;
  avatar?: string | null;
  cardImage?: string | null;
  bio?: string;
}

export interface UpdateTeamInput {
  name?: string;
  avatar?: string | null;
  cardImage?: string | null;
  bio?: string;
}

export interface CreateProjectResult {
  projectId: string;
  project?: ProjectSummary;
}

export interface DeleteResult {
  deleted: string;
}

export interface MoveResult {
  order: number;
}

export interface SetBioResult {
  bio: string;
}

export interface LayoutResult {
  layout?: Layout | null;
  memberLayout?: Layout | null;
}

export interface AddPeopleBatchResult {
  personIds: string[];
  added: number;
  skipped: string[];
}

export interface MeResult {
  user: User | null;
  authEnabled: boolean;
}

export interface AddScoreResult {
  score: number;
}

export interface AddTeamScoreResult {
  count: number;
}

export interface SpotlightTarget {
  targetType: 'person' | 'team';
  targetId: string;
  /** 本次突显总时长；省略或 0 时跟随项目设置 */
  durationMs?: number;
}

export interface AssetInfo {
  path: string;
  bytes: number;
  mtime: number;
}

export interface AssetList {
  avatars: AssetInfo[];
  sounds: AssetInfo[];
}

export interface UploadResult {
  path: string;
  bytes: number;
}

export interface DeleteAssetResult {
  removed: string;
  cleared: number;
}

export interface BackupInfo {
  name: string;
  size?: number;
  mtime?: number;
  [key: string]: unknown;
}

export interface BackupList {
  enabled: boolean;
  intervalMinutes: number;
  keep: number;
  dir: string;
  files: BackupInfo[];
}

export interface RunBackupResult {
  file: string;
  size: number;
  dir: string;
}

export interface OrphanScanResult {
  [key: string]: unknown;
}

export interface OrphanCleanupResult {
  dryRun?: boolean;
  removed?: number;
  [key: string]: unknown;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role?: Role;
  displayName?: string;
}

export interface UpdateUserInput {
  role?: Role;
  displayName?: string;
  disabled?: boolean;
}

export interface CreateTokenInput {
  name?: string;
  userId?: string;
  expiresAt?: string | null;
}

export interface McpInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: McpInputSchema;
  [key: string]: unknown;
}

export interface McpContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpToolResult<T = unknown> {
  content: McpContent[];
  isError: boolean;
  text: string;
  data: T | null;
  raw: unknown;
}

export interface McpResource {
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
  [key: string]: unknown;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: {
    name: string;
    version: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type OpenApiDocument = Record<string, unknown>;

export type QueryValue = string | number | boolean | null | undefined;

export type Query = Record<string, QueryValue | QueryValue[]>;
