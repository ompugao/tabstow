> Original implementation plan, agreed with the owner on 2026-10-14. Kept for context.
> The code differs in a few places; see `development-status.md` for the current state.
> Notable differences: repo renamed to `tabstow` (module `github.com/ompugao/tabstow/server`),
> no popup, no group positions, server packages `internal/db` and `internal/sync` became `internal/store`.

# Plan: Tabstow, a OneTab-like tab manager with per-machine server sync

## Context

The repo `ompugao/tab_manager` is empty. The goal is a Chromium (Chrome/Edge/Brave) extension that, like OneTab, archives the open tabs of a window into a list and closes them. Unlike OneTab, every machine's archive is synchronized to a self-hosted server, so any machine can see, open, edit, and delete tabs archived on any other machine. The extension will be published publicly on the Chrome Web Store later; every user runs their own server. The author hosts their own instance first.

## Decisions (settled with the user)

| Topic | Decision |
|---|---|
| Name | **Tabstow**. Manifest name "Tabstow", server binary `tabstow-server`. Repo rename is the user's call. |
| License | MIT |
| Server | Go 1.27 + SQLite (`modernc.org/sqlite`, CGO-free), `net/http` pattern routing, no framework |
| Extension | Preact + TypeScript + Vite, Manifest V3, `_locales` with English only |
| Tools | mise pins node, pnpm, go; mise tasks for dev/build/test |
| Deployment | Dockerfile + docker-compose with only the app and a data volume. TLS is the user's existing reverse proxy. |
| Auth providers | `github` (OAuth2 + API, documented default), `google` (OIDC), `oidc` (generic: issuer, client id, secret). One or more enabled by config. |
| Account identity | provider + provider user id. Google and GitHub sign-ins are separate accounts, not linked. |
| Allowlist | Entries like `github:ompugao`, `google:me@gmail.com`, `oidc:me@example.com`. Empty allowlist means nobody can sign in. |
| Session | Random API token, SHA-256 hash stored, 1 year expiry, "sign out everywhere" in options |
| Device | One device per extension install, random id on first run, user-editable name |
| Archive | Current window only, skip pinned and `chrome://` tabs and the list page, close tabs, open the list page. Extra menu actions: all windows, copy without closing, tabs to the right, this tab |
| Open from list | Remove the tab from the list unless the group is locked; global toggle |
| Offline | Fully usable without sign-in; local storage is the source of truth per device |
| Conflicts | Last-write-wins per record by client `updatedAt`. Tombstones follow the same rule. A tab whose group is deleted is hidden and purged (group deletion wins). |
| Duplicates | Add anyway in v1 |
| Sync cadence | 2 s debounce after local change, alarm every 5 min, browser start, list page open/focus, manual button |
| Distribution | Load unpacked for now; Web Store later. Server-side OAuth keeps the extension id irrelevant. |
| Host permission | `optional_host_permissions: ["https://*/*"]`, requested at runtime for the one origin entered in options |
| Privacy | Plain text on the user's own server. Record contents live in one JSON column so client-side encryption can be added later. |
| Icon | Generated placeholder SVG rendered to 16/32/48/128 PNG |
| Deferred | Server web page, duplicate detection, Chrome tab groups, Firefox, Japanese locale, E2E encryption, personal access token auth |

## Repository layout

