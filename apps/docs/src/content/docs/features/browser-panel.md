---
title: Browser panels (experimental)
description: Choose client-side iframe browsing or an isolated browser on the Treeport daemon host.
---

The `@treeport/web-panel-browser` package provides two different web panels:

- **Browser** loads a site in an iframe in your current Treeport client. It uses the client computer's network location and browser storage.
- **Remote Browser** runs a disposable Chromium process on the Treeport daemon host and streams the page into your workspace. It uses the daemon computer's network location and separate temporary storage.

Use **Browser** for sites that the current client can reach and embed. Use **Remote Browser** when you must reach a development server on the daemon host, when the site cannot run correctly in an iframe, or when an agent must inspect the same page.

## Use the client-side Browser

Select **Browser** from **New panel**. Treeport asks for the `same-origin` permission on the first open. This permission lets the panel use the client browser's normal same-origin storage and load the target in a nested iframe.

When the panel has no saved address, its **Development servers** homepage lists listening TCP ports that Treeport can conservatively attribute to the current worktree. Select a server, or enter an absolute HTTP or HTTPS URL. Use **Show development servers** to return to the homepage without forgetting the current address. **Refresh servers** scans again after you start or stop a server. A listed TCP listener is not guaranteed to speak HTTP.

The target loads in your current Treeport client. Therefore, `localhost` identifies the client computer, not necessarily the daemon host. Treeport does not proxy the application or change its URL. An HTTPS Treeport page might also reject a plain HTTP target because of browser mixed-content rules. The target must permit iframe embedding.

The panel saves its current address in panel storage. A target that includes `@treeport/panel-sdk` can report its runtime title and History API location to the Browser panel. Without this cooperation, the panel cannot observe every client-side route change in a cross-origin iframe. Another Treeport client uses the saved address when it opens or reloads the panel.

If the connection fails or takes more than 10 seconds, the panel shows **Load failed**. Start the application or correct the address, then select **Retry**. Use **Open application externally** when the application blocks iframe embedding or when you want a separate browser tab.

## Install the Remote Browser

Install Treeport's Playwright-compatible Chromium build once:

```sh
treeport browser install
```

Check or remove the installation with:

```sh
treeport browser status
treeport browser remove
```

On Linux, the status or installation error identifies missing operating-system libraries. Install those libraries explicitly as an administrator, then run the Treeport command again. The Treeport daemon does not request elevated access.

## Use the Remote Browser

Select **Remote Browser** from **New panel**. The first open asks you to allow host-browser access. This permission lets the isolated browser reach localhost, local-network services, and internet sites that are available from the daemon host.

The development-server homepage and address field work as they do in Browser, but all page requests come from the daemon host. The address bar, Back, Forward, Reload, pointer input, keyboard input, and scrolling control the remote browser. Treeport reads top-level navigation state directly from Chromium, so History API routes do not require target-application changes.

The remote browser session remains alive when you switch workspaces, reload the Treeport client, or disconnect. Another connected Treeport client can observe the same session and take control. **Reset remote browser** closes the session and deletes its cookies, local storage, cache, and history.

Remote Browser state is not restored after a daemon restart. Treeport saves the last address and opens it in a new empty session.

## Use the Remote Browser from an agent

A coding agent in the worktree can inspect and control an open Remote Browser panel:

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

Commands use the only Remote Browser panel in the current worktree. Add `--panel <panel-id>` when more than one Remote Browser panel is open. Snapshot references such as `e12` identify elements in the shared page. Agent actions temporarily take control and are visible in the panel.

An agent can start a development server and open or reuse the panel before inspection:

```sh
treeport web-panel open --worktree . remote-browser \
  --input '{"url":"http://127.0.0.1:5173","title":"Application"}'
```

The `host-browser` permission must already be approved in the Treeport UI before the CLI can create a Remote Browser panel.

## Remote Browser isolation and limits

Each Remote Browser panel uses a separate Chromium process and an empty Treeport-owned browser context. Treeport never uses or attaches to your personal browser profile. Closing the panel removes the temporary browser data.

The first version does not support:

- streamed audio;
- downloads;
- file pickers or uploads;
- popup windows;
- automatic host/client clipboard synchronization.

Copying the address copies the daemon-visible URL. A daemon-local `localhost` URL might not open directly in a browser on another computer.
