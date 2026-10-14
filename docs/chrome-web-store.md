# Publishing to the Chrome Web Store

Text and answers for the Chrome Web Store Developer Dashboard, kept here so they stay in sync with the code.

## Package

```sh
mise run ext:zip   # builds and writes extension/tabstow-<version>.zip
```

Bump `version` in `extension/public/manifest.json` before uploading an update.

## Store listing

**Name:** Tabstow

**Summary** (132 characters max):

> Open-source tab manager: stow your tabs into a list and sync them across machines through a server you host yourself.

**Description:**

> Tabstow stows the tabs of a window into a list with one click and closes them, so your browser stays fast and your
> tabs stay findable.
>
> Unlike most tab managers, Tabstow is open source (MIT) and never sends your tabs to the developer or a third-party
> cloud. Sync is optional and goes only to a server you run yourself: a single Go binary with one SQLite file, or one
> Docker container. Anyone can read the code of both the extension and the server at
> https://github.com/ompugao/tabstow.
>
> Features
> • Click the toolbar button (or press Alt+Shift+1) to stow all tabs of the current window.
> • Right-click for more: stow only this tab, the tabs to the right, all windows, or copy tabs without closing them.
> • Every machine keeps its own list, and with sync you can see, open, edit, and delete tabs stowed on any machine.
> • Rename, lock, and star groups; drag tabs between groups; search titles and URLs.
> • Works fully offline. Export and import your lists as JSON.
> • Sign in to your server with GitHub, Google, or any OpenID Connect provider.
> • No analytics, no ads, no remote code. Favicons come from the browser's cache, so opening the list never contacts
>   the stowed websites.
>
> Setting up a server is described in the README on GitHub.

**Category:** Productivity (Workflow & Planning)

**Language:** English

**Graphics** (in `extension/store-assets/`):

| Asset | File |
|---|---|
| Store icon (128×128) | `extension/public/icons/icon128.png` |
| Screenshots (1280×800) | `screenshot-list.png`, `screenshot-list-dark.png`, `screenshot-settings.png` |
| Small promo tile (440×280) | `promo-small.png` |
| Marquee promo tile (1400×560) | `promo-marquee.png` |

The screenshots use sample data from a local server started with `DEV_TOKEN`; the account name shown is a placeholder.

**Homepage URL:** https://github.com/ompugao/tabstow

**Support URL:** https://github.com/ompugao/tabstow/issues

## Privacy practices

**Single purpose:**

> Save the open tabs of a window into a list (and close them), and let the user reopen, organize, and optionally
> sync that list across their own machines through a server they host.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `tabs` | Read the URL and title of the tabs the user stows, close them after stowing, and open stowed tabs again. |
| `storage` | Keep the stowed tab lists and settings in local extension storage. |
| `unlimitedStorage` | Users can stow thousands of tabs; the default quota would make stowing fail silently. |
| `contextMenus` | Offer "stow this tab", "stow tabs to the right", "stow all windows", and "copy tabs" on the toolbar icon and pages. |
| `alarms` | Pull changes from the user's sync server every few minutes. |
| `identity` | Sign in to the user's own sync server through `chrome.identity.launchWebAuthFlow`. |
| `favicon` | Show each stowed tab's icon from the browser's favicon cache, without contacting the website. |
| Host permission (optional, `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`) | Requested at runtime only for the single origin of the sync server the user enters in Settings. The server is self-hosted, so its address cannot be known in advance. |

**Remote code:** No, I am not using remote code. All JavaScript is bundled in the package.

**Data usage** — select:

- **Web history**: the URLs and titles of tabs the user chooses to stow. Sent only to the sync server the user
  configures, if any.
- **Authentication information**: the sign-in token for the user's own sync server.

Certify all three: data is not sold to third parties, not used or transferred for purposes unrelated to the single
purpose, and not used to determine creditworthiness or for lending.

**Privacy policy URL:** https://github.com/ompugao/tabstow/blob/master/PRIVACY.md

## After the first upload

The store assigns a permanent extension ID.

1. Add it to `EXTENSION_IDS` on every server that should accept the store version (keep any unpacked IDs too).
2. Mention it in the README so self-hosters can copy it.
3. Optionally copy the public key from the dashboard (Package → View public key) into
   `extension/public/manifest.json` as `"key"`, so unpacked builds get the same ID.
