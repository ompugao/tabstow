import { fetchMe, logout } from './api';
import { getAuth, getSettings, setAuth } from './settings';
import type { KV } from './storage';

export class SignInError extends Error {
  constructor(
    readonly code: string,
    readonly identity?: string,
  ) {
    super(code);
  }
}

export type SignInStep = 'browser' | 'verifying';

export async function signIn(kv: KV, provider: string, onStep: (step: SignInStep) => void = () => {}): Promise<string> {
  const { serverUrl } = await getSettings(kv);
  const redirect = chrome.identity.getRedirectURL();
  const url = `${serverUrl}/auth/${encodeURIComponent(provider)}/start?redirect=${encodeURIComponent(redirect)}`;
  onStep('browser');
  const result = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  if (!result) throw new SignInError('cancelled');
  const params = new URLSearchParams(new URL(result).hash.slice(1));
  const error = params.get('error');
  if (error) throw new SignInError(error, params.get('identity') ?? undefined);
  const token = params.get('token');
  if (!token) throw new SignInError('no_token');
  onStep('verifying');
  const me = await fetchMe(serverUrl, token);
  await setAuth(kv, { serverUrl, token, identity: me.identity });
  return me.identity;
}

export async function signOut(kv: KV, everywhere: boolean): Promise<void> {
  const auth = await getAuth(kv);
  if (auth) {
    try {
      await logout(auth.serverUrl, auth.token, everywhere);
    } catch {
      // The local session is dropped even if the server cannot be reached.
    }
  }
  await setAuth(kv, null);
}
