import { isOpenableUrl } from './model';
import type { Store, TabInput } from './store';

const LIST_PATH = 'ui/index.html';

export const listUrl = () => chrome.runtime.getURL(LIST_PATH);

const isListPage = (url: string) => url.startsWith(listUrl());

export function isArchivable(tab: chrome.tabs.Tab): boolean {
  const url = tab.url ?? '';
  return !tab.pinned && isOpenableUrl(url) && !isListPage(url);
}

function toInput(tab: chrome.tabs.Tab): TabInput {
  const fav = tab.favIconUrl ?? '';
  return {
    url: tab.url!,
    title: tab.title || tab.url!,
    favIconUrl: /^https?:/.test(fav) ? fav : '',
  };
}

// Opens or moves the single list tab into `windowId` before tabs are closed,
// so archiving every tab of a window does not close the window itself.
export async function showListPage(windowId: number): Promise<void> {
  const [existing] = await chrome.tabs.query({ url: listUrl() + '*' });
  if (existing?.id !== undefined) {
    if (existing.windowId !== windowId) await chrome.tabs.move(existing.id, { windowId, index: -1 });
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ windowId, url: listUrl(), active: true });
}

export async function archive(store: Store, tabs: chrome.tabs.Tab[], close: boolean): Promise<void> {
  const byWindow = new Map<number, chrome.tabs.Tab[]>();
  for (const t of tabs.filter(isArchivable)) {
    const list = byWindow.get(t.windowId) ?? [];
    list.push(t);
    byWindow.set(t.windowId, list);
  }
  for (const list of byWindow.values()) await store.createGroup(list.map(toInput));

  const target = tabs[0]?.windowId ?? (await chrome.windows.getCurrent()).id!;
  await showListPage(target);
  if (close) {
    const ids = [...byWindow.values()].flat().map((t) => t.id!);
    if (ids.length) await chrome.tabs.remove(ids);
  }
}

export async function openUrls(urls: string[], active: boolean): Promise<void> {
  const safe = urls.filter(isOpenableUrl);
  for (const [i, url] of safe.entries()) await chrome.tabs.create({ url, active: active && i === 0 });
}

export function faviconSrc(pageUrl: string): string {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', '32');
  return u.toString();
}
