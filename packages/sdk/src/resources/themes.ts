import type { HttpClient } from '../http.js';
import { enc } from '../path.js';
import type {
  ApplyThemeResult,
  DeleteThemeResult,
  DuplicateThemeResult,
  RenameThemeResult,
  Settings,
  Theme,
  ThemeLayer,
  ThemeMeta,
  ThemeSummary,
  ThemeWidget,
} from '../types.js';

export interface ThemeMetaPatch {
  name?: string;
  author?: string;
  description?: string;
  baseStyle?: string;
}

function revisionHeader(revision: number): HeadersInit {
  return { 'If-Match': '"' + revision + '"' };
}

export class ThemesApi {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<ThemeSummary[]> {
    return this.http.request<ThemeSummary[]>('GET', '/themes');
  }

  get(themeId: string): Promise<Theme> {
    return this.http.request<Theme>('GET', `/themes/${enc(themeId)}`);
  }

  create(name: string): Promise<Theme> {
    return this.http.request<Theme>('POST', '/themes', { body: { name } });
  }

  update(themeId: string, theme: Theme, revision: number): Promise<Theme> {
    return this.http.request<Theme>('PATCH', `/themes/${enc(themeId)}`, {
      body: { theme },
      headers: revisionHeader(revision),
    });
  }

  delete(themeId: string, revision: number): Promise<DeleteThemeResult> {
    return this.http.request<DeleteThemeResult>('DELETE', `/themes/${enc(themeId)}`, {
      headers: revisionHeader(revision),
    });
  }

  duplicate(themeId: string, revision: number): Promise<DuplicateThemeResult> {
    return this.http.request<DuplicateThemeResult>(
      'POST',
      `/themes/${enc(themeId)}/duplicate`,
      { headers: revisionHeader(revision) },
    );
  }

  rename(themeId: string, name: string, revision: number): Promise<RenameThemeResult> {
    return this.http.request<RenameThemeResult>(
      'POST',
      `/themes/${enc(themeId)}/rename`,
      { body: { name }, headers: revisionHeader(revision) },
    );
  }

  import(theme: Theme): Promise<Theme> {
    return this.http.request<Theme>('POST', '/themes/import', { body: { theme } });
  }

  apply(themeId: string, projectId: string, revision: number): Promise<ApplyThemeResult> {
    return this.http.request<ApplyThemeResult>(
      'POST',
      `/themes/${enc(themeId)}/apply`,
      { body: { projectId }, headers: revisionHeader(revision) },
    );
  }

  getMeta(themeId: string): Promise<ThemeMeta> {
    return this.http.request<ThemeMeta>('GET', `/themes/${enc(themeId)}/meta`);
  }

  updateMeta(themeId: string, patch: ThemeMetaPatch, revision: number): Promise<Theme> {
    return this.http.request<Theme>('PATCH', `/themes/${enc(themeId)}/meta`, {
      body: patch,
      headers: revisionHeader(revision),
    });
  }

  getCanvas(themeId: string): Promise<Record<string, unknown>> {
    return this.http.request<Record<string, unknown>>(
      'GET',
      `/themes/${enc(themeId)}/canvas`,
    );
  }

  updateCanvas(
    themeId: string,
    canvas: Record<string, unknown>,
    revision: number,
  ): Promise<Theme> {
    return this.http.request<Theme>('PATCH', `/themes/${enc(themeId)}/canvas`, {
      body: { canvas },
      headers: revisionHeader(revision),
    });
  }

  getLayers(themeId: string): Promise<ThemeLayer[]> {
    return this.http.request<ThemeLayer[]>('GET', `/themes/${enc(themeId)}/layers`);
  }

  updateLayers(themeId: string, layers: ThemeLayer[], revision: number): Promise<Theme> {
    return this.http.request<Theme>('PATCH', `/themes/${enc(themeId)}/layers`, {
      body: { layers },
      headers: revisionHeader(revision),
    });
  }

  getLayer(themeId: string, layerId: string): Promise<ThemeLayer> {
    return this.http.request<ThemeLayer>(
      'GET',
      `/themes/${enc(themeId)}/layers/${enc(layerId)}`,
    );
  }

