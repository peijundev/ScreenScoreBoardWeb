import type { HttpClient } from '../http.js';
import { enc } from '../path.js';
import type { SpotlightEvent, SpotlightTarget } from '../types.js';

/** 纯突显：不改变分数、不进入撤销栈，只让显示端居中放大目标。 */
export class SpotlightApi {
  constructor(private readonly http: HttpClient) {}

  trigger(projectId: string, target: SpotlightTarget): Promise<SpotlightEvent> {
    return this.http.request<SpotlightEvent>(
      'POST',
      `/projects/${enc(projectId)}/spotlight`,
      { body: target },
    );
  }

  person(projectId: string, personId: string, durationMs?: number): Promise<SpotlightEvent> {
    return this.trigger(projectId, { targetType: 'person', targetId: personId, durationMs });
  }

  team(projectId: string, teamId: string, durationMs?: number): Promise<SpotlightEvent> {
    return this.trigger(projectId, { targetType: 'team', targetId: teamId, durationMs });
  }
}
