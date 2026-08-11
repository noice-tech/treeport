---
title: Browser panel (experimental)
description: Open an application's development server in a Treeport workspace.
---

The `@treeport/web-panel-browser` package provides the **Browser** panel. It is mainly useful when you develop an application and want to open its development server beside your terminal. Select **Browser** from **New panel**, enter an absolute HTTP or HTTPS URL, and press Enter.

## Open a development server from an agent

Treeport does not yet have a complete skill workflow that starts a development server and opens its Browser panel. This integration is a TODO. Until it is available, an agent can start the server and open or reuse the Browser panel with the CLI:

```sh
treeport web-panel open --worktree . browser \
  --input '{"url":"http://127.0.0.1:5173","title":"Application"}'
```

The URL must be reachable from the computer that runs the browser. A loopback address such as `127.0.0.1` refers to that computer. It does not refer to a remote Treeport daemon. Treeport does not proxy the application or change its URL.

The panel saves the current address in its panel storage. **Reload** affects only the current client. Another client uses the saved address when it later opens or reloads the panel.

If the connection fails or takes more than 10 seconds, the panel shows **Load failed**. Start the application or correct the address, then select **Retry**. Use **Open externally** if you want to open the address in a separate browser tab.

A target application can use `treeport.panel.setTitle()` to set the panel title. It cannot use context, diff, storage, shortcuts, or workspace navigation. Add `@treeport/panel-sdk` to the target application's normal build if it uses the title method.
