export interface DeviceData {
  name: string;
}

export interface GroupData {
  deviceId: string;
  title: string;
  createdAt: number;
  locked: boolean;
  starred: boolean;
}

export interface TabData {
  groupId: string;
  url: string;
  title: string;
  favIconUrl: string;
  position: string;
}

interface Base<K extends string, D> {
  id: string;
  kind: K;
  updatedAt: number;
  deleted: boolean;
  data: D;
}

export type DeviceRec = Base<'device', DeviceData>;
export type GroupRec = Base<'group', GroupData>;
export type TabRec = Base<'tab', TabData>;
export type Rec = DeviceRec | GroupRec | TabRec;

export type StoredRec = Rec & { dirty?: boolean };

export const RECORD_PREFIX = 'r:';
export const recordKey = (id: string) => RECORD_PREFIX + id;
export const isRecordKey = (key: string) => key.startsWith(RECORD_PREFIX);

export const newId = () => crypto.randomUUID();

export function stripLocal(r: StoredRec): Rec {
  const { dirty: _dirty, ...rest } = r;
  return rest as Rec;
}

// Only these schemes are stowed, rendered as links, or opened. Records can come
// from the server or an import file, so a URL there may be anything.
export const isOpenableUrl = (url: string) => /^(https?|ftp|file):/i.test(url);

const MAX_ID_LENGTH = 64; // server/internal/store/sync.go MaxIDLength

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strs = (d: Record<string, unknown>, ...keys: string[]) => keys.every((k) => typeof d[k] === 'string');

// Checks the fields the extension relies on, so a malformed record from the
// server or an import file cannot break rendering or be pushed back to the
// server, where it would be rejected and block every later sync.
export function isValidRecord(r: unknown): r is Rec {
  if (!isObj(r) || !isObj(r.data)) return false;
  if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > MAX_ID_LENGTH) return false;
  if (typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt) || typeof r.deleted !== 'boolean') return false;
  switch (r.kind) {
    case 'device':
      return strs(r.data, 'name');
    case 'group':
      return strs(r.data, 'deviceId', 'title');
    case 'tab':
      return strs(r.data, 'groupId', 'url', 'title', 'position');
    default:
      return false;
  }
}
