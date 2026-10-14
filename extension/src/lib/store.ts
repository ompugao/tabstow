import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import type { KV } from './storage';
import {
  isRecordKey,
  isValidRecord,
  newId,
  recordKey,
  type DeviceRec,
  type GroupData,
  type GroupRec,
  type Rec,
  type StoredRec,
  type TabRec,
} from './model';

export interface TabInput {
  url: string;
  title: string;
  favIconUrl?: string;
}

const DEVICE_ID_KEY = 'meta:deviceId';

export class Store {
  constructor(
    readonly kv: KV,
    private now: () => number = Date.now,
  ) {}

  async all(): Promise<Map<string, StoredRec>> {
    const raw = await this.kv.get(null);
    const out = new Map<string, StoredRec>();
    for (const [k, v] of Object.entries(raw)) {
      if (isRecordKey(k)) {
        const r = v as StoredRec;
        out.set(r.id, r);
      }
    }
    return out;
  }

  async getMany(ids: string[]): Promise<Map<string, StoredRec>> {
    const raw = await this.kv.get(ids.map(recordKey));
    const out = new Map<string, StoredRec>();
    for (const v of Object.values(raw)) out.set((v as StoredRec).id, v as StoredRec);
    return out;
  }

  // A local edit must beat the version it was based on even when another
  // machine's clock ran ahead, so updatedAt never goes backwards per record.
  async write(recs: Rec[]): Promise<void> {
    if (recs.length === 0) return;
    const existing = await this.getMany(recs.map((r) => r.id));
    const now = this.now();
    const items: Record<string, StoredRec> = {};
    for (const r of recs) {
      const prev = existing.get(r.id)?.updatedAt ?? 0;
      items[recordKey(r.id)] = { ...r, updatedAt: Math.max(now, prev + 1), dirty: true } as StoredRec;
    }
    await this.kv.set(items);
  }

  async deviceId(): Promise<string> {
    const got = await this.kv.get(DEVICE_ID_KEY);
    return got[DEVICE_ID_KEY] as string;
  }

  async ensureDevice(defaultName: string): Promise<string> {
    const existing = await this.deviceId();
    if (existing) return existing;
    const id = newId();
    await this.kv.set({ [DEVICE_ID_KEY]: id });
    await this.write([{ id, kind: 'device', updatedAt: 0, deleted: false, data: { name: defaultName } }]);
    return id;
  }

  async renameDevice(id: string, name: string): Promise<void> {
    const dev: DeviceRec = { id, kind: 'device', updatedAt: 0, deleted: false, data: { name } };
    await this.write([dev]);
  }

  async createGroup(tabs: TabInput[], title = ''): Promise<string> {
    const deviceId = await this.deviceId();
    const groupId = newId();
    const group: GroupRec = {
      id: groupId,
      kind: 'group',
      updatedAt: 0,
      deleted: false,
      data: { deviceId, title, createdAt: this.now(), locked: false, starred: false },
    };
    const positions = generateNKeysBetween(null, null, tabs.length);
    const tabRecs: TabRec[] = tabs.map((t, i) => ({
      id: newId(),
      kind: 'tab',
      updatedAt: 0,
      deleted: false,
      data: { groupId, url: t.url, title: t.title, favIconUrl: t.favIconUrl ?? '', position: positions[i] },
    }));
    await this.write([group, ...tabRecs]);
    return groupId;
  }

  async updateGroup(id: string, patch: Partial<Omit<GroupData, 'deviceId' | 'createdAt'>>): Promise<void> {
    const g = (await this.getMany([id])).get(id);
    if (!g || g.kind !== 'group') return;
    await this.write([{ ...g, data: { ...g.data, ...patch } }]);
  }

  async deleteGroup(id: string): Promise<void> {
    const all = await this.all();
    const g = all.get(id);
    if (!g || g.kind !== 'group') return;
    const tabs = liveTabsOf(all, id);
    await this.write([g, ...tabs].map(tombstone));
  }

  // Removing the last tab removes its group too, like OneTab, unless the group is locked.
  async deleteTabs(ids: string[]): Promise<void> {
    const all = await this.all();
    const removed = new Set(ids);
    const recs: Rec[] = [];
    const groups = new Set<string>();
    for (const id of ids) {
      const t = all.get(id);
      if (t?.kind === 'tab' && !t.deleted) {
        recs.push(tombstone(t));
        groups.add(t.data.groupId);
      }
    }
    for (const gid of groups) {
      const g = all.get(gid);
      if (g?.kind !== 'group' || g.deleted || g.data.locked) continue;
      if (liveTabsOf(all, gid).every((t) => removed.has(t.id))) recs.push(tombstone(g));
    }
    await this.write(recs);
  }

  // Places the tab immediately before `beforeId`, or at the end of the group when it is null.
  async moveTab(id: string, groupId: string, beforeId: string | null): Promise<void> {
    const all = await this.all();
    const t = all.get(id);
    if (t?.kind !== 'tab') return;
    const siblings = liveTabsOf(all, groupId).filter((s) => s.id !== id);
    const idx = beforeId ? siblings.findIndex((s) => s.id === beforeId) : siblings.length;
    const at = idx < 0 ? siblings.length : idx;
    const lo = at > 0 ? siblings[at - 1].data.position : null;
    const hi = at < siblings.length ? siblings[at].data.position : null;
    const position = lo !== null && lo === hi ? lo : generateKeyBetween(lo, hi);
    const sourceGroup = t.data.groupId;
    await this.write([{ ...t, data: { ...t.data, groupId, position } }]);
    if (sourceGroup !== groupId) {
      const after = await this.all();
      const g = after.get(sourceGroup);
      if (g?.kind === 'group' && !g.deleted && !g.data.locked && liveTabsOf(after, sourceGroup).length === 0) {
        await this.write([tombstone(g)]);
      }
    }
  }

  async markAllDirty(): Promise<void> {
    const all = await this.all();
    const items: Record<string, StoredRec> = {};
    for (const r of all.values()) items[recordKey(r.id)] = { ...r, dirty: true };
    await this.kv.set(items);
  }

  async importRecords(recs: Rec[]): Promise<void> {
    await this.write(recs.filter(isValidRecord));
  }
}

export function tombstone<R extends Rec>(r: R): R {
  return { ...r, deleted: true };
}

export function compareTabs(a: TabRec, b: TabRec): number {
  if (a.data.position !== b.data.position) return a.data.position < b.data.position ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function liveTabsOf(all: Map<string, StoredRec>, groupId: string): TabRec[] {
  const out: TabRec[] = [];
  for (const r of all.values()) {
    if (r.kind === 'tab' && !r.deleted && r.data.groupId === groupId) out.push(r);
  }
  return out.sort(compareTabs);
}
