import type { HttpClient } from '../http.js';
import { enc } from '../path.js';
import type { CountdownRuntime, ProjectRuntime } from '../types.js';

export interface UndoResult {
  label: string;
  undoCount: number;
}

export interface UndoToResult {
  count: number;
  undoCount: number;
}

export interface CountdownResult {
  countdown: CountdownRuntime;
}

export class CountdownApi {
  constructor(private readonly http: HttpClient) {}

  start(projectId: string, durationSec?: number): Promise<CountdownResult> {
    return this.http.request<CountdownResult>(
      'POST',
      `/projects/${enc(projectId)}/runtime/countdown/start`,
      { body: durationSec === undefined ? {} : { durationSec } },
    );
  }

  pause(projectId: string): Promise<CountdownResult> {
    return this.http.request<CountdownResult>(
      'POST',
      `/projects/${enc(projectId)}/runtime/countdown/pause`,
    );
  }

  resume(projectId: string): Promise<CountdownResult> {
    return this.http.request<CountdownResult>(
      'POST',
      `/projects/${enc(projectId)}/runtime/countdown/resume`,
    );
  }

  reset(projectId: string): Promise<Record<string, unknown>> {
    return this.http.request<Record<string, unknown>>(
      'POST',
      `/projects/${enc(projectId)}/runtime/countdown/reset`,
    );
  }
}

export class RuntimeApi {
  readonly countdown: CountdownApi;

  constructor(private readonly http: HttpClient) {
    this.countdown = new CountdownApi(http);
  }

  get(projectId: string): Promise<ProjectRuntime> {
    return this.http.request<ProjectRuntime>(
      'GET',
      `/projects/${enc(projectId)}/runtime`,
    );
  }

  undo(projectId: string): Promise<UndoResult> {
    return this.http.request<UndoResult>(
      'POST',
      `/projects/${enc(projectId)}/runtime/undo`,
    );
  }

  undoTo(projectId: string, keep: number): Promise<UndoToResult> {
    return this.http.request<UndoToResult>(
      'POST',
      `/projects/${enc(projectId)}/runtime/undo-to`,
      { body: { keep } },
    );
  }
}
