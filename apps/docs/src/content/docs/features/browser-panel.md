---
title: Browser panel (experimental)
description: Discover and open an application's development server in a Treeport workspace.
---

The `@treeport/web-panel-browser` package provides the **Browser** panel. It is mainly useful when you develop an application and want to open its development server beside your terminal.

Select **Browser** from **New panel**. When the panel has no saved address, its **Development servers** homepage lists listening TCP ports that Treeport can conservatively attribute to the current worktree. Select a server to open its HTTP address, or enter an absolute HTTP or HTTPS URL in the address field and press Enter.

Use **Show development servers** in the toolbar to return to the homepage without forgetting the current address. **Refresh servers** scans again after you start or stop a server. Treeport does not automatically select a result, and a listed TCP listener is not guaranteed to speak HTTP.

## Open a development server from an agent

Treeport does not yet have a complete skill workflow that starts a development server and opens its Browser panel. This integration is a TODO. Until it is available, an agent can start the server and open or reuse the Browser panel with the CLI:

```sh
treeport web-panel open --worktree . browser \
  --input '{"url":"http://127.0.0.1:5173","title":"Application"}'
```

The URL must be reachable from the computer that runs the browser. A loopback address such as `127.0.0.1` or `localhost` refers to that computer. It does not refer to a remote Treeport daemon. Treeport does not proxy the application or change its URL. An HTTPS Treeport page may also be unable to embed a plain HTTP server because of browser mixed-content rules.

The panel saves the current address in its panel storage. **Reload** affects only the current client. Another client uses the saved address when it later opens or reloads the panel.

If the connection fails or takes more than 10 seconds, the panel shows **Load failed**. Start the application or correct the address, then select **Retry**. Use **Open externally** if the application blocks iframe embedding or you want to open the address in a separate browser tab.

A target application can use `treeport.panel.setTitle()` to set the panel title. It cannot use context, diff, network discovery, storage, shortcuts, or workspace navigation. Add `@treeport/panel-sdk` to the target application's normal build if it uses the title method.
