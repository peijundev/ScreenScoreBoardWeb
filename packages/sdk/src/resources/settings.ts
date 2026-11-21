import type { HttpClient } from '../http.js';
import { enc } from '../path.js';
import type { Settings } from '../types.js';

export class SettingsApi {
  constructor(private readonly http: HttpClient) {}

  get(projectId: string): Promise<Settings> {
    return this.http.request<Settings>('GET', `/projects/${enc(projectId)}/settings`);
  }

  update(projectId: string, patch: Partial<Settings> | Record<string, unknown>): Promise<Settings> {
    return this.http.request<Settings>('PATCH', `/projects/${enc(projectId)}/settings`, {
      body: { patch },
    });
  }
}
