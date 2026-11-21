import type { HttpClient } from '../http.js';
import { enc } from '../path.js';
import type {
  AssetList,
  BackupList,
  DeleteAssetResult,
  OrphanCleanupResult,
  OrphanScanResult,
  RunBackupResult,
  UploadResult,
} from '../types.js';

export interface UploadOptions {
  filename?: string;
  contentType?: string;
}

export interface DeleteAssetOptions {
  /** 资源正在被引用时是否强制删除并移除引用 */
  force?: boolean;
}

function assetName(name: string, prefix: 'avatars' | 'sounds'): string {
  const head = prefix + '/';
  return name.startsWith(head) ? name.slice(head.length) : name;
}

export class DataApi {
  constructor(private readonly http: HttpClient) {}

  listAssets(): Promise<AssetList> {
    return this.http.request<AssetList>('GET', '/assets');
  }

  uploadImage(input: BodyInit, options: UploadOptions = {}): Promise<UploadResult> {
    return this.upload('/assets/images', input, options);
  }

  uploadSound(input: BodyInit, options: UploadOptions = {}): Promise<UploadResult> {
    return this.upload('/assets/sounds', input, options);
  }

  deleteSound(name: string, options: DeleteAssetOptions = {}): Promise<DeleteAssetResult> {
    return this.http.request<DeleteAssetResult>(
      'DELETE',
      `/assets/sounds/${enc(assetName(name, 'sounds'))}`,
      { query: { force: options.force ? '1' : undefined } },
    );
  }

  deleteImage(name: string, options: DeleteAssetOptions = {}): Promise<DeleteAssetResult> {
    return this.http.request<DeleteAssetResult>(
      'DELETE',
      `/assets/avatars/${enc(assetName(name, 'avatars'))}`,
      { query: { force: options.force ? '1' : undefined } },
    );
  }

  listBackups(): Promise<BackupList> {
    return this.http.request<BackupList>('GET', '/backups');
  }

  runBackup(): Promise<RunBackupResult> {
    return this.http.request<RunBackupResult>('POST', '/backups/run');
  }

  scanOrphans(): Promise<OrphanScanResult> {
    return this.http.request<OrphanScanResult>('GET', '/orphans');
  }

  cleanupOrphans(dryRun: boolean): Promise<OrphanCleanupResult> {
    return this.http.request<OrphanCleanupResult>('POST', '/orphans/cleanup', {
      body: { dryRun: Boolean(dryRun) },
    });
  }

  exportProject<T = unknown>(
    projectId: string,
    options: { assets?: boolean } = {},
  ): Promise<T> {
    return this.http.request<T>('GET', `/projects/${enc(projectId)}/export`, {
      query: { assets: options.assets ? '1' : undefined },
    });
  }

  exportScoresCsv(
    projectId: string,
    scope: 'all' | 'people' | 'teams' = 'all',
  ): Promise<string> {
    return this.http.requestText('GET', `/projects/${enc(projectId)}/scores.csv`, {
      query: { scope },
    });
  }

  private upload(
    path: string,
    input: BodyInit,
    options: UploadOptions,
  ): Promise<UploadResult> {
    return this.http.request<UploadResult>('POST', path, {
      rawBody: input,
      contentType: options.contentType || 'application/octet-stream',
      headers: options.filename
        ? { 'X-File-Name': encodeURIComponent(options.filename) }
        : undefined,
    });
  }
}
