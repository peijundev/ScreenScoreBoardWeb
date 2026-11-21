import type { HttpClient } from '../http.js';
import { enc } from '../path.js';
import type {
  AddPeopleBatchResult,
  AddPersonInput,
  AddScoreResult,
  DeleteResult,
  Layout,
  LayoutResult,
  MoveResult,
  Page,
  Person,
  PersonInput,
  SetBioResult,
} from '../types.js';

export interface ListPeopleOptions {
  q?: string;
  teamId?: string | null;
  offset?: number;
  limit?: number;
}

export class PeopleApi {
  constructor(private readonly http: HttpClient) {}

  list(projectId: string, options: ListPeopleOptions = {}): Promise<Page<Person>> {
    return this.http.request<Page<Person>>('GET', `/projects/${enc(projectId)}/people`, {
      query: {
        q: options.q,
        teamId: options.teamId,
        offset: options.offset,
        limit: options.limit,
      },
    });
  }

  get(projectId: string, personId: string): Promise<Person> {
    return this.http.request<Person>(
      'GET',
      `/projects/${enc(projectId)}/people/${enc(personId)}`,
    );
  }

  add(projectId: string, input: AddPersonInput): Promise<Person> {
    return this.http.request<Person>('POST', `/projects/${enc(projectId)}/people`, {
      body: input,
    });
  }

  batchAdd(
    projectId: string,
    names: string[],
    teamId?: string | null,
  ): Promise<AddPeopleBatchResult> {
    return this.http.request<AddPeopleBatchResult>(
      'POST',
      `/projects/${enc(projectId)}/people/batch`,
      { body: { names, teamId } },
    );
  }

  update(projectId: string, personId: string, patch: PersonInput): Promise<Person> {
    return this.http.request<Person>(
      'PATCH',
      `/projects/${enc(projectId)}/people/${enc(personId)}`,
      { body: patch },
    );
  }

  remove(projectId: string, personId: string): Promise<DeleteResult> {
    return this.http.request<DeleteResult>(
      'DELETE',
      `/projects/${enc(projectId)}/people/${enc(personId)}`,
    );
  }

  move(projectId: string, personId: string, direction: 'up' | 'down'): Promise<MoveResult> {
    return this.http.request<MoveResult>(
      'POST',
      `/projects/${enc(projectId)}/people/${enc(personId)}/move`,
      { body: { direction } },
    );
  }

  setBio(projectId: string, personId: string, bio: string): Promise<SetBioResult> {
    return this.http.request<SetBioResult>(
      'PUT',
      `/projects/${enc(projectId)}/people/${enc(personId)}/bio`,
      { body: { bio } },
    );
  }

  setAvatar(projectId: string, personId: string, avatar: string | null): Promise<Person> {
    return this.http.request<Person>(
      'PUT',
      `/projects/${enc(projectId)}/people/${enc(personId)}/avatar`,
      { body: { avatar } },
    );
  }

  setCardImage(projectId: string, personId: string, image: string | null): Promise<Person> {
    return this.http.request<Person>(
      'PUT',
      `/projects/${enc(projectId)}/people/${enc(personId)}/card-image`,
      { body: { image } },
    );
  }

  setTeam(projectId: string, personId: string, teamId: string | null): Promise<Person> {
    return this.http.request<Person>(
      'PUT',
      `/projects/${enc(projectId)}/people/${enc(personId)}/team`,
      { body: { teamId } },
    );
  }

  setLayout(projectId: string, personId: string, layout: Layout | null): Promise<LayoutResult> {
    return this.http.request<LayoutResult>(
      'PUT',
      `/projects/${enc(projectId)}/people/${enc(personId)}/layout`,
      { body: { layout } },
    );
  }

  setMemberLayout(
    projectId: string,
    personId: string,
    layout: Layout | null,
  ): Promise<LayoutResult> {
    return this.http.request<LayoutResult>(
      'PUT',
      `/projects/${enc(projectId)}/people/${enc(personId)}/member-layout`,
      { body: { layout } },
    );
  }

  addScore(projectId: string, personId: string, delta: number): Promise<AddScoreResult> {
    return this.http.request<AddScoreResult>(
      'POST',
      `/projects/${enc(projectId)}/people/${enc(personId)}/score/add`,
      { body: { delta } },
    );
  }

  setScore(projectId: string, personId: string, score: number): Promise<AddScoreResult> {
    return this.http.request<AddScoreResult>(
      'POST',
      `/projects/${enc(projectId)}/people/${enc(personId)}/score/set`,
      { body: { score } },
    );
  }
}
