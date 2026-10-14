import type { DeviceRec, GroupRec, StoredRec, TabRec } from './model';
import { compareTabs } from './store';

export interface GroupView {
  group: GroupRec;
  tabs: TabRec[];
}

export interface DeviceView {
  id: string;
  name: string;
  isThisDevice: boolean;
  groups: GroupView[];
  tabCount: number;
}

function matches(t: TabRec, query: string): boolean {
  return t.data.title.toLowerCase().includes(query) || t.data.url.toLowerCase().includes(query);
}

// Tabs whose group is deleted or not yet synced stay hidden: a concurrent
// group deletion on another machine wins over a tab added to that group.
export function buildView(all: Map<string, StoredRec>, thisDeviceId: string, query = ''): DeviceView[] {
  const q = query.trim().toLowerCase();
  const devices = new Map<string, DeviceRec>();
  const groups = new Map<string, GroupView>();
  const tabs: TabRec[] = [];
  for (const r of all.values()) {
    if (r.deleted) continue;
    if (r.kind === 'device') devices.set(r.id, r);
    else if (r.kind === 'group') groups.set(r.id, { group: r, tabs: [] });
    else tabs.push(r);
  }
  for (const t of tabs) {
    if (q && !matches(t, q)) continue;
    groups.get(t.data.groupId)?.tabs.push(t);
  }

  const byDevice = new Map<string, DeviceView>();
  for (const gv of groups.values()) {
    if (gv.tabs.length === 0 && !(gv.group.data.locked && !q)) continue;
    gv.tabs.sort(compareTabs);
    const did = gv.group.data.deviceId;
    let dv = byDevice.get(did);
    if (!dv) {
      dv = { id: did, name: devices.get(did)?.data.name ?? '', isThisDevice: did === thisDeviceId, groups: [], tabCount: 0 };
      byDevice.set(did, dv);
    }
    dv.groups.push(gv);
    dv.tabCount += gv.tabs.length;
  }
  if (!q && !byDevice.has(thisDeviceId)) {
    byDevice.set(thisDeviceId, {
      id: thisDeviceId,
      name: devices.get(thisDeviceId)?.data.name ?? '',
      isThisDevice: true,
      groups: [],
      tabCount: 0,
    });
  }

  for (const dv of byDevice.values()) {
    dv.groups.sort(
      (a, b) =>
        Number(b.group.data.starred) - Number(a.group.data.starred) || b.group.data.createdAt - a.group.data.createdAt,
    );
  }
  return [...byDevice.values()].sort(
    (a, b) => Number(b.isThisDevice) - Number(a.isThisDevice) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}
