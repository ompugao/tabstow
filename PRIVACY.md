# Tabstow privacy policy

Last updated: 2026-10-14

Tabstow is an open-source browser extension and server (MIT license, https://github.com/ompugao/tabstow).
The extension's developer does not run any server for it and does not receive any of your data.

## What the extension stores

When you stow tabs, the extension stores, in your browser's local extension storage:

- the URL and title of each stowed tab, and the groups they belong to,
- the name you give this machine,
- your settings, and, if you sign in, the server URL, a sign-in token, and the account name the server reports.

## Where data is sent

Nothing leaves your browser unless you enter a sync server URL in Settings.

If you do, the extension sends your stowed tabs, groups, and machine names to that server, and only to that server.
The server is software you (or someone you trust) run; its operator can read the data it stores.
Signing in opens your identity provider (GitHub, Google, or the provider the server is configured with) through
that server, which receives your account name and email address from the provider.

The extension does not:

- contact the websites you stowed (favicons come from the browser's own cache),
- include analytics, tracking, or advertising,
- sell or share data with anyone,
- load remote code.

## Removing data

Deleting stowed tabs in the extension deletes them on your server at the next sync.
Removing the extension deletes its local storage. To delete data on a server, ask its operator,
or delete the server's database if you run it yourself.

## Contact

Open an issue at https://github.com/ompugao/tabstow/issues.
