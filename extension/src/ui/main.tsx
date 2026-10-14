import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import '../styles.css';
import { requestSync, useSnapshot } from '../lib/hooks';
import { t } from '../lib/i18n';
import type { TabRec } from '../lib/model';
import type { SyncStatus } from '../lib/settings';
import { chromeKV } from '../lib/storage';
import { Store } from '../lib/store';
import { faviconSrc, openUrls } from '../lib/tabs';
import { buildView, type DeviceView, type GroupView } from '../lib/view';

const store = new Store(chromeKV());
const DRAG_TYPE = 'application/x-tabstow-tab';
const COLLAPSED_KEY = 'tabstow:collapsed';

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

function saveCollapsed(s: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...s]));
  } catch {
    // Collapsed state is a convenience; losing it is harmless.
  }
}

function InlineEdit(props: { value: string; placeholder: string; class?: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <span
        class={`${props.class ?? ''} ${props.value ? '' : 'placeholder'}`}
        title={t('clickToEdit')}
        onClick={() => setEditing(true)}
      >
        {props.value || props.placeholder}
      </span>
    );
  }
  const finish = (e: Event) => {
    const v = (e.currentTarget as HTMLInputElement).value.trim();
    setEditing(false);
    if (v !== props.value) props.onSave(v);
  };
  return (
    <input
      type="text"
      value={props.value}
      placeholder={props.placeholder}
      ref={(el) => el?.focus()}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        if (e.key === 'Escape') setEditing(false);
      }}
    />
  );
}

function statusText(s: SyncStatus | null): { text: string; bad: boolean } {
  if (!s) return { text: '', bad: false };
  const time = new Date(s.at).toLocaleTimeString();
  switch (s.state) {
    case 'ok':
      return { text: t('statusOk', time), bad: false };
    case 'syncing':
      return { text: t('statusSyncing'), bad: false };
    case 'unconfigured':
      return { text: t('statusUnconfigured'), bad: false };
    case 'signed-out':
      return { text: t('statusSignedOut'), bad: true };
    case 'no-permission':
      return { text: t('statusNoPermission'), bad: true };
    case 'offline':
      return { text: t('statusOffline', time), bad: true };
    default:
      return { text: t('statusError', s.message ?? ''), bad: true };
  }
}

