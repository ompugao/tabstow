export interface KV {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export const chromeKV = (): KV => chrome.storage.local;

export class MemoryKV implements KV {
  data = new Map<string, unknown>();

  async get(keys?: string | string[] | null) {
    const out: Record<string, unknown> = {};
    const wanted = keys == null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys];
    for (const k of wanted) {
      if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    }
    return out;
  }

  async set(items: Record<string, unknown>) {
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
  }

  async remove(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.data.delete(k);
  }
}