```
mise.toml
LICENSE                   # MIT
README.md                 # setup: provider OAuth apps, server env, load extension, privacy note
.gitignore                # node_modules, dist, *.db, .env
extension/                # pnpm project
  manifest.json
  vite.config.ts
  public/_locales/en/messages.json
  public/icons/           # generated PNGs
  scripts/make-icons.ts   # SVG -> PNG via sharp (dev dependency)
  src/
    background.ts         # toolbar click, context menus, commands, alarms, sync scheduling
    lib/model.ts          # Record types, ids, fractional positions
    lib/store.ts          # chrome.storage.local access, dirty tracking, mutations
    lib/sync.ts           # push/pull client
    lib/auth.ts           # launchWebAuthFlow against server, token storage
    lib/tabs.ts           # archive / restore using chrome.tabs
    lib/settings.ts       # server URL, device name, open behavior
    lib/i18n.ts           # chrome.i18n.getMessage wrapper
    ui/                   # list page
    popup/
    options/
server/                   # Go module github.com/ompugao/tab_manager/server
  cmd/tabstow-server/main.go
  internal/config/        # env: LISTEN_ADDR, DB_PATH, BASE_URL, ALLOWLIST, TOKEN_TTL,
                          #      GITHUB_CLIENT_ID/SECRET, GOOGLE_CLIENT_ID/SECRET,
                          #      OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET
  internal/db/            # sqlite open, embedded migrations
  internal/auth/          # providers (github, google, oidc), allowlist, tokens, oauth states
  internal/sync/          # apply LWW, changes since seq, tombstone purge
  internal/httpapi/       # routes and middleware
  Dockerfile
docker-compose.yml
```

## Data model

Three record kinds in one changes feed. Every record has `id` (UUID v4 from the client), `updatedAt` (ms, client clock), `deleted` (bool). Server adds `seq` (per-user monotonic integer).

- `device`: `name`
- `group`: `deviceId`, `title`, `createdAt`, `locked`, `starred`, `position`
- `tab`: `groupId`, `url`, `title`, `favIconUrl`, `position`

Positions are fractional index strings (`fractional-indexing` npm package); ties break by id. Deleting a group writes a tombstone for the group and each tab. Tombstones older than 30 days are purged on the server; a client whose `lastSeq` predates the purge does a full resync (server returns `resync: true` when `since` is older than the purge watermark).

Local storage: `chrome.storage.local` with `unlimitedStorage`, one key per record (`g:<id>`, `t:<id>`, `d:<id>`) plus `meta` (`deviceId`, `lastSeq`, `dirty: string[]`). Pages re-render from `chrome.storage.onChanged`; no message passing for data.

## Sync protocol

`POST /api/sync` with `{ since, changes }` returns `{ seq, changes, resync? }`.

Server, one transaction per request:
1. For each incoming record: upsert if `incoming.updatedAt >= existing.updatedAt`, assign a new `seq`; else ignore.
2. Return all records of the user with `seq > since`.

Client (`sync.ts`, in the background worker):
1. Send dirty records with `lastSeq`.
2. Apply returned records; a local dirty record with a newer `updatedAt` is kept and pushed next time.
3. Clear dirty flags, store `lastSeq`. On `resync`, drop `lastSeq` and all non-dirty local records, then pull everything.

Runs are serialized with an in-flight promise. Failures leave records dirty and show a status in the UI (offline, signed out, server error).

## Authentication

OAuth runs on the server; the extension never holds client secrets.

1. Extension: `chrome.identity.launchWebAuthFlow({ url: <server>/auth/<provider>/start?redirect=<chrome.identity.getRedirectURL()>, interactive: true })`.
2. Server validates `redirect` against `^https://[a-p]{32}\.chromiumapp\.org/`, stores it with a random `state` (10 min expiry), redirects to the provider.
3. Callback: exchange the code. `github`: call `/user` and `/user/emails` (scope `read:user user:email`), use login and verified primary email. `google` and `oidc`: verify the ID token (`github.com/coreos/go-oidc/v3`), use `sub` and `email` with `email_verified`. Build the identity string `provider:login-or-email`, reject if not in `ALLOWLIST`, upsert the user, mint a token, redirect to `<redirect>#token=...`.
4. Extension stores the token, calls `GET /api/me`. All `/api/*` use `Authorization: Bearer`. `POST /api/logout` revokes one token; `POST /api/logout_all` revokes all of the user's tokens.
5. `GET /auth/providers` lists enabled providers so the options page shows the right sign-in buttons.

