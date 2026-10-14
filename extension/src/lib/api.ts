import type { Rec } from './model';
import type { SyncResponse, SyncTransport } from './sync';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(serverUrl: string, path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  const resp = await fetch(serverUrl + path, { ...init, headers });
  if (!resp.ok) {
    let msg = resp.statusText;
    try {
      msg = ((await resp.json()) as { error?: string }).error ?? msg;
    } catch {
      // Non-JSON error bodies, e.g. from a reverse proxy, keep the status text.
    }
    throw new ApiError(resp.status, msg);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

export const fetchProviders = (serverUrl: string) =>
  request<{ providers: string[] }>(serverUrl, '/auth/providers').then((r) => r.providers);

export const fetchMe = (serverUrl: string, token: string) =>
  request<{ provider: string; identity: string; email: string }>(serverUrl, '/api/me', {}, token);

export const logout = (serverUrl: string, token: string, everywhere: boolean) =>
  request<void>(serverUrl, everywhere ? '/api/logout_all' : '/api/logout', { method: 'POST' }, token);

export function httpTransport(serverUrl: string, token: string): SyncTransport {
  return (since: number, changes: Rec[]) =>
    request<SyncResponse>(serverUrl, '/api/sync', { method: 'POST', body: JSON.stringify({ since, changes }) }, token);
}
