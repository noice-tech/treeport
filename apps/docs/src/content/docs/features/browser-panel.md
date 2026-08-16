---
title: Browser panel (experimental)
description: Open an application development server in a Treeport workspace.
---

The `@treeport/web-panel-browser` package supplies the **Browser** panel.

Use this panel to open an application development server next to its worktree terminal.

## Open a detected development server

1. Select **Browser** from **New panel**.
2. Select a server from **Development servers**.

The page lists listening TCP ports that Treeport can associate with the current worktree.

You can also enter an absolute HTTP or HTTPS URL. Press Enter to open it.

Select **Show development servers** to return to the server list. This action does not remove the current address.

After you start or stop a server, select **Refresh servers**.

Treeport does not select a server automatically. A listed TCP port is not necessarily an HTTP server.

## Open a development server from a command

Use the CLI to open or reuse a Browser panel:

```sh
treeport web-panel open --worktree . browser \
  --input '{"url":"http://127.0.0.1:5173","title":"Application"}'
```

The client computer must be able to open the URL.

In a URL, `127.0.0.1` and `localhost` identify the client computer. They do not identify a remote Treeport backend.

Treeport does not proxy the application or change its URL.

A browser can block plain HTTP content in an HTTPS Treeport page. This occurs because of mixed-content rules.

## Save and restore the address

The panel saves the current address in panel storage.

If the target uses `@treeport/panel-sdk`, the Browser panel also saves client-side route changes.

Browser security prevents route observation for a cross-origin target that does not use the SDK.

**Reload** reloads the panel only on the current client. Another client uses the saved address when it opens or reloads the panel.

If loading fails or takes more than 10 seconds, the panel shows **Load failed**.

Start the application or correct the address. Then, select **Retry**.

Select **Open externally** when the target prevents iframe use. You can also use this action to open a separate browser tab.

## Use the panel SDK

The target can call `treeport.panel.setTitle()` to set the panel title.

When the target imports the SDK, the Browser panel can observe its current route. A route-specific SDK call is not necessary.

The target cannot use context, diff, network discovery, storage, shortcuts, or workspace navigation.

If you use the title or route integration, add `@treeport/panel-sdk` to the normal target build.
