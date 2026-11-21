import type { HttpClient } from '../http.js';
import { enc } from '../path.js';
import type {
  CreateProjectResult,
  DeleteResult,
  ProjectDetail,
  ProjectSummary,
} from '../types.js';

export class ProjectsApi {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<ProjectSummary[]> {
    return this.http.request<ProjectSummary[]>('GET', '/projects');
  }

  get(projectId: string): Promise<ProjectDetail> {
    return this.http.request<ProjectDetail>('GET', `/projects/${enc(projectId)}`);
  }

  create(name: string): Promise<CreateProjectResult> {
    return this.http.request<CreateProjectResult>('POST', '/projects', { body: { name } });
  }

  rename(projectId: string, name: string): Promise<ProjectSummary> {
    return this.http.request<ProjectSummary>('PATCH', `/projects/${enc(projectId)}`, {
      body: { name },
    });
  }

  delete(projectId: string): Promise<DeleteResult> {
    return this.http.request<DeleteResult>('DELETE', `/projects/${enc(projectId)}`);
  }
}
