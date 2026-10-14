import { t } from './lib/i18n';
import { isRecordKey, type StoredRec } from './lib/model';
import { chromeKV } from './lib/storage';
import { Store } from './lib/store';
import { runSync } from './lib/syncService';
import { archive, showListPage } from './lib/tabs';

const store = new Store(chromeKV());
const PUSH_DELAY_MS = 2000;
const PULL_ALARM = 'pull';
const PULL_PERIOD_MIN = 5;

async function setup() {
  const platform = await chrome.runtime.getPlatformInfo();
  await store.ensureDevice(`${platform.os}-${crypto.randomUUID().slice(0, 4)}`);
  await chrome.alarms.create(PULL_ALARM, { periodInMinutes: PULL_PERIOD_MIN });
  chrome.contextMenus.removeAll(() => {
    const contexts: [`${chrome.contextMenus.ContextType}`, ...`${chrome.contextMenus.ContextType}`[]] = ['action', 'page'];
    const items: [string, string][] = [
      ['open-list', 'menuOpenList'],
      ['send-window', 'menuSendWindow'],
      ['send-tab', 'menuSendTab'],
      ['send-right', 'menuSendRight'],
      ['send-all-windows', 'menuSendAllWindows'],
      ['copy-window', 'menuCopyWindow'],
    ];
    for (const [id, key] of items) chrome.contextMenus.create({ id, title: t(key), contexts });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  setup().then(() => runSync(store));
});

chrome.runtime.onStartup.addListener(() => {
  setup().then(() => runSync(store));
});

async function windowTabs(windowId?: number) {
  return chrome.tabs.query(windowId === undefined ? { currentWindow: true } : { windowId });
}

chrome.action.onClicked.addListener(async (tab) => {
  await archive(store, await windowTabs(tab.windowId), true);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'archive-window') await archive(store, await windowTabs(), true);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const windowId = tab?.windowId ?? (await chrome.windows.getCurrent()).id!;
  switch (info.menuItemId) {
    case 'open-list':
      return showListPage(windowId);
    case 'send-window':
      return archive(store, await windowTabs(windowId), true);
    case 'send-tab':
      return tab && archive(store, [tab], true);
    case 'send-right': {
      const all = await windowTabs(windowId);
      return archive(store, all.filter((x) => tab && x.index > tab.index), true);
    }
    case 'send-all-windows':
      return archive(store, await chrome.tabs.query({}), true);
    case 'copy-window':
      return archive(store, await windowTabs(windowId), false);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PULL_ALARM) runSync(store);
});

let pushTimer: ReturnType<typeof setTimeout> | undefined;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const hasLocalEdit = Object.entries(changes).some(
    ([k, c]) => isRecordKey(k) && (c.newValue as StoredRec | undefined)?.dirty,
  );
  const settingsChanged = 'settings' in changes || 'auth' in changes;
  if (!hasLocalEdit && !settingsChanged) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => runSync(store), PUSH_DELAY_MS);
});

chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
  if (msg?.type !== 'sync') return;
  runSync(store).then(() => sendResponse({ ok: true }));
  return true;
});