## Extension behavior (v1)

- Toolbar button and command (default `Alt+Shift+1`): archive the current window into a new group, close those tabs, open or focus the list page.
- Context menu: "Send this tab", "Send all tabs in this window", "Send tabs to the right", "Send all windows", "Copy tabs to Tabstow without closing".
- Popup: same actions, sync status, link to the list.
- List page: groups sorted by device (this device first, others collapsible), then `createdAt` desc, starred groups pinned to the top of their device. Per group: editable title, created time, tab count, restore all, delete, lock, star. Per tab: favicon + title, click opens it and removes it unless locked or the toggle is off, delete, drag to reorder within or across groups. Search box filters by title/URL. Device rename inline. Status bar with "Sync now" and a sign-in prompt when signed out.
- Options: server URL (triggers `chrome.permissions.request` for that origin), provider sign-in buttons, sign out / sign out everywhere, device name, "remove tab when opened" toggle, export/import JSON.

## Server details

- Tables: `users(id, identity, email, created_at)`, `tokens(hash, user_id, expires_at)`, `oauth_states(state, provider, redirect, expires_at)`, `records(user_id, id, kind, updated_at, deleted, seq, data JSON, PRIMARY KEY(user_id, id))`, index `(user_id, seq)`, `meta(purge_watermark_seq)`.
- Middleware: bearer auth, request body limit (8 MB), structured logging. `GET /healthz`.
- Hourly purge of expired tokens, expired states, and tombstones older than 30 days.
- Dockerfile: multi-stage, `CGO_ENABLED=0`, distroless, volume for `DB_PATH`.

## Tooling

- `mise.toml`: `node = "22"`, `pnpm = "latest"`, `go = "1.27"`; tasks `ext:dev`, `ext:build`, `ext:test`, `ext:icons`, `server:run`, `server:test`, `build`.
- Extension: Vite inputs `src/ui/index.html`, `src/popup/index.html`, `src/options/index.html`, `src/background.ts` (module service worker). `vitest` covers `model.ts`, `store.ts` (fake `chrome.storage`), and `sync.ts` apply rules.
- Server: `go test ./...` with in-memory SQLite: LWW accept/reject, tombstones, `since` filtering, resync watermark, allowlist rejection per provider, token expiry, redirect validation.

## Implementation order

1. Scaffold: `mise.toml`, `LICENSE`, `.gitignore`, `README.md`, extension project with manifest, `_locales`, generated icons, empty pages; builds and loads unpacked.
2. `model.ts`, `store.ts`, `tabs.ts`, list page: archive and restore fully offline, with title edit, delete, lock, star.
3. Server: config, DB, migrations, sync endpoint and tests. Run on `http://localhost:8080` with auth disabled by a dev flag (`DEV_TOKEN=...` bearer token).
4. `sync.ts`, background scheduling, options page server URL; verify two Chrome profiles converge.
5. Auth: providers, tokens, allowlist, `/auth/providers`; extension sign-in UI; protect `/api/*`; remove the dev flag path from production builds.
6. Polish: drag and drop, search, device rename, export/import, popup, context menus, command.
7. Dockerfile, compose, README deployment and privacy sections.

## Verification

- `mise run ext:test` and `mise run server:test` pass.
- `mise run ext:build`, load unpacked, click the toolbar button on a window with several tabs: tabs close, list shows the group, clicking a tab reopens it and removes it.
- Start the server with a GitHub OAuth app whose callback is `http://localhost:8080/auth/github/callback`; sign in from options, `/api/me` shows the identity, a non-allowlisted account is rejected. Repeat with Google.
- Two Chrome profiles with different device names on the same server: archive in one, appears in the other within one sync; delete from the second, disappears from the first; edit the same title on both while one is offline, reconnect, later edit wins; delete a group on one while adding a tab to it on the other, group stays deleted.
- `docker compose up`, `curl /healthz` returns 200.