  putLayer(
    themeId: string,
    layerId: string,
    layer: ThemeLayer,
    revision: number,
  ): Promise<Theme> {
    return this.http.request<Theme>(
      'PUT',
      `/themes/${enc(themeId)}/layers/${enc(layerId)}`,
      { body: { layer }, headers: revisionHeader(revision) },
    );
  }

  deleteLayer(themeId: string, layerId: string, revision: number): Promise<Theme> {
    return this.http.request<Theme>(
      'DELETE',
      `/themes/${enc(themeId)}/layers/${enc(layerId)}`,
      { headers: revisionHeader(revision) },
    );
  }

  putNode(
    themeId: string,
    layerId: string,
    nodeId: string,
    node: Record<string, unknown>,
    revision: number,
  ): Promise<Theme> {
    return this.http.request<Theme>(
      'PUT',
      `/themes/${enc(themeId)}/layers/${enc(layerId)}/nodes/${enc(nodeId)}`,
      { body: { node }, headers: revisionHeader(revision) },
    );
  }

  deleteNode(
    themeId: string,
    layerId: string,
    nodeId: string,
    revision: number,
  ): Promise<Theme> {
    return this.http.request<Theme>(
      'DELETE',
      `/themes/${enc(themeId)}/layers/${enc(layerId)}/nodes/${enc(nodeId)}`,
      { headers: revisionHeader(revision) },
    );
  }

  getWidgets(themeId: string): Promise<ThemeWidget[]> {
    return this.http.request<ThemeWidget[]>('GET', `/themes/${enc(themeId)}/widgets`);
  }

  updateWidgets(themeId: string, widgets: ThemeWidget[], revision: number): Promise<Theme> {
    return this.http.request<Theme>('PATCH', `/themes/${enc(themeId)}/widgets`, {
      body: { widgets },
      headers: revisionHeader(revision),
    });
  }

  putWidget(
    themeId: string,
    widgetId: string,
    widget: ThemeWidget,
    revision: number,
  ): Promise<Theme> {
    return this.http.request<Theme>(
      'PUT',
      `/themes/${enc(themeId)}/widgets/${enc(widgetId)}`,
      { body: { widget }, headers: revisionHeader(revision) },
    );
  }

  deleteWidget(themeId: string, widgetId: string, revision: number): Promise<Theme> {
    return this.http.request<Theme>(
      'DELETE',
      `/themes/${enc(themeId)}/widgets/${enc(widgetId)}`,
      { headers: revisionHeader(revision) },
    );
  }

  getSettings(themeId: string): Promise<Settings> {
    return this.http.request<Settings>('GET', `/themes/${enc(themeId)}/settings`);
  }

  updateSettings(
    themeId: string,
    patch: Record<string, unknown>,
    revision: number,
  ): Promise<Theme> {
    return this.http.request<Theme>('PATCH', `/themes/${enc(themeId)}/settings`, {
      body: { settings: patch },
      headers: revisionHeader(revision),
    });
  }

  getScript(themeId: string): Promise<unknown> {
    return this.http.request<unknown>('GET', `/themes/${enc(themeId)}/script`);
  }

  updateScript(themeId: string, script: unknown, revision: number): Promise<Theme> {
    return this.http.request<Theme>('PATCH', `/themes/${enc(themeId)}/script`, {
      body: { script },
      headers: revisionHeader(revision),
    });
  }

  getDraft(projectId: string): Promise<Theme | null> {
    return this.http.request<Theme | null>(
      'GET',
      `/projects/${enc(projectId)}/theme-draft`,
    );
  }

  saveDraft(projectId: string, theme: Theme, revision?: number): Promise<Theme> {
    return this.http.request<Theme>(
      'PATCH',
      `/projects/${enc(projectId)}/theme-draft`,
      {
        body: { theme },
        headers: revision === undefined ? undefined : revisionHeader(revision),
      },
    );
  }

  deleteDraft(projectId: string): Promise<{ deleted: boolean }> {
    return this.http.request<{ deleted: boolean }>(
      'DELETE',
      `/projects/${enc(projectId)}/theme-draft`,
    );
  }

  applyDraft(projectId: string): Promise<ApplyThemeResult & Record<string, unknown>> {
    return this.http.request<ApplyThemeResult & Record<string, unknown>>(
      'POST',
      `/projects/${enc(projectId)}/theme-draft/apply`,
    );
  }
}
