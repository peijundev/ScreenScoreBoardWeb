import type { HttpClient } from '../http.js';
import type {
  Endpoints,
  Health,
  OpenApiDocument,
  RuntimeSnapshot,
  StateSnapshot,
  VersionInfo,
} from '../types.js';

export class SystemApi {
  constructor(private readonly http: HttpClient) {}

  health(): Promise<Health> {
    return this.http.request<Health>('GET', '/health');
  }

  version(): Promise<VersionInfo> {
    return this.http.request<VersionInfo>('GET', '/version');
  }

  state(): Promise<StateSnapshot> {
    return this.http.request<StateSnapshot>('GET', '/state');
  }

  runtime(): Promise<RuntimeSnapshot> {
    return this.http.request<RuntimeSnapshot>('GET', '/runtime');
  }

  endpoints(): Promise<Endpoints> {
    return this.http.request<Endpoints>('GET', '/endpoints');
  }

  openapi<T = OpenApiDocument>(): Promise<T> {
    return this.http.request<T>('GET', '/openapi.json');
  }
}
