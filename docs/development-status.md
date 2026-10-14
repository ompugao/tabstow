# Development status

Last updated: 2026-10-14. Written for whoever picks up this project next, human or agent.
User-facing setup lives in the top-level README. This file records decisions, current state, and gotchas.

## Goal

A OneTab-like tab manager for Chromium browsers. Each machine (one extension install) keeps its own
list of stowed tabs, and all lists sync through a self-hosted server. The owner plans to publish the
extension publicly on the Chrome Web Store later; every user then runs their own server.

## Decisions already made with the owner

Do not re-open these without asking.

| Topic | Decision |
|---|---|
| Name | Tabstow (repo directory was renamed from `tab_manager`) |
| License | MIT |
| Server | Go + SQLite (`modernc.org/sqlite`, no CGO), plain `net/http` |
| Extension | Manifest V3, Preact + TypeScript + Vite, `_locales` with English only |
| Tools | mise (`mise.toml` pins node, pnpm, go and defines tasks) |
| Hosting | Self-hosted only. Docker Compose with app + data volume; TLS is the user's reverse proxy |
| Sign-in | Server-side OAuth. Providers: `github` (default), `google`, generic `oidc`. Personal access tokens were deferred |
| Accounts | Keyed by provider + provider user id. Accounts from different providers are not linked |
| Allowlist | `github:<login>`, `google:<email>`, `oidc:<email>`. Empty allowlist means nobody can sign in. Checked again on every API request, so removing an entry ends that user's sessions. A GitHub login stays bound to the first account (numeric id) that used it, so a re-registered login is refused |
| Extension IDs | `EXTENSION_IDS` is required when a provider is configured. Tokens are only redirected to `https://<listed id>.chromiumapp.org/<short path>`; otherwise any installed extension could sign in silently and read the user's tabs |
| Session | Random bearer token, SHA-256 stored, 1 year TTL, "sign out everywhere" supported |
| Device | One device per extension install, random id, user-editable name |
| Cross-machine | Full edit from any machine |
| Conflicts | Last-write-wins per record on client `updatedAt`. Equal timestamps: server copy wins. Deletes are tombstones under the same rule |
| Deleted group vs. concurrent tab added to it | Group deletion wins; the client tombstones orphan tabs |
| Offline | Fully usable without a server. Local storage is the source of truth per device |
| Archive action | Toolbar click stows the current window and closes the tabs. Pinned and non-http(s)/file/ftp tabs are skipped |
| Opening a tab | Removes it from the list unless the group is locked; global toggle in Settings |
| Duplicate URLs | Kept (no dedup in v1) |
| Privacy | Plain text on the server. Record payload is one JSON column so client-side encryption can be added later |

## Architecture

### Data model

Three record kinds share one changes feed. Every record is
`{ id, kind, updatedAt, deleted, data }`; the server adds `seq`.

- `device`: `{ name }`
- `group`: `{ deviceId, title, createdAt, locked, starred }`
- `tab`: `{ groupId, url, title, favIconUrl, position }`

Tab order uses fractional index strings (`fractional-indexing`), ties broken by id.
Groups have no position; they sort by starred, then `createdAt` descending.

### Extension (`extension/`)

- `src/lib/store.ts` – all local edits. Records live in `chrome.storage.local` as `r:<id>` with a
  `dirty` flag inside the record, so a write and its dirty mark are atomic. `write()` forces
  `updatedAt = max(now, previous + 1)` so a local edit always beats the version it was based on.
- `src/lib/sync.ts` – one sync round: push dirty records, apply the response, keep local records that
  were edited while the request was in flight, handle `resync`, tombstone orphan tabs.
- `src/lib/syncService.ts` – serializes runs, decides status (`unconfigured`, `signed-out`,
  `no-permission`, `offline`, `error`, `ok`), clears the token on 401.
- `src/background.ts` – toolbar click, `Alt+Shift+1`, context menus (on the toolbar icon and pages),
  5-minute pull alarm, 2-second debounced push after any dirty write.
- `src/ui/` – list page. `src/options/` – settings page. Both render from `chrome.storage` through
  `useSnapshot` in `src/lib/hooks.ts`; there is no message passing for data.
- Server host permission is optional (`optional_host_permissions`) and requested at runtime when the
  user saves the server URL. Changing the server URL revokes the session, resets `lastSeq`, and marks all
  local records dirty so they upload to the new server.
- Favicons come from Chrome's `_favicon` endpoint, never from the stowed sites.
- Only http(s)/ftp/file URLs are rendered as links or opened (`isOpenableUrl`), whatever the record says.
- Records from the server or an import file pass `isValidRecord` (`src/lib/model.ts`) before they are stored,
  so a malformed record cannot break rendering or be pushed back and block every later sync.

### Server (`server/`)

- `internal/store/sync.go` – the sync rules. `POST /api/sync {since, changes}` stores newer records,
  returns everything with `seq > since`, plus the current copy of any rejected record.
  `resync: true` when `since` is ahead of the server or older than the purge watermark.
