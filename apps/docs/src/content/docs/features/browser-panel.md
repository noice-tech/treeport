---
title: Browser panels (experimental)
description: Choose client-side browsing or an isolated browser on the Treeport daemon computer.
---

The `@treeport/web-panel-browser` package supplies two web panels:

- **Browser** loads a site in an iframe on the current client computer.
- **Remote Browser** loads a site in an isolated browser on the Treeport daemon computer.

Use **Browser** when the client computer can reach and embed the site.

Use **Remote Browser** for a daemon-local server, a site that cannot use an iframe, or a shared agent session.

## Use the client-side Browser

### Open a detected development server

1. Select **Browser** from **New panel**.
2. Approve the `same-origin` permission when Treeport requests it.
3. Select a server from **Development servers**.

The page lists listening TCP ports that Treeport can associate with the current tree.

You can also enter an absolute HTTP or HTTPS URL. Press Enter to open it.

Select **Show development servers** to return to the server list. This action does not remove the current address.

After you start or stop a server, select **Refresh servers**.

Treeport does not select a server automatically. A listed TCP port is not necessarily an HTTP server.

### Open a development server from a command

Use the CLI to open or reuse a Browser panel:

```sh
treeport web-panel open --worktree . browser \
  --input '{"url":"http://127.0.0.1:5173","title":"Application"}'
```

The client computer must be able to open the URL.

In a URL, `127.0.0.1` and `localhost` identify the client computer. They do not identify a remote Treeport backend.

Treeport does not proxy the application or change its URL.

A browser can block plain HTTP content in an HTTPS Treeport page. This occurs because of mixed-content rules.

### Save and restore the address

The panel saves the current address in panel storage.

If the target uses `@treeport/panel-sdk`, the Browser panel also saves client-side route changes.

Browser security prevents route observation for a cross-origin target that does not use the SDK.

**Reload** reloads the panel only on the current client. Another client uses the saved address when it opens or reloads the panel.

If loading fails or takes more than 10 seconds, the panel shows **Load failed**.

Start the application or correct the address. Then, select **Retry**.

Select **Open externally** when the target prevents iframe use. You can also use this action to open a separate browser tab.

### Use the panel SDK

The target can call `treeport.panel.setTitle()` to set the panel title.

When the target imports the SDK, the Browser panel can observe its current route. A route-specific SDK call is not necessary.

The target cannot use context, diff, network discovery, storage, shortcuts, or workspace navigation.

If you use the title or route integration, add `@treeport/panel-sdk` to the normal target build.

## Use the Remote Browser

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

On Linux, an error can identify missing operating-system libraries. Install these libraries as an administrator, then run the Treeport command again.

Treeport does not request administrator access.

### Open a development server

1. Select **Remote Browser** from **New panel**.
2. Approve the `host-browser` permission when Treeport requests it.
3. Select a server from **Development servers**, or enter an HTTP or HTTPS URL.

Remote Browser requests come from the daemon computer. In a URL, `127.0.0.1` and `localhost` identify that computer.

Use the address bar, **Back**, **Forward**, and **Reload** to control the page.

You can use pointer, keyboard, and scroll input in the remote browser viewport.

Treeport observes top-level route changes without changes to the target application.

The browser session stays active when you change workspaces, reload the client, or disconnect.

Another connected client can observe the same session and take control.

Select **Reset remote browser** to delete its cookies, local storage, cache, and history.

After a daemon restart, Treeport opens the saved address in a new empty session.

### Control the Remote Browser from an agent

Use these commands to inspect and control an open Remote Browser panel:

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

Without `--panel`, Treeport uses the only Remote Browser panel in the current tree.

If multiple panels are open, add `--panel <panel-id>`.

Snapshot references, such as `e12`, identify elements in the shared page. Agent actions are visible in the panel.

Use the CLI to open or reuse a Remote Browser panel:

```sh
treeport web-panel open --worktree . remote-browser \
  --input '{"url":"http://127.0.0.1:5173","title":"Application"}'
```

Before you use this command, approve the `host-browser` permission in the Treeport UI.

### Understand isolation and limits

Each Remote Browser panel uses separate temporary browser storage. Treeport does not use or attach to a personal browser profile.

Closing the panel removes its temporary browser data.

Remote Browser does not support these features:

- streamed audio;
- downloads;
- file selection or upload;
- popup windows;
- automatic clipboard synchronization between the client and daemon.

A copied address uses the daemon-visible URL. A daemon-local `localhost` URL might not open on another computer.
