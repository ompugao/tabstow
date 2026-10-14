import type { KV } from './storage';

export interface Settings {
  serverUrl: string;
  removeOnOpen: boolean;
}

export interface AuthState {
  serverUrl: string;
  token: string;
  identity: string;
}

export type SyncState = 'unconfigured' | 'signed-out' | 'no-permission' | 'syncing' | 'ok' | 'offline' | 'error';

export interface SyncStatus {
  state: SyncState;
  at: number;
  message?: string;
}

export const SETTINGS_KEY = 'settings';
export const AUTH_KEY = 'auth';
export const STATUS_KEY = 'meta:syncStatus';

const defaults: Settings = { serverUrl: '', removeOnOpen: true };

export async function getSettings(kv: KV): Promise<Settings> {
  return { ...defaults, ...((await kv.get(SETTINGS_KEY))[SETTINGS_KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(kv: KV, patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings(kv)), ...patch };
  await kv.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function getAuth(kv: KV): Promise<AuthState | null> {
  return ((await kv.get(AUTH_KEY))[AUTH_KEY] as AuthState | undefined) ?? null;
}

export async function setAuth(kv: KV, auth: AuthState | null): Promise<void> {
  if (auth) await kv.set({ [AUTH_KEY]: auth });
  else await kv.remove(AUTH_KEY);
}

export async function getStatus(kv: KV): Promise<SyncStatus | null> {
  return ((await kv.get(STATUS_KEY))[STATUS_KEY] as SyncStatus | undefined) ?? null;
}

export async function setStatus(kv: KV, status: Omit<SyncStatus, 'at'>): Promise<void> {
  await kv.set({ [STATUS_KEY]: { ...status, at: Date.now() } });
}

export function normalizeServerUrl(input: string): string | null {
  try {
    const u = new URL(input.trim());
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function originPattern(serverUrl: string): string {
  return new URL(serverUrl).origin + '/*';
}
