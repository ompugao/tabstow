import { describe, expect, it } from 'vitest';
import type { StoredRec } from './model';
import { buildView } from './view';

function map(...recs: StoredRec[]) {
  return new Map(recs.map((r) => [r.id, r]));
}
const device = (id: string, name: string): StoredRec => ({ id, kind: 'device', updatedAt: 1, deleted: false, data: { name } });
const group = (id: string, deviceId: string, createdAt: number, extra: Partial<{ starred: boolean; locked: boolean; deleted: boolean }> = {}): StoredRec => ({
  id,
  kind: 'group',
  updatedAt: 1,
  deleted: extra.deleted ?? false,
  data: { deviceId, title: '', createdAt, locked: extra.locked ?? false, starred: extra.starred ?? false },
});
const tab = (id: string, groupId: string, position: string, url = id): StoredRec => ({
  id,
  kind: 'tab',
  updatedAt: 1,
  deleted: false,
  data: { groupId, url, title: url, favIconUrl: '', position },
});

describe('buildView', () => {
  it('lists this device first, then other devices by name', () => {
    const view = buildView(
      map(device('me', 'Zed'), device('b', 'Beta'), device('a', 'Alpha'), group('g1', 'a', 1), tab('t1', 'g1', 'a0'), group('g2', 'b', 1), tab('t2', 'g2', 'a0')),
      'me',
    );
    expect(view.map((d) => d.name)).toEqual(['Zed', 'Alpha', 'Beta']);
  });

  it('orders groups starred first, then newest first', () => {
    const view = buildView(
      map(group('old', 'me', 1, { starred: true }), group('new', 'me', 3), group('mid', 'me', 2), tab('a', 'old', 'a0'), tab('b', 'new', 'a0'), tab('c', 'mid', 'a0')),
      'me',
    );
    expect(view[0].groups.map((g) => g.group.id)).toEqual(['old', 'new', 'mid']);
  });

  it('hides tabs of deleted groups and empty unlocked groups', () => {
    const view = buildView(map(group('gone', 'me', 1, { deleted: true }), tab('orphan', 'gone', 'a0'), group('empty', 'me', 2)), 'me');
    expect(view[0].groups).toEqual([]);
  });

  it('keeps an empty locked group', () => {
    const view = buildView(map(group('g', 'me', 1, { locked: true })), 'me');
    expect(view[0].groups).toHaveLength(1);
  });

  it('filters tabs by title or URL, case-insensitively', () => {
    const view = buildView(map(group('g', 'me', 1), tab('t1', 'g', 'a0', 'https://Example.com'), tab('t2', 'g', 'a1', 'https://other.org')), 'me', 'example');
    expect(view[0].groups[0].tabs.map((t) => t.id)).toEqual(['t1']);
  });
});
