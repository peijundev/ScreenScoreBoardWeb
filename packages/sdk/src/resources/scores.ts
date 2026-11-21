import type { HttpClient } from '../http.js';
import { enc } from '../path.js';

export interface ResetScoresResult {
  count: number;
}

export class ScoresApi {
  constructor(private readonly http: HttpClient) {}

  reset(projectId: string): Promise<ResetScoresResult> {
    return this.http.request<ResetScoresResult>(
      'POST',
      `/projects/${enc(projectId)}/scores/reset`,
    );
  }
}
