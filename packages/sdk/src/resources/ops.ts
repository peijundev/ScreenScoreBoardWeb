import type { HttpClient } from '../http.js';
import { enc } from '../path.js';

/** 低层 op 通道：覆盖尚未封装成便捷方法的服务端操作。 */
export class OpsApi {
  constructor(private readonly http: HttpClient) {}

  call<T = unknown>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
    return this.http.request<T>('POST', '/ops', { body: { op, payload } });
  }

  callProject<T = unknown>(
    projectId: string,
    op: string,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    return this.http.request<T>('POST', `/projects/${enc(projectId)}/ops`, {
      body: { op, payload },
    });
  }
}
