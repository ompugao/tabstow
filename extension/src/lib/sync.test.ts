import { describe, expect, it } from 'vitest';
import type { GroupRec, Rec } from './model';
import { MemoryKV } from './storage';
import { liveTabsOf, Store } from './store';
import { syncOnce, type SyncResponse, type SyncTransport } from './sync';

// Same rules as server/internal/store/sync.go.
class FakeServer {
  seq = 0;
  purgedSeq = 0;
  records = new Map<string, Rec & { seq: number }>();

  transport: SyncTransport = async (since, changes) => {
    const resync = since < 0 || since > this.seq || (since > 0 && since < this.purgedSeq);
    if (resync) since = 0;
    const rejected: string[] = [];
    for (const c of changes) {
      const existing = this.records.get(c.id);
      if (existing && c.updatedAt <= existing.updatedAt) {
        rejected.push(c.id);
        continue;
      }
      this.records.set(c.id, { ...structuredClone(c), seq: ++this.seq });
    }
    const out = [...this.records.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
    for (const id of rejected) {
      const r = this.records.get(id)!;
      if (r.seq <= since) out.push(r);
    }
    return structuredClone({ seq: this.seq, changes: out, resync }) as SyncResponse;
  };
}

function device(server: FakeServer, start: number) {
  let t = start;
  const store = new Store(new MemoryKV(), () => t);
  return {
    store,
    server,
    tick: (ms = 1) => (t += ms),
    sync: () => syncOnce(store, server.transport),
  };
}

// A device only learns about other devices' pushes on its next pull, so one
// clean round is not enough: keep going until a full round pushes nothing.
async function syncUntilClean(...devs: ReturnType<typeof device>[]) {
  for (let i = 0; i < 5; i++) {
    const seqBefore = serverSeq(devs);
    let more = false;
    for (const d of devs) more = (await d.sync()) || more;
    if (!more && serverSeq(devs) === seqBefore) return;
  }
  throw new Error('did not converge');
}

function serverSeq(devs: ReturnType<typeof device>[]) {
  return devs[0].server.seq;
}

async function groupTitle(store: Store, id: string) {
  return ((await store.all()).get(id) as GroupRec).data.title;
}

describe('syncOnce', () => {
  it('copies a group archived on one device to another', async () => {
    const server = new FakeServer();
    const a = device(server, 1000);
    const b = device(server, 1000);
    await a.store.ensureDevice('A');
    await b.store.ensureDevice('B');
    const gid = await a.store.createGroup([{ url: 'https://x', title: 'x' }]);
    await syncUntilClean(a, b);
    expect(liveTabsOf(await b.store.all(), gid).map((t) => t.data.url)).toEqual(['https://x']);
  });

  it('clears dirty flags after a successful push', async () => {
    const server = new FakeServer();
    const a = device(server, 1000);
    await a.store.ensureDevice('A');
    expect(await a.sync()).toBe(false);
    expect([...(await a.store.all()).values()].some((r) => r.dirty)).toBe(false);
  });

  it('propagates a deletion made on the receiving device back to the origin', async () => {
    const server = new FakeServer();
    const a = device(server, 1000);
    const b = device(server, 1000);
    await a.store.ensureDevice('A');
    await b.store.ensureDevice('B');
    const gid = await a.store.createGroup([{ url: 'u', title: 't' }]);
    await syncUntilClean(a, b);
    b.tick(10);
    await b.store.deleteGroup(gid);
    await syncUntilClean(b, a);
    expect((await a.store.all()).get(gid)!.deleted).toBe(true);
  });

  it('keeps the later of two concurrent edits on both devices', async () => {
    const server = new FakeServer();
    const a = device(server, 1000);
    const b = device(server, 1000);
    await a.store.ensureDevice('A');
    await b.store.ensureDevice('B');
    const gid = await a.store.createGroup([{ url: 'u', title: 't' }]);
    await syncUntilClean(a, b);

    a.tick(10);
    await a.store.updateGroup(gid, { title: 'from A' });
    b.tick(20);
    await b.store.updateGroup(gid, { title: 'from B' });
    await syncUntilClean(a, b);

    expect(await groupTitle(a.store, gid)).toBe('from B');
    expect(await groupTitle(b.store, gid)).toBe('from B');
  });

  it('accepts the server version when a local edit loses', async () => {
    const server = new FakeServer();
    const a = device(server, 1000);
    const b = device(server, 1000);
    await a.store.ensureDevice('A');
    await b.store.ensureDevice('B');
    const gid = await a.store.createGroup([{ url: 'u', title: 't' }]);
    await syncUntilClean(a, b);

    b.tick(50);
    await b.store.updateGroup(gid, { title: 'newer' });
    await b.sync();
    a.tick(10);
    await a.store.updateGroup(gid, { title: 'older' });
    await a.sync();

    expect(await groupTitle(a.store, gid)).toBe('newer');
    expect((await a.store.all()).get(gid)!.dirty).toBeFalsy();
  });

  it('keeps an edit made while a sync request was in flight', async () => {
    const server = new FakeServer();
    const a = device(server, 1000);
    await a.store.ensureDevice('A');
    const gid = await a.store.createGroup([{ url: 'u', title: 't' }]);
    const slow: SyncTransport = async (since, changes) => {
      a.tick(5);
      await a.store.updateGroup(gid, { title: 'during sync' });
      return server.transport(since, changes);
    };
    expect(await syncOnce(a.store, slow)).toBe(true);
    const g = (await a.store.all()).get(gid) as GroupRec & { dirty?: boolean };
    expect(g.data.title).toBe('during sync');
    expect(g.dirty).toBe(true);
  });

  it('hides and deletes a tab added to a group that another device deleted', async () => {
    const server = new FakeServer();
    const a = device(server, 1000);
    const b = device(server, 1000);
    await a.store.ensureDevice('A');
    await b.store.ensureDevice('B');
    const gid = await a.store.createGroup([{ url: 'one', title: 'one' }]);
    await syncUntilClean(a, b);

    a.tick(10);
    await a.store.deleteGroup(gid);
    b.tick(20);
    const other = await b.store.createGroup([{ url: 'two', title: 'two' }]);
    const [moved] = liveTabsOf(await b.store.all(), other);
    await b.store.moveTab(moved.id, gid, null);
    await syncUntilClean(a, b);

    for (const d of [a, b]) {
      const all = await d.store.all();
      expect(all.get(gid)!.deleted).toBe(true);
      expect(liveTabsOf(all, gid)).toEqual([]);
    }
  });

  it('drops local records missing from the server on resync, but keeps unsynced edits', async () => {
    const server = new FakeServer();
    const a = device(server, 1000);
    await a.store.ensureDevice('A');
    const synced = await a.store.createGroup([{ url: 'u', title: 't' }]);
    await syncUntilClean(a);

    server.records.delete(synced);
    server.purgedSeq = server.seq + 1;
    server.seq += 1;
    const pending = await a.store.createGroup([{ url: 'p', title: 'p' }]);
    await a.sync();

    const all = await a.store.all();
    expect(all.has(synced)).toBe(false);
    expect(all.get(pending)?.deleted).toBe(false);
  });
});