- `internal/store/users.go` – users, tokens, one-shot OAuth states.
- `internal/auth/` – providers and the allowlist. OIDC discovery is lazy so the server starts while the
  issuer is down. Redirect targets must match `https://<32 a-p chars>.chromiumapp.org/`.
- `internal/httpapi/` – routes: `/` (static landing page in `landing.go`, exact path only), `/healthz`, `/auth/providers`, `/auth/{provider}/start`,
  `/auth/{provider}/callback`, `/api/me`, `/api/sync`, `/api/logout`, `/api/logout_all`.
  The callback returns the token in the redirect fragment (`#token=` or `#error=`).
- Hourly purge of tombstones older than `TOMBSTONE_TTL`, expired tokens, and expired states.
- At most 1000 pending OAuth states. Expired ones are purged on insert; past the cap `/auth/*/start` answers 429.
- Sync limits: 200,000 records per user (tombstones included), `data` must be a JSON object, and
  `updatedAt` may be at most 24 hours ahead of the server clock, so no record can be pinned forever.
- `http.Server` has read, write, and idle timeouts. Every response carries `Cache-Control: no-store`,
  `nosniff`, `no-referrer`, and a restrictive CSP. `DEV_TOKEN` is compared in constant time.
- Generic OIDC requires `email_verified: true`, since the allowlist matches on email.
- `DEV_TOKEN` is a fixed bearer token for local testing, refused unless `BASE_URL` is localhost.

## Current state

Everything in the v1 plan is implemented except the items under "Not done".

Verified:

- `mise run test`: Go tests (store, auth, config, HTTP flow with a fake provider) and 22 vitest tests,
  including two-device convergence against an in-memory server that mirrors the Go rules.
- `mise run ext:build` produces `extension/dist`, which loads in Chrome.
- A Puppeteer run with two Chrome for Testing profiles against a local server with `DEV_TOKEN`
  passed 11 checks: stow via toolbar action, auto push, the other device sees the group, deletion
  propagates back, clicking a tab reopens and removes it, settings page shows the account.
  That script was not committed. To recreate it: copy `dist`, add `"host_permissions": ["http://localhost/*"]`
  to the copied manifest (headless Chrome cannot accept the permission prompt), launch with
  `pipe: true, enableExtensions: true`, call `browser.installExtension()`, write `settings` and `auth`
  into `chrome.storage.local` from the list page, and use `page.triggerExtensionAction()`.
- The Docker image builds and runs (~25 MB, distroless, non-root, `/data` owned by `nonroot`).
- The owner loaded `extension/dist` unpacked in their own Chrome and confirmed it works locally
  (without a sync server).
- The owner deployed the server with Docker behind a reverse proxy. Through the proxy, `/` serves the
  landing page, `/healthz` returns `ok`, `/auth/providers` lists `github`, and `/auth/github/start`
  redirects to GitHub with the right callback URL.

Not verified:

- Sync against the owner's deployed server.
- A completed real sign-in. The owner created a GitHub OAuth app, but nobody has finished the flow from
  the extension yet. Google and generic OIDC are untested.
- Edge and Brave (only Chrome was tested).
- Drag and drop in the list page was not exercised by automated tests.

## Not done / deferred

- Popup: dropped on purpose. A popup and a one-click toolbar action cannot coexist; actions are in the
  toolbar context menu instead.
- Personal access token sign-in (paste a token generated on the server).
- A web UI on the server (only a static landing page exists), duplicate detection, Chrome tab group colors, Firefox, Japanese locale,
  client-side encryption, group reordering.
- Chrome Web Store assets: the icon in `extension/scripts/icon.svg` is a placeholder; no screenshots yet.
- `extension/scripts/make-icons.mjs` regenerates PNGs; the PNGs are committed.

## Gotchas

- Library versions are newer than many references: Preact 11, TypeScript 7 (native `tsc`), Vite 8,
  vitest 5, fractional-indexing 4, `@types/chrome` 0.3. Check installed types before assuming an API.
  `@preact/preset-vite` is not used (it requires Babel); JSX is configured through `jsxImportSource` in
  `tsconfig.json`.
- `vite.config.ts` sets `root` to `src`, so pages build to `dist/ui/index.html` and
  `dist/options/index.html`. The background worker is a module service worker at `dist/background.js`.
- On the owner's machine, Docker build containers cannot resolve DNS (the LAN resolver `192.168.10.1`
  returns "server misbehaving"). Workarounds: `docker build --network=host -t tabstow-tabstow ./server`
  then `docker compose up -d`, or set `"dns"` in `/etc/docker/daemon.json`. Putting `network: host` in the
  compose file was rejected because Compose v5 then demands `--allow=network.host` on every build.
- Chrome's sandbox cannot start inside the agent's sandboxed shell; automated browser runs needed
  `--no-sandbox`.
- `mise run build` writes the server binary to `server/bin/` (gitignored). It used to write to a
  top-level `dist/`, and the owner loaded that folder in Chrome by mistake; `extension/dist` should be the
  only `dist` folder.
- The mise build task passes `-buildvcs=false` because `go build` failed with a VCS stamping error
  before the first commit.
- The owner's `.env` was empty at the time of writing; the server exits when `BASE_URL` is missing.
