---
title: Browser primitive (experimental)
description: Open and control a web page in a built-in Treeport panel.
---

The Browser primitive is a built-in tool. It opens one top-level web page for a tree.

Each browser panel has one address bar, one page, and one live browser runtime.

Treeport shows Browser panels in the tree's side panel. On desktop, the terminal stays visible beside this panel.

## Understand the browser runtime

Treeport selects the runtime from your connection:

- For a local desktop connection, Electron renders the page in a `<webview>`.
- For a web or remote desktop connection, Playwright controls Chromium on the daemon computer.

Treeport streams the Playwright page to the web or remote desktop client.

The toolbar and `treeport browser` commands control the same live page. Treeport does not synchronize two browser pages.

For a local desktop connection, page requests come from the desktop computer.

For other connections, page requests come from the daemon computer.

Thus, `localhost` identifies the computer that runs the browser runtime.

## Install Chromium for remote use

A web client or remote desktop client requires managed Chromium on the daemon computer.

The local Electron `<webview>` does not require managed Chromium.

If Chromium is not available, select **Install Chromium** on the **Browser unavailable** page.

Treeport downloads the compatible Chromium build. The browser panel opens again when the installation is complete.

To install Chromium before you open a browser panel, use this command:

```sh
treeport browser install
```

Check or remove the installation:

```sh
treeport browser status
treeport browser remove
```

On Linux, an installation error can identify missing operating-system libraries.

Install these libraries as an administrator. Then, run the Treeport command again.

Treeport does not request administrator access.

## Open a page

1. Select the side panel button.
2. Select **Browser** in the empty panel or the `+` menu.
3. Enter an HTTP or HTTPS address in the address bar.
4. Press Enter.

You can also select **Browser** from **New panel**.

You can omit the protocol. Treeport adds `http://` when necessary.

To open a detected development server, select **Development servers** on the right of the address bar.

The page is not in an iframe. Sites that block iframe use can open in the browser panel.

Use **Back**, **Forward**, **Reload**, and the address bar to control the page.

If the page cannot load, Treeport shows the network error code.

Correct the address or start the target. Then, select **Reload**.

Use pointer, keyboard, and scroll input in the page.

When a page opens a popup, Treeport opens a new browser panel in the same tree.

On a touch screen, tap an HTTP or HTTPS terminal link to open it in that terminal's tree.

With a mouse, modifier-click the link.

## Open a browser panel from the CLI

Open a blank browser panel:

```sh
treeport browser open --worktree .
```

Open a browser panel with a URL:

```sh
treeport browser open http://127.0.0.1:5173 --worktree .
```

The server accepts only HTTP and HTTPS URLs without credentials.

From a visible managed terminal, this command reveals the new Browser in the side panel. The terminal keeps keyboard focus.

## Control a browser panel from an agent

Use these commands to inspect and control the current page:

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

Without `--panel`, Treeport selects the only browser panel in the current tree.

If multiple browser panels are open, add `--panel <panel-id>`.

A snapshot reference, such as `e12`, identifies an element in the current live runtime.

Take a new snapshot after navigation or a runtime change.

For a local desktop connection, commands control the live Electron `<webview>` page.

Commands continue while you select another Treeport workspace. Treeport does not select the Browser panel during background control.

For other connections, commands control the streamed Playwright page.

## Close a browser panel

Close a Browser tab in the side panel. Hiding the side panel does not close its Browser tabs.

Treeport runs the site's page-close handlers. If the site uses `beforeunload`, Treeport asks you before it closes.

Browser panels use shared browser data like tabs in one browser.

Cookies, local storage, and login state are available to other browser panels on the same browser host.

Treeport keeps this data when you close a panel or restart Treeport.

Treeport also keeps this data when it replaces the managed browser runtime.

Treeport does not use, import, or attach to a personal browser profile.

Treeport saves each panel's current URL and title. It restores the URL when it creates a new runtime.

A closed panel does not keep tab-specific state such as history, session storage, form input, or snapshot references.

The desktop runtime and the daemon runtime keep separate app-owned profiles. They do not copy browser data between computers.

A web client cannot stream a page that a local Electron `<webview>` owns.

## Understand remote limits

A browser panel in a web or remote desktop client does not support these features:

- streamed audio;
- downloads;
- file selection or upload;
- automatic clipboard synchronization with the daemon computer.

The Treeport controls have accessible names and keyboard operation.

The streamed page image does not include semantic accessibility information.

Use `treeport browser snapshot` to read the page's semantic accessibility data.