function TabRow(props: { tab: TabRec; group: GroupView; removeOnOpen: boolean; dropBefore: boolean; setDrop: (id: string | null) => void }) {
  const { tab, group } = props;
  const open = async (e: MouseEvent) => {
    e.preventDefault();
    await openUrls([tab.data.url], !(e.ctrlKey || e.metaKey || e.button === 1));
    if (props.removeOnOpen && !group.group.data.locked) await store.deleteTabs([tab.id]);
  };
  return (
    <li
      class={`tab ${props.dropBefore ? 'drop-before' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer!.setData(DRAG_TYPE, tab.id);
        e.dataTransfer!.setData('text/uri-list', tab.data.url);
        e.dataTransfer!.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer!.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.stopPropagation();
        props.setDrop(tab.id);
      }}
      onDrop={(e) => {
        const id = e.dataTransfer!.getData(DRAG_TYPE);
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        props.setDrop(null);
        if (id !== tab.id) store.moveTab(id, group.group.id, tab.id);
      }}
    >
      <img src={faviconSrc(tab.data.url)} alt="" />
      <a href={tab.data.url} title={tab.data.url} onClick={open} onAuxClick={open}>
        {tab.data.title}
      </a>
      <button class="remove danger" title={t('removeTab')} onClick={() => store.deleteTabs([tab.id])}>
        ×
      </button>
    </li>
  );
}

function GroupCard(props: { gv: GroupView; removeOnOpen: boolean; searching: boolean }) {
  const { group, tabs } = props.gv;
  const [drop, setDrop] = useState<string | null>(null);
  const locked = group.data.locked;

  const restoreAll = async () => {
    await openUrls(tabs.map((x) => x.data.url), false);
    if (props.removeOnOpen && !locked && !props.searching) await store.deleteGroup(group.id);
    else if (props.removeOnOpen && !locked) await store.deleteTabs(tabs.map((x) => x.id));
  };
  const deleteAll = () => {
    if (props.searching) store.deleteTabs(tabs.map((x) => x.id));
    else store.deleteGroup(group.id);
  };

  return (
    <section class="group">
      <header>
        <InlineEdit
          class="title"
          value={group.data.title}
          placeholder={t('tabCount', tabs.length)}
          onSave={(title) => store.updateGroup(group.id, { title })}
        />
        <span class="muted">
          {group.data.title ? `${t('tabCount', tabs.length)} · ` : ''}
          {new Date(group.data.createdAt).toLocaleString()}
        </span>
        <div class="actions">
          <button onClick={restoreAll}>{t('restoreAll')}</button>
          <button class="danger" onClick={deleteAll} disabled={locked}>
            {t('deleteAll')}
          </button>
          <button
            title={locked ? t('unlock') : t('lock')}
            onClick={() => store.updateGroup(group.id, { locked: !locked })}
          >
            {locked ? '🔒' : '🔓'}
          </button>
          <button
            class={`star ${group.data.starred ? 'on' : ''}`}
            title={group.data.starred ? t('unstar') : t('star')}
            onClick={() => store.updateGroup(group.id, { starred: !group.data.starred })}
          >
            {group.data.starred ? '★' : '☆'}
          </button>
        </div>
      </header>
      <ul
        class={`tabs ${drop === '' ? 'drop-end' : ''}`}
        onDragOver={(e) => {
          if (!e.dataTransfer!.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          setDrop('');
        }}
        onDragLeave={(e) => {
          if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setDrop(null);
        }}
        onDrop={(e) => {
          const id = e.dataTransfer!.getData(DRAG_TYPE);
          setDrop(null);
          if (!id) return;
          e.preventDefault();
          store.moveTab(id, group.id, null);
        }}
      >
        {tabs.map((tab) => (
          <TabRow
            key={tab.id}
            tab={tab}
            group={props.gv}
            removeOnOpen={props.removeOnOpen}
            dropBefore={drop === tab.id}
            setDrop={setDrop}
          />
        ))}
      </ul>
    </section>
  );
}

function DeviceSection(props: { dv: DeviceView; collapsed: boolean; toggle: () => void; removeOnOpen: boolean; searching: boolean }) {
  const { dv } = props;
  return (
    <div class="device">
      <header>
        <button title={props.collapsed ? t('expand') : t('collapse')} onClick={props.toggle}>
          {props.collapsed ? '▸' : '▾'}
        </button>
        <h2>
          <InlineEdit
            value={dv.name}
            placeholder={t('unknownDevice')}
            onSave={(n) => n && store.renameDevice(dv.id, n)}
          />
        </h2>
        {dv.isThisDevice && <span class="muted">{t('thisDevice')}</span>}
        <span class="muted">
          {t('groupCount', dv.groups.length)} · {t('tabCount', dv.tabCount)}
        </span>
      </header>
      {!props.collapsed &&
        (dv.groups.length === 0 ? (
          <div class="empty">{dv.isThisDevice ? t('emptyThisDevice') : t('emptyDevice')}</div>
        ) : (
          dv.groups.map((gv) => (
            <GroupCard key={gv.group.id} gv={gv} removeOnOpen={props.removeOnOpen} searching={props.searching} />
          ))
        ))}
    </div>
  );
}

function App() {
  const snap = useSnapshot(store);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  useEffect(() => {
    document.title = t('extName');
    requestSync();
    const onFocus = () => requestSync();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const view = useMemo(
    () => (snap ? buildView(snap.records, snap.deviceId, query) : []),
    [snap?.records, snap?.deviceId, query],
  );
  if (!snap) return null;

  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
    saveCollapsed(next);
  };
  const status = statusText(snap.status);
  const searching = query.trim() !== '';

  return (
    <>
      <div class="topbar">
        <h1>{t('extName')}</h1>
        <input
          class="search"
          type="search"
          placeholder={t('searchPlaceholder')}
          value={query}
          onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
        />
        <span class="spacer" />
        <span class={`status ${status.bad ? 'bad' : ''}`}>{status.text}</span>
        <button onClick={() => requestSync()} disabled={!snap.auth}>
          {t('syncNow')}
        </button>
        <button onClick={() => chrome.runtime.openOptionsPage()}>{t('settings')}</button>
      </div>
      <main>
        {view.length === 0 && <div class="empty">{t('noMatches')}</div>}
        {view.map((dv) => (
          <DeviceSection
            key={dv.id}
            dv={dv}
            collapsed={!searching && collapsed.has(dv.id)}
            toggle={() => toggle(dv.id)}
            removeOnOpen={snap.settings.removeOnOpen}
            searching={searching}
          />
        ))}
      </main>
    </>
  );
}

render(<App />, document.getElementById('app')!);
