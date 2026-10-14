import { ApiError, httpTransport } from './api';
import { getAuth, getSettings, originPattern, setAuth, setStatus } from './settings';
import type { Store } from './store';
import { syncOnce } from './sync';

const MAX_ROUNDS = 3;

let inflight: Promise<void> | null = null;

export function runSync(store: Store): Promise<void> {
  inflight ??= doSync(store).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doSync(store: Store): Promise<void> {
  const kv = store.kv;
  const { serverUrl } = await getSettings(kv);
  if (!serverUrl) return setStatus(kv, { state: 'unconfigured' });
  const auth = await getAuth(kv);
  if (!auth || auth.serverUrl !== serverUrl) return setStatus(kv, { state: 'signed-out' });
  if (!(await chrome.permissions.contains({ origins: [originPattern(serverUrl)] }))) {
    return setStatus(kv, { state: 'no-permission' });
  }

  await setStatus(kv, { state: 'syncing' });
  try {
    const transport = httpTransport(serverUrl, auth.token);
    for (let i = 0; i < MAX_ROUNDS && (await syncOnce(store, transport)); i++);
    await setStatus(kv, { state: 'ok' });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      await setAuth(kv, null);
      await setStatus(kv, { state: 'signed-out', message: e.message });
    } else if (e instanceof TypeError) {
      await setStatus(kv, { state: 'offline', message: e.message });
    } else {
      await setStatus(kv, { state: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }
}
