import { isValidRecord, recordKey, stripLocal, type Rec, type StoredRec } from './model';
import { tombstone, type Store } from './store';

export interface SyncResponse {
  seq: number;
  changes: (Rec & { seq?: number })[];
  resync?: boolean;
}

export type SyncTransport = (since: number, changes: Rec[]) => Promise<SyncResponse>;

const LAST_SEQ_KEY = 'meta:lastSeq';

export async function getLastSeq(store: Store): Promise<number> {
  return ((await store.kv.get(LAST_SEQ_KEY))[LAST_SEQ_KEY] as number) ?? 0;
}

export async function resetLastSeq(store: Store): Promise<void> {
  await store.kv.remove(LAST_SEQ_KEY);
}

// Returns true when the sync produced new local changes that still need pushing.
export async function syncOnce(store: Store, transport: SyncTransport): Promise<boolean> {
  const before = await store.all();
  const dirty = [...before.values()].filter((r) => r.dirty).map(stripLocal);
  const since = await getLastSeq(store);
  const res = await transport(since, dirty);

  // Re-read so edits made while the request was in flight are not overwritten.
  const current = await store.all();
  const items: Record<string, StoredRec> = {};
  const returned = new Set<string>();
  for (const incoming of res.changes) {
    if (!isValidRecord(incoming)) continue;
    returned.add(incoming.id);
    const local = current.get(incoming.id);
    if (local?.dirty && local.updatedAt > incoming.updatedAt) continue;
    const { seq: _seq, ...rec } = incoming;
    items[recordKey(rec.id)] = rec as StoredRec;
  }
  const removals: string[] = [];
  if (res.resync) {
    for (const r of current.values()) {
      if (!r.dirty && !returned.has(r.id)) removals.push(recordKey(r.id));
    }
  }
  await store.kv.set({ ...items, [LAST_SEQ_KEY]: res.seq });
  if (removals.length) await store.kv.remove(removals);

  return (await tombstoneOrphans(store)) || [...(await store.all()).values()].some((r) => r.dirty);
}

async function tombstoneOrphans(store: Store): Promise<boolean> {
  const all = await store.all();
  const orphans: Rec[] = [];
  for (const r of all.values()) {
    if (r.kind !== 'tab' || r.deleted) continue;
    const g = all.get(r.data.groupId);
    if (g?.deleted) orphans.push(tombstone(stripLocal(r)));
  }
  await store.write(orphans);
  return orphans.length > 0;
}
