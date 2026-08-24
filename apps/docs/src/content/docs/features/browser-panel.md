---
title: Browser panels (experimental)
description: Open a daemon-hosted Browser panel or a client-side iframe Browser web panel.
---

Treeport supplies two browser workflows:

- A **Browser panel** runs an isolated Chromium page on the daemon computer.
- The **Browser web panel** runs an iframe on the client computer.

Use a Browser panel for daemon-local servers, iframe-blocking sites, and shared agent control.

Use the Browser web panel when the client can reach and embed the site.

## Use a Browser panel

### Install the managed browser

Install the Chromium build that matches Treeport:

```sh
treeport browser install
```

Check or remove the installation:

```sh
treeport browser status
treeport browser remove
```

On Linux, an error can identify missing operating-system libraries.

Install these libraries as an administrator. Then, run the Treeport command again.

Treeport does not request administrator access.

### Open a development server

1. Select **Browser** from **New panel**.
2. Select a server from **Development servers**.

You can also enter an absolute HTTP or HTTPS URL. Press Enter to open it.

Browser panel requests come from the daemon computer. `localhost` identifies that computer.

The target runs as a top-level page. Sites that block iframe use can run in this panel.

Use the address bar, **Back**, **Forward**, and **Reload** to control the page.

Use pointer, keyboard, and scroll input in the viewport.

The panel keeps its current URL and title. Treeport restores the URL before the next client or agent command.

The browser session stays active when you change workspaces or disconnect.

Another connected client can observe the same session and take control.

When a page opens a popup, Treeport creates a new Browser panel in the same tree.

Modifier-click an HTTP or HTTPS terminal link to create a Browser panel in that terminal's tree.

Treeport selects the new panel in the current window.

### Open a Browser panel from the CLI

Create a Browser panel with a blank page:

```sh
treeport browser open --worktree .
```

Create a Browser panel with a URL:

```sh
treeport browser open http://127.0.0.1:5173 --worktree .
```

The server rejects URLs with credentials. It also rejects protocols other than HTTP and HTTPS.

### Control a Browser panel from an agent

Use these commands to inspect and control an open Browser panel:

```sh
treeport browser list
treeport browser snapshot
treeport browser click e12
treeport browser fill e14 "value"
treeport browser press Enter
treeport browser console
treeport browser network
treeport browser screenshot
```

Without `--panel`, Treeport uses the only Browser panel in the current tree.

If multiple panels are open, add `--panel <panel-id>`.

Snapshot references, such as `e12`, identify elements in the shared page.

Agent actions and user actions use one control owner. A user can take control from the viewport.

### Reset or close the browser

Select **Reset** to delete the temporary browser data and open an empty session.

Treeport asks for confirmation before the reset.

Closing a Browser panel deletes its browser data and saved state. Treeport asks for confirmation first.

Each Browser panel uses separate temporary browser data.

Treeport does not use, import, or attach to a personal browser profile.

After a daemon restart, Treeport opens the saved URL in a new empty browser session.

### Understand the limits

Browser panels do not support these features:

- streamed audio;
- downloads;
- file selection or upload;
- automatic clipboard synchronization between the client and daemon.

The Treeport controls have accessible names and keyboard operation.

The streamed page image does not supply semantic accessibility information.

Use `treeport browser snapshot` when you need the page's semantic accessibility data.

A copied address uses the daemon-visible URL. A daemon-local `localhost` URL might not open on another computer.

## Use the iframe Browser web panel

The `@treeport/web-panel-browser` package supplies this web panel.

### Open a detected development server

1. Select **Browser** from the **Web panels** group in **New panel**.
2. Approve the `same-origin` permission.
3. Select a server from **Development servers**.

The page lists TCP ports that Treeport can associate with the current tree.

You can also enter an absolute HTTP or HTTPS URL. Press Enter to open it.

Select **Show development servers** to return to the server list.

Treeport does not select a server automatically. A listed TCP port is not necessarily an HTTP server.

### Open the web panel from the CLI

Use the CLI to open or reuse the iframe Browser web panel:

```sh
treeport web-panel open --worktree . browser \
  --input '{"url":"http://127.0.0.1:5173","title":"Application"}'
```

The client computer must be able to open the URL. `localhost` identifies the client computer.

Treeport does not proxy the application or change its URL.

A browser can block HTTP content in an HTTPS Treeport page because of mixed-content rules.

### Save and restore the address

The web panel saves its current address in panel storage.

If the target uses `@treeport/panel-sdk`, the web panel also saves client-side route changes.

Browser security prevents route observation for other cross-origin targets.

Another client uses the saved address when it opens or reloads the web panel.

If loading fails, start the application or correct the address. Then, select **Retry**.

Use a first-class Browser panel when the target prevents iframe use.

### Use the panel SDK

The target can call `treeport.panel.setTitle()` to set the web panel title.

The SDK lets the Browser web panel observe the target's current route.

The target cannot use context, diff, network discovery, storage, shortcuts, or workspace navigation.

Add `@treeport/panel-sdk` to the normal target build when you use this integration.
