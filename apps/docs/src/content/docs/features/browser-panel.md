---
title: Browser (experimental)
description: Open a top-level web page in Treeport, or use iframe Browser for an embedded client page.
---

Treeport supplies two Browser workflows:

- **Browser** opens a top-level page.
- **iframe Browser** embeds a page in the Treeport web client.

For a local connection, the desktop app runs Browser on the desktop computer.

The web client streams Browser from an isolated Chromium process on the daemon computer.

The desktop app also uses this stream when it connects to a remote computer.

Use Browser for iframe-blocking sites and agent control.

Use iframe Browser when the client can reach and embed the site.

## Use Browser

### Install the managed browser

The web client and agent commands use the managed browser on the daemon computer.

If Browser needs Chromium, select **Install Chromium** on the **Browser unavailable** page.

Treeport downloads the matching Chromium build. Browser opens again when the installation is complete.

To install Chromium before you open Browser, use this command:

```sh
treeport browser install
```

Check or remove the installation:

```sh
treeport browser status
treeport browser remove
```

A local desktop connection does not need this installation.

A remote desktop connection uses the managed browser on the remote computer.

On Linux, an error can identify missing operating-system libraries.

Install these libraries as an administrator. Then, run the Treeport command again.

Treeport does not request administrator access.

### Open a development server

1. Select **Browser** from **New panel**.
2. Select **Development servers** on the right of the address bar.
3. Select a server.

Treeport opens a blank page and puts focus in the address bar.

Enter an HTTP or HTTPS address with or without the protocol. Press Enter to open it.

Treeport uses `http://` when you omit the protocol.

For a local desktop connection, Browser requests come from the desktop computer.

For a web client or remote desktop connection, Browser requests come from the daemon computer.

`localhost` identifies the computer that runs Browser.

The target runs as a top-level page. Sites that block iframe use can run in Browser.

Use the address bar, **Back**, **Forward**, and **Reload** to control the page.

If a page cannot load, Browser shows the network error code.

Start the target or correct the address. Then, select **Reload**.

Use **Development servers** to select another server from the tree.

Use pointer, keyboard, and scroll input in the viewport.

Browser keeps its current URL and title. Treeport restores the URL when it creates a new session.

When a page opens a popup, Treeport opens another Browser in the same tree.

Modifier-click an HTTP or HTTPS terminal link to open Browser in that terminal's tree.

Treeport selects Browser in the current window.

### Open Browser from the CLI

Open Browser with a blank page:

```sh
treeport browser open --worktree .
```

Open Browser with a URL:

```sh
treeport browser open http://127.0.0.1:5173 --worktree .
```

The server rejects URLs with credentials. It also rejects protocols other than HTTP and HTTPS.

### Control Browser from an agent

Use these commands to inspect and control Browser:

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

Without `--panel`, Treeport uses the only Browser session in the current tree.

If multiple sessions are open, add `--panel <panel-id>`.

Snapshot references, such as `e12`, identify elements in the daemon browser session.

Web clients and agents use one control owner for the daemon browser session.

A local desktop connection uses a separate native page. Agent commands use the saved URL in a daemon browser session.

### Close Browser

Close Browser as you close a browser tab. Treeport does not show a data-deletion confirmation.

Browser runs the site's page-close handlers. If the site uses `beforeunload`, Browser asks you before it closes.

Each Browser session uses separate temporary browser data.

Treeport does not use, import, or attach to a personal browser profile.

After an application or daemon restart, Treeport opens the saved URL in a new empty browser session.

### Understand streamed Browser limits

The streamed Browser in a web client or remote desktop connection does not support these features:

- streamed audio;
- downloads;
- file selection or upload;
- automatic clipboard synchronization between the client and daemon.

The Treeport controls have accessible names and keyboard operation.

The streamed page image does not supply semantic accessibility information.

Use `treeport browser snapshot` when you need the page's semantic accessibility data.

A daemon-local `localhost` URL can fail to open on another computer.

## Use iframe Browser

The `@treeport/web-panel-browser` package supplies iframe Browser.

### Open a detected development server

1. Select **Browser** from the **Web panels** group in **New panel**.
2. Approve the `same-origin` permission.
3. Select a server from **Development servers**.

The page lists TCP ports that Treeport can associate with the current tree.

Enter an HTTP or HTTPS address with or without the protocol. Press Enter to open it.

Treeport uses `http://` when you omit the protocol.

Select **Show development servers** to return to the server list.

Treeport does not select a server automatically. A listed TCP port is not necessarily an HTTP server.

### Open iframe Browser from the CLI

Use the CLI to open or reuse iframe Browser:

```sh
treeport web-panel open --worktree . browser \
  --input '{"url":"http://127.0.0.1:5173","title":"Application"}'
```

The client computer must be able to open the URL. `localhost` identifies the client computer.

Treeport does not proxy the application or change its URL.

A browser can block HTTP content in an HTTPS Treeport page because of mixed-content rules.

### Save and restore the address

iframe Browser saves its current address in panel storage.

If the target uses `@treeport/panel-sdk`, iframe Browser also saves client-side route changes.

Browser security prevents route observation for other cross-origin targets.

Another client uses the saved address when it opens or reloads iframe Browser.

If loading fails, start the application or correct the address. Then, select **Retry**.

Use Browser when the target prevents iframe use.

### Use the panel SDK

The target can call `treeport.panel.setTitle()` to set the web-panel title.

The SDK lets iframe Browser observe the target's current route.

The target cannot use context, diff, network discovery, storage, shortcuts, or workspace navigation.

Add `@treeport/panel-sdk` to the normal target build when you use this integration.
