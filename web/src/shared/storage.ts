// 存储后端配置的前端类型与 API 封装。
import { authFetch } from './auth';

export type StorageKind =
  | 'json' | 'txt' | 'sqlite' | 'postgres' | 'mysql'
  | 'mongodb' | 'sqlserver' | 'oracle' | 'redis'
  | 'libsql' | 'couchdb' | 'd1' | 'dynamodb' | 'firestore' | 's3' | 'etcd' | 'lmdb';

export type StorageFormValue = string | number | boolean;

export interface StorageFieldDescriptor {
  name: string;
  type: 'string' | 'password' | 'number' | 'boolean' | 'select';
  label: string;
  default?: StorageFormValue;
  min?: number;
  max?: number;
  maxLength?: number;
  secret?: boolean;
  secretUrl?: boolean;
  file?: boolean;
  extensions?: string[];
  pattern?: string;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface StorageBackendDescriptor {
  kind: StorageKind;
  label: string;
  category: 'file' | 'database';
  description: string;
  recommended: boolean;
  recommendedLabel?: string;
  recommendedNote: string;
  pros: string[];
  cons: string[];
  warning: string;
  envKeys: string[];
  maxSnapshotBytes?: number;
  fields: StorageFieldDescriptor[];
}

export interface StorageConfigView {
  version: number;
  kind: StorageKind;
  options: Record<string, StorageFormValue>;
  hasPassword: boolean;
  hasSecrets?: boolean;
  source: 'storage.json' | 'env' | 'default';
  updatedAt?: string;
  updatedBy?: string;
  configPath?: string;
}

export interface StorageLocation {
  type: 'file' | 'remote';
  path: string;
  detail: string;
}

export interface StorageLocationInfo {
  dataDir: string;
  configFile: string;
  active: StorageLocation;
}

export interface StorageHealth {
  ok: boolean;
  kind: string;
  driver?: string;
  revision: unknown;
  latencyMs?: number;
  lastSaveAt?: number | null;
  lastSaveError?: string | null;
  conflict?: boolean;
  warnings?: string[];
  lock?: {
    supported: boolean;
    acquired: boolean;
    kind?: string | null;
  };
}

export interface StorageStatusResponse {
  config: StorageConfigView;
  active: {
    kind: string;
    source: 'storage.json' | 'env' | 'default';
    revision: unknown;
    lastSaveAt?: number | null;
    lastSaveError?: string | null;
    conflict?: boolean;
  };
  location: StorageLocationInfo;
  backends: StorageBackendDescriptor[];
  restartRequired: boolean;
  runtime: StorageHealth;
}

export interface StorageSaveInput {
  kind: StorageKind;
  options: Record<string, StorageFormValue>;
  clearPassword?: boolean;
}

export interface StorageTestInput {
  kind: StorageKind;
  options?: Record<string, StorageFormValue>;
}

export interface StorageTestResult {
  ok: boolean;
  kind: string;
  latencyMs?: number;
  existing?: boolean;
  revision?: unknown;
  warnings?: string[];
  code?: string;
  message?: string;
}

export interface StorageMigrateInput {
  mode: 'copy' | 'empty';
  overwrite?: boolean;
  clearPassword?: boolean;
  config: {
    kind: StorageKind;
    options: Record<string, StorageFormValue>;
  };
}

export interface StorageMigrateResult {
  ok: boolean;
  mode: string;
  kind: string;
  verified: boolean;
  bytes: number;
  revision: unknown;
  saved: boolean;
  restartRequired: boolean;
  warnings?: string[];
}

async function readData<T>(res: Response): Promise<T> {
  const payload = (await res.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(payload.error?.message || `请求失败 (${res.status})`);
  return payload.data as T;
}

export async function getStorageConfig(): Promise<StorageStatusResponse> {
  return readData<StorageStatusResponse>(await authFetch('/api/v1/storage'));
}

export async function getStorageHealth(refresh = false): Promise<StorageHealth> {
  const query = refresh ? '?refresh=1' : '';
  return readData<StorageHealth>(await authFetch('/api/v1/storage/health' + query));
}

export async function updateStorageConfig(input: StorageSaveInput): Promise<{
  saved: boolean;
  restartRequired: boolean;
  config: StorageConfigView;
  warnings?: string[];
}> {
  return readData(await authFetch('/api/v1/storage', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }));
}

export async function testStorageConnection(input: StorageTestInput): Promise<StorageTestResult> {
  return readData<StorageTestResult>(await authFetch('/api/v1/storage/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }));
}

export async function migrateStorage(input: StorageMigrateInput): Promise<StorageMigrateResult> {
  return readData<StorageMigrateResult>(await authFetch('/api/v1/storage/migrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }));
}
