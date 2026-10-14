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
