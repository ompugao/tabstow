import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import '../styles.css';
import { fetchProviders } from '../lib/api';
import { SignInError, signIn, signOut, type SignInStep } from '../lib/auth';
import { requestSync, useSnapshot } from '../lib/hooks';
import { t } from '../lib/i18n';
import { stripLocal, type DeviceRec, type Rec } from '../lib/model';
import { normalizeServerUrl, originPattern, saveSettings } from '../lib/settings';
import { chromeKV } from '../lib/storage';
import { Store } from '../lib/store';
import { resetLastSeq } from '../lib/sync';

const kv = chromeKV();
const store = new Store(kv);

const PROVIDER_LABELS: Record<string, string> = { github: 'GitHub', google: 'Google', oidc: 'OpenID Connect' };

type Message = { text: string; error: boolean } | null;

function Msg(props: { msg: Message }) {
  if (!props.msg) return null;
  return <div class={`message ${props.msg.error ? 'error' : ''}`}>{props.msg.text}</div>;
}

function signInErrorText(e: unknown): string {
  if (e instanceof SignInError) {
    if (e.code === 'not_allowed') return t('errNotAllowed', e.identity ?? '');
    return t('errSignIn', e.code);
  }
  return t('errSignIn', e instanceof Error ? e.message : String(e));
}

// A different server holds a different dataset: end the old session and
// re-upload everything stored locally to the new one.
async function switchServer(serverUrl: string) {
  await signOut(kv, false);
  await resetLastSeq(store);
  await store.markAllDirty();
  await saveSettings(kv, { serverUrl });
}

function ServerSection(props: { serverUrl: string }) {
  const [input, setInput] = useState(props.serverUrl);
  const [msg, setMsg] = useState<Message>(null);
  useEffect(() => setInput(props.serverUrl), [props.serverUrl]);

  const save = async () => {
    if (input.trim() === '') {
      await switchServer('');
      setMsg(null);
      return;
    }
    const url = normalizeServerUrl(input);
    if (!url) {
      setMsg({ text: t('errServerUrl'), error: true });
      return;
    }
    const granted = await chrome.permissions.request({ origins: [originPattern(url)] });
    if (!granted) {
      setMsg({ text: t('errPermission'), error: true });
      return;
    }
    if (url !== props.serverUrl) await switchServer(url);
    setMsg({ text: t('saved'), error: false });
  };

  return (
    <section>
      <h2>{t('server')}</h2>
      <p class="muted">{t('serverHelp')}</p>
      <div class="row">
        <input
          type="url"
          placeholder="https://tabs.example.com"
          value={input}
          onInput={(e) => setInput((e.currentTarget as HTMLInputElement).value)}
        />
        <button class="primary" onClick={save}>
          {t('save')}
        </button>
      </div>
      <Msg msg={msg} />
    </section>
  );
}

function AccountSection(props: { serverUrl: string; identity: string | null }) {
  const [providers, setProviders] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<Message>(null);
  const [step, setStep] = useState<SignInStep | null>(null);

  useEffect(() => {
    setProviders(null);
    if (!props.serverUrl || props.identity) return;
    fetchProviders(props.serverUrl)
      .then(setProviders)
      .catch((e) => setMsg({ text: t('errProviders', String(e?.message ?? e)), error: true }));
  }, [props.serverUrl, props.identity]);

  if (!props.serverUrl) {
    return (
      <section>
        <h2>{t('account')}</h2>
        <p class="muted">{t('accountNeedsServer')}</p>
      </section>
    );
  }

  const doSignIn = async (p: string) => {
    if (step) return;
    setMsg(null);
    try {
      await signIn(kv, p, setStep);
      requestSync();
    } catch (e) {
      setMsg({ text: signInErrorText(e), error: true });
    } finally {
      setStep(null);
    }
  };

  return (
    <section>
      <h2>{t('account')}</h2>
      {props.identity ? (
        <>
          <p>{t('signedInAs', props.identity)}</p>
          <div class="row">
            <button onClick={() => signOut(kv, false)}>{t('signOut')}</button>
            <button class="danger" onClick={() => signOut(kv, true)}>
              {t('signOutEverywhere')}
            </button>
          </div>
        </>
      ) : (
        <>
          <p class="muted">{t('extensionIdHelp', chrome.runtime.id)}</p>
          <div class="row">
            {(providers ?? []).map((p) => (
              <button class="primary" key={p} disabled={step !== null} onClick={() => doSignIn(p)}>
                {t('signInWith', PROVIDER_LABELS[p] ?? p)}
              </button>
            ))}
          </div>
          {step && <div class="message muted">{t(step === 'browser' ? 'signInBrowser' : 'signInVerifying')}</div>}
        </>
      )}
      <Msg msg={msg} />
    </section>
  );
}

