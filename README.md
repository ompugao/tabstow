# Tabstow

Tabstow is a tab manager for Chromium-based browsers (Chrome, Edge, Brave), similar to OneTab.
Click the toolbar button and the tabs of the current window are stowed into a list and closed.
Each machine keeps its own list, and every list is synced through a server you host yourself,
so you can see, open, edit, and delete tabs stowed on any of your machines.

- Works fully offline. Sync is optional.
- Self-hosted server: one Go binary with one SQLite file.
- Sign-in with GitHub (default), Google, or any OpenID Connect provider, restricted by an allowlist.

## Using the extension

- **Toolbar button** or `Alt+Shift+1`: stow all tabs of the current window.
  Pinned tabs and browser-internal pages (`chrome://`, extension pages) are skipped.
- **Right-click the toolbar button or a page** for more actions: show the list, stow only this tab,
  stow tabs to the right, stow all windows, or copy tabs without closing them.
- **List page**: tabs are grouped per machine and per stow action.
  Click a tab to open it. It is removed from the list unless the group is locked
  (this can be turned off in Settings). Drag tabs to reorder them or move them between groups.
  Click a group title or a machine name to rename it.
- **Settings**: server URL, sign-in, this machine's name, and JSON export/import.

### How sync conflicts are resolved

Every group, tab, and machine name is a separate record with a timestamp.
When two machines change the same record, the later change wins on all machines, and the other change is discarded.
A deleted group stays deleted: if another machine moved a tab into it at the same time, that tab is removed too.
Machines need roughly correct clocks (NTP) for "later" to mean what you expect.

## Running the server

### 1. Create an OAuth app

**GitHub (recommended).** Go to GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.

- Homepage URL: your server URL, e.g. `https://tabs.example.com`
- Authorization callback URL: `https://tabs.example.com/auth/github/callback`

Copy the client ID and generate a client secret.

**Google.** In Google Cloud Console → APIs & Services → Credentials, create an OAuth client ID of type
"Web application" with the redirect URI `https://tabs.example.com/auth/google/callback`.

**Other OpenID Connect providers** (Authelia, Keycloak, Authentik, ...): create a client with the redirect URI
`https://tabs.example.com/auth/oidc/callback` and the scopes `openid email profile`.

You can enable more than one provider. Each provider creates a separate account on the server;
accounts are not linked, so use one provider on all your machines.

### 2. Configure

Copy `.env.example` to `.env` and fill it in.

| Variable | Required | Description |
|---|---|---|
| `BASE_URL` | yes | Public URL of the server, without a trailing slash |
| `EXTENSION_IDS` | yes | Comma-separated IDs of the Tabstow extensions allowed to sign in. Shown in the extension's Settings page and on `chrome://extensions`. Without this, any other installed extension could sign in to your server and read your tabs. |
| `ALLOWLIST` | yes | Comma-separated identities that may sign in: `github:<login>`, `google:<email>`, `oidc:<email>`. Empty means nobody can sign in. Removing an entry also ends that user's existing sessions. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | one provider | GitHub OAuth app |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | one provider | Google OAuth client |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | one provider | Generic OpenID Connect provider |
| `LISTEN_ADDR` | no | Default `:8080` |
| `DB_PATH` | no | Default `tabstow.db` (`/data/tabstow.db` in Docker) |
| `TOKEN_TTL` | no | How long a sign-in lasts. Default `8760h` (one year) |
| `TOMBSTONE_TTL` | no | How long deletions are remembered for sync. Default `720h` (30 days) |
| `DEV_TOKEN` | no | Development only: a fixed bearer token. Refused unless `BASE_URL` is localhost. |

### 3. Start

```sh
docker compose up -d --build
```

The compose file binds the server to `127.0.0.1:8080`. Put it behind your reverse proxy with HTTPS
(OAuth providers require HTTPS callback URLs except for localhost). `GET /healthz` returns `ok`.

Without Docker:

```sh
mise run build              # builds server/bin/tabstow-server
BASE_URL=... ALLOWLIST=... GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... ./server/bin/tabstow-server
```

## Installing the extension

```sh
mise install
mise run ext:install
mise run ext:build
```

Open `chrome://extensions`, enable Developer mode, click "Load unpacked", and choose the `extension/dist` folder
(the one that contains `manifest.json`).
Then open Tabstow's Settings, enter your server URL, allow access when the browser asks, and sign in.
Before signing in, add the extension ID shown in Settings to `EXTENSION_IDS` on the server.

The ID of an unpacked extension is derived from the folder it was loaded from, so keep the folder where it is.
A copy installed from the Chrome Web Store has a different, fixed ID; list both in `EXTENSION_IDS` if you use both.
To give an unpacked copy the store ID, add the item's public key from the developer dashboard to `manifest.json` as `"key"`.
Give each machine a name you will recognize.

## Privacy

The server stores the URLs and titles of your stowed tabs in plain text. Only you can read them
through the API, but anyone with access to the server's disk can read the database.
The extension sends data only to the server URL you configure. Favicons are taken from the browser's
own cache, so opening the list page does not contact the stowed websites.

## Development

Tools are managed with [mise](https://mise.jdx.dev/).

```sh
mise run test          # extension and server tests
mise run ext:dev       # rebuild the extension on change
mise run server:run    # needs the environment variables above
mise run ext:icons     # regenerate PNG icons from extension/scripts/icon.svg
```

For a local end-to-end setup, run the server with `BASE_URL=http://localhost:8080 DEV_TOKEN=dev`.
Sign-in through a real provider also works on localhost if the OAuth app's callback URL is
`http://localhost:8080/auth/<provider>/callback`.

### Layout

- `extension/` – Manifest V3 extension (Preact, TypeScript, Vite).
  `src/lib/store.ts` holds local records and edits, `src/lib/sync.ts` the sync client.
- `server/` – Go server. `internal/store/sync.go` holds the sync rules, `internal/auth/` the sign-in providers.

### Sync protocol

`POST /api/sync` with `{"since": <seq>, "changes": [<record>...]}` and a bearer token.
The server keeps an incoming record only if its `updatedAt` is newer than the stored one,
and returns every record changed after `since`, plus the current version of any rejected record.
When the server has purged deletions the client has not seen yet, it answers with `"resync": true`
and the full record set.

## License

MIT
