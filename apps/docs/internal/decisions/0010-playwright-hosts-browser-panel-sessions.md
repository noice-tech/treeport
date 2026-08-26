# Decision 0010: The Browser primitive has one authoritative runtime

- Status: Accepted
- Date: 2026-08-25

## Context

Treeport must open sites that prevent iframe use.

A browser panel previously had two live runtimes for a local desktop connection:

- Electron showed a native `<webview>`.
- `treeport browser` commands controlled a daemon Playwright page.

The runtimes shared only the saved URL and title.

Clicks, cookies, history, storage, and page state did not move between them.

Remote clients did not have this problem. Their UI stream and CLI commands used the same daemon page.

## Decision

Give each browser panel one authoritative live runtime.

`BrowserSessionManager` remains the panel coordinator.

A coordinator can own one of these runtimes:

- one verified Electron guest;
- one daemon Playwright browser;
- no live runtime.

It must never own both runtimes.

Do not add a general browser-backend framework.

### Local desktop ownership

Use a first-level Electron `<webview>` when Electron connects to a loopback backend.

Create the guest at `about:blank`.

The renderer requests a single-use owner ticket from the daemon.

Electron main validates the exact guest, panel partition, host renderer, and ticket challenge.

Electron then creates a private CDP bridge for that guest.

The bridge:

- binds only to `127.0.0.1`;
- uses an unguessable path;
- exposes one synthetic page target;
- accepts one automation client;
- rejects target replacement and browser close operations;
- stops when the guest or owner stops.

The daemon verifies the bridge identity before it grants ownership.

The first verified local owner wins.

A later local candidate stays blank and is removed.

After a grant, the guest loads the saved URL.

### Local agent control

The daemon connects Playwright to the private bridge.

It keeps one Playwright connection for the owner generation.

Snapshot uses Playwright accessibility references.

Click and fill use these Playwright references on the visible page.

Navigation, history, reload, and screenshot commands use the same guest through the bridge.

A local browser panel does not start managed Chromium.

Before an agent command, the daemon requests an input barrier from Electron.

Electron waits for earlier toolbar work. It then blocks toolbar and pointer input.

The daemon releases this barrier after the command.

An owner disconnect fails the active command. It does not start another runtime for that command.

### Daemon ownership

Use the existing daemon Playwright runtime for:

- web clients;
- remote desktop clients;
- CLI commands when no local owner exists.

The streamed UI and CLI commands use the same Playwright page.

Managed Chromium is required only for this runtime.

### Ownership changes

A verified local claim has priority over daemon Playwright.

Before the daemon grants the claim, it:

1. completes earlier scheduled work;
2. saves the latest URL and title;
3. disconnects agent automation;
4. closes the Playwright browser;
5. keeps the shared daemon browser data;
6. increments the runtime generation;
7. grants the local owner.

When a local owner disconnects, the coordinator becomes idle.

A later remote client or CLI command can start daemon Playwright.

A runtime change keeps the saved URL, title, cookies, local storage, and login state in that runtime profile.

It intentionally loses tab-specific state:

- history;
- session storage;
- DOM and JavaScript state;
- form input;
- snapshot references.

Never silently route an active command to a new runtime.

### Other clients

A web client cannot receive pixels from a local Electron guest.

While a local owner is active, another client shows an explicit local-owner message.

It does not start daemon Playwright.

Local guest streaming is outside this decision.

### State, popups, and close

The active runtime reports URL, title, loading state, and history state.

The daemon is the only component that saves URL and title.

Local owner messages include a runtime generation and increasing state revision.

The daemon rejects stale generations and old revisions.

Electron applies popup policy to the exact guest.

The current owner reports an accepted popup to the daemon.

The daemon creates the new durable browser panel.

All browser panel deletion requests go through `BrowserSessionManager`.

For a local owner, the daemon requests `beforeunload` from Electron.

The daemon deletes the panel only after Electron permits the close.

### Browser data

Browser panels are tabs, not browser-data security boundaries.

All local browser panels use one persistent Electron partition that Treeport owns.

All daemon browser panels use one persistent Chromium profile in the Treeport data directory.

The daemon owns one shared browser and context. Each active panel owns one page in that context.

The daemon starts only one persistent context against the shared profile directory.

It closes the context after it closes the last managed page. It does not remove the profile.

Closing a panel or replacing a runtime does not clear shared browser data.

The desktop and daemon profiles are separate. Treeport does not copy their data between computers or runtimes.

Treeport never imports or opens a personal browser profile.

### Existing panel behavior

Keep the existing:

- durable `BrowserPanel` resource;
- toolbar and address bar;
- development-server list;
- error page;
- popup behavior;
- close confirmation;
- remote JPEG stream;
- bounded daemon scheduler.

## Consequences

The visible local page and `treeport browser` commands now share cookies, history, DOM state, and input state.

Local browser automation does not require `treeport browser install`.

Remote browser automation continues to use managed Chromium and JPEG streaming.

The desktop app adds one private target bridge and one owner socket.

Electron keeps native layout, stacking, audio, and page behavior.

A client cannot observe a local-owned page from another computer.

Runtime replacement keeps shared profile data. It loses only tab-specific state and snapshot references.