function DeviceSection(props: { deviceId: string; name: string }) {
  const [name, setName] = useState(props.name);
  useEffect(() => setName(props.name), [props.name]);
  return (
    <section>
      <h2>{t('thisDevice')}</h2>
      <p class="muted">{t('deviceHelp')}</p>
      <div class="row">
        <input type="text" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
        <button
          class="primary"
          disabled={!name.trim() || name === props.name}
          onClick={() => store.renameDevice(props.deviceId, name.trim())}
        >
          {t('save')}
        </button>
      </div>
    </section>
  );
}

function BehaviorSection(props: { removeOnOpen: boolean }) {
  return (
    <section>
      <h2>{t('behavior')}</h2>
      <label class="row">
        <input
          type="checkbox"
          checked={props.removeOnOpen}
          onChange={(e) => saveSettings(kv, { removeOnOpen: (e.currentTarget as HTMLInputElement).checked })}
        />
        {t('removeOnOpen')}
      </label>
    </section>
  );
}

function DataSection() {
  const [msg, setMsg] = useState<Message>(null);

  const exportData = async () => {
    const recs = [...(await store.all()).values()].filter((r) => !r.deleted).map(stripLocal);
    const blob = new Blob([JSON.stringify({ format: 'tabstow/1', records: recs }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tabstow-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importData = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { format?: string; records?: Rec[] };
      if (parsed.format !== 'tabstow/1' || !Array.isArray(parsed.records)) throw new Error(t('errImportFormat'));
      await store.importRecords(parsed.records);
      setMsg({ text: t('imported', parsed.records.length), error: false });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  };

  return (
    <section>
      <h2>{t('data')}</h2>
      <div class="row">
        <button onClick={exportData}>{t('export')}</button>
        <label>
          <button onClick={(e) => (e.currentTarget.nextElementSibling as HTMLInputElement).click()}>{t('import')}</button>
          <input
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => {
              const f = (e.currentTarget as HTMLInputElement).files?.[0];
              if (f) importData(f);
            }}
          />
        </label>
      </div>
      <Msg msg={msg} />
    </section>
  );
}

function App() {
  const snap = useSnapshot(store);
  useEffect(() => {
    document.title = `${t('extName')} – ${t('settings')}`;
  }, []);
  if (!snap) return null;
  const device = snap.records.get(snap.deviceId) as DeviceRec | undefined;
  const signedIn = snap.auth && snap.auth.serverUrl === snap.settings.serverUrl ? snap.auth.identity : null;
  return (
    <>
      <div class="topbar">
        <h1>
          {t('extName')} – {t('settings')}
        </h1>
      </div>
      <main>
        <ServerSection serverUrl={snap.settings.serverUrl} />
        <AccountSection serverUrl={snap.settings.serverUrl} identity={signedIn} />
        <DeviceSection deviceId={snap.deviceId} name={device?.data.name ?? ''} />
        <BehaviorSection removeOnOpen={snap.settings.removeOnOpen} />
        <DataSection />
      </main>
    </>
  );
}

document.body.classList.add('options');
render(<App />, document.getElementById('app')!);
