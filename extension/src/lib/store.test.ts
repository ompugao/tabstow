import { describe, expect, it } from 'vitest';
import type { GroupRec, StoredRec, TabRec } from './model';
import { MemoryKV } from './storage';
import { liveTabsOf, Store } from './store';

function clock(start = 1000) {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

async function setup() {
  const c = clock();
  const store = new Store(new MemoryKV(), c.now);
  const deviceId = await store.ensureDevice('laptop');
  return { store, c, deviceId };
}

const tabs = (...urls: string[]) => urls.map((url) => ({ url, title: url }));

async function liveTabs(store: Store, groupId: string): Promise<TabRec[]> {
  return liveTabsOf(await store.all(), groupId);
}

describe('Store', () => {
  it('creates the device record once', async () => {
    const { store, deviceId } = await setup();
    expect(await store.ensureDevice('other')).toBe(deviceId);
    const dev = (await store.all()).get(deviceId) as StoredRec;
    expect(dev.kind).toBe('device');
    expect(dev.data).toEqual({ name: 'laptop' });
  });

  it('creates a group on this device with tabs in the given order', async () => {
    const { store, deviceId } = await setup();
    const gid = await store.createGroup(tabs('a', 'b', 'c'));
    const g = (await store.all()).get(gid) as GroupRec;
    expect(g.data.deviceId).toBe(deviceId);
    expect((await liveTabs(store, gid)).map((t) => t.data.url)).toEqual(['a', 'b', 'c']);
  });

  it('marks every written record dirty', async () => {
    const { store } = await setup();
    await store.createGroup(tabs('a'));
    expect([...(await store.all()).values()].every((r) => r.dirty)).toBe(true);
  });

  it('never moves updatedAt backwards for a record', async () => {
    const { store, c } = await setup();
    const gid = await store.createGroup(tabs('a'));
    c.set(10);
    await store.updateGroup(gid, { title: 'x' });
    const g = (await store.all()).get(gid)!;
    expect(g.updatedAt).toBe(1001);
  });

  it('deleting a group tombstones the group and its tabs', async () => {
    const { store } = await setup();
    const gid = await store.createGroup(tabs('a', 'b'));
    await store.deleteGroup(gid);
    const all = await store.all();
    const recs = [...all.values()].filter((r) => r.id === gid || (r.kind === 'tab' && r.data.groupId === gid));
    expect(recs).toHaveLength(3);
    expect(recs.every((r) => r.deleted)).toBe(true);
  });

  it('deleting the last tab deletes its group', async () => {
    const { store } = await setup();
    const gid = await store.createGroup(tabs('a'));
    const [t] = await liveTabs(store, gid);
    await store.deleteTabs([t.id]);
    expect((await store.all()).get(gid)!.deleted).toBe(true);
  });

  it('deleting the last tab keeps a locked group', async () => {
    const { store } = await setup();
    const gid = await store.createGroup(tabs('a'));
    await store.updateGroup(gid, { locked: true });
    const [t] = await liveTabs(store, gid);
    await store.deleteTabs([t.id]);
    expect((await store.all()).get(gid)!.deleted).toBe(false);
  });

  it('moves a tab before another tab in the same group', async () => {
    const { store } = await setup();
    const gid = await store.createGroup(tabs('a', 'b', 'c'));
    const [a, , c] = await liveTabs(store, gid);
    await store.moveTab(c.id, gid, a.id);
    expect((await liveTabs(store, gid)).map((t) => t.data.url)).toEqual(['c', 'a', 'b']);
  });

  it('moves a tab to the end of another group and removes the emptied source group', async () => {
    const { store } = await setup();
    const g1 = await store.createGroup(tabs('a'));
    const g2 = await store.createGroup(tabs('x', 'y'));
    const [a] = await liveTabs(store, g1);
    await store.moveTab(a.id, g2, null);
    expect((await liveTabs(store, g2)).map((t) => t.data.url)).toEqual(['x', 'y', 'a']);
    expect((await store.all()).get(g1)!.deleted).toBe(true);
  });
});
