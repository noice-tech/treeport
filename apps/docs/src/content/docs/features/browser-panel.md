---
title: Browser primitive (experimental)
description: Open and control a web page in a built-in Treeport panel.
---

The Browser primitive is a built-in tool. It opens one top-level web page for a tree.

Each browser panel has one address bar, one page, and one live browser runtime.

Treeport shows Browser panels in the tree's side panel. On desktop, the terminal stays visible beside this panel.

## Understand the browser runtime

Each browser panel has one authoritative runtime.

A local desktop connection can open the page in an Electron `<webview>`.

Web and remote desktop clients stream this Electron page while its desktop connection stays open.

If no local desktop owns the page, Playwright controls Chromium on the daemon computer.

The toolbar and `treeport browser` commands control the same live page.

Treeport does not synchronize two browser pages.

For an Electron runtime, page requests come from the desktop computer.

For a Playwright runtime, page requests come from the daemon computer.

Thus, `localhost` identifies the computer that runs the authoritative runtime.

## Install Chromium for remote use

A web or remote desktop client requires managed Chromium when no local Electron runtime is active.

An active local Electron runtime does not require managed Chromium.

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
3. Enter search terms or an HTTP or HTTPS address in the address bar.
4. Press Enter.

You can also select **Browser** from **New panel**.

Treeport sends search terms to Google Search.

You can omit the protocol. Treeport adds `http://` when necessary.

To open a detected development server, select **Development servers** on the right of the address bar.

The page is not in an iframe. Sites that block iframe use can open in the browser panel.

Use **Back**, **Forward**, **Reload**, and the address bar to control the page.

If the page cannot load, Treeport shows the network error code.

Correct the address or start the target. Then, select **Reload**.

Use pointer, keyboard, and scroll input in the page.

Press `Command+F` on macOS or `Ctrl+F` on Linux to find text in the page.

On a local desktop, right-click the page to open the browser context menu.

Use this menu to open links in new Browser tabs, copy link addresses, and edit text.

When a page opens a popup, Treeport opens a new browser panel in the same tree.

On a touch screen, tap an HTTP or HTTPS terminal link to open it in that terminal's tree.

With a mouse, modifier-click the link.

If a Browser panel has the exact URL in that tree, Treeport selects it instead of opening another panel.

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

A remote client keeps the Electron page history, session storage, form input, and live page state.

This continuity requires the local desktop connection to stay open.

If that connection closes, Treeport can start a daemon runtime from the saved URL.

This runtime change does not keep tab-specific state.

## Understand remote limits

A browser panel in a web or remote desktop client does not support these features:

- streamed audio;
- downloads;
- file selection or upload;
- automatic clipboard synchronization with the daemon computer.

The Treeport controls have accessible names and keyboard operation.

The streamed page image does not include semantic accessibility information.

Use `treeport browser snapshot` to read the page's semantic accessibility data.

The [Pi integration](/building-apps/coding-agents/#use-pi) lets Pi control the current tree's visible browser tab.
