import { useEffect, useState } from 'preact/hooks';
import type { StoredRec } from './model';
import { getAuth, getSettings, getStatus, type AuthState, type Settings, type SyncStatus } from './settings';
import type { KV } from './storage';
import type { Store } from './store';

export interface Snapshot {
  records: Map<string, StoredRec>;
  deviceId: string;
  settings: Settings;
  auth: AuthState | null;
  status: SyncStatus | null;
}

async function load(store: Store, kv: KV): Promise<Snapshot> {
  const [records, deviceId, settings, auth, status] = await Promise.all([
    store.all(),
    store.deviceId(),
    getSettings(kv),
    getAuth(kv),
    getStatus(kv),
  ]);
  return { records, deviceId, settings, auth, status };
}

// Pages render straight from chrome.storage, so edits from the background
// worker, sync, or another open page show up without message passing.
export function useSnapshot(store: Store): Snapshot | null {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  useEffect(() => {
    let pending = false;
    const refresh = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        load(store, store.kv).then(setSnap);
      });
    };
    refresh();
    const onChanged = (_: unknown, area: string) => area === 'local' && refresh();
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [store]);
  return snap;
}

export function requestSync(): Promise<unknown> {
  return chrome.runtime.sendMessage({ type: 'sync' });
}
