import type { HttpClient } from '../http.js';
import { enc } from '../path.js';
import type {
  AddTeamInput,
  AddTeamScoreResult,
  DeleteResult,
  Layout,
  LayoutResult,
  MoveResult,
  Page,
  SetBioResult,
  Team,
  UpdateTeamInput,
} from '../types.js';

export interface ListTeamsOptions {
  offset?: number;
  limit?: number;
}

export class TeamsApi {
  constructor(private readonly http: HttpClient) {}

  list(projectId: string, options: ListTeamsOptions = {}): Promise<Page<Team>> {
    return this.http.request<Page<Team>>('GET', `/projects/${enc(projectId)}/teams`, {
      query: { offset: options.offset, limit: options.limit },
    });
  }

  get(projectId: string, teamId: string): Promise<Team> {
    return this.http.request<Team>(
      'GET',
      `/projects/${enc(projectId)}/teams/${enc(teamId)}`,
    );
  }

  add(projectId: string, input: AddTeamInput): Promise<Team> {
    return this.http.request<Team>('POST', `/projects/${enc(projectId)}/teams`, {
      body: input,
    });
  }

  update(projectId: string, teamId: string, patch: UpdateTeamInput): Promise<Team> {
    return this.http.request<Team>(
      'PATCH',
      `/projects/${enc(projectId)}/teams/${enc(teamId)}`,
      { body: patch },
    );
  }

  remove(projectId: string, teamId: string): Promise<DeleteResult> {
    return this.http.request<DeleteResult>(
      'DELETE',
      `/projects/${enc(projectId)}/teams/${enc(teamId)}`,
    );
  }

  move(projectId: string, teamId: string, direction: 'up' | 'down'): Promise<MoveResult> {
    return this.http.request<MoveResult>(
      'POST',
      `/projects/${enc(projectId)}/teams/${enc(teamId)}/move`,
      { body: { direction } },
    );
  }

  setBio(projectId: string, teamId: string, bio: string): Promise<SetBioResult> {
    return this.http.request<SetBioResult>(
      'PUT',
      `/projects/${enc(projectId)}/teams/${enc(teamId)}/bio`,
      { body: { bio } },
    );
  }

  setAvatar(projectId: string, teamId: string, avatar: string | null): Promise<Team> {
    return this.http.request<Team>(
      'PUT',
      `/projects/${enc(projectId)}/teams/${enc(teamId)}/avatar`,
      { body: { avatar } },
    );
  }

  setCardImage(projectId: string, teamId: string, image: string | null): Promise<Team> {
    return this.http.request<Team>(
      'PUT',
      `/projects/${enc(projectId)}/teams/${enc(teamId)}/card-image`,
      { body: { image } },
    );
  }

  setLayout(projectId: string, teamId: string, layout: Layout | null): Promise<LayoutResult> {
    return this.http.request<LayoutResult>(
      'PUT',
      `/projects/${enc(projectId)}/teams/${enc(teamId)}/layout`,
      { body: { layout } },
    );
  }

  addScore(projectId: string, teamId: string, delta: number): Promise<AddTeamScoreResult> {
    return this.http.request<AddTeamScoreResult>(
      'POST',
      `/projects/${enc(projectId)}/teams/${enc(teamId)}/score/add`,
      { body: { delta } },
    );
  }
}
