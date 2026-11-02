---
title: Run Treeport
description: Fork Treeport and run it on your machine.
---

[Fork Treeport](https://github.com/noice-tech/treeport/fork) and run it on your machine. It's your copy, so your coding agent can change it too. The server keeps terminals running; use the desktop app or a browser.

## Install and start

Use macOS or Linux with Node.js 24+, pnpm, Git, and Rust (the checkout pins its toolchain). Native dependencies may also need your platform's C/C++ build tools and Python.

```sh
gh repo fork noice-tech/treeport --clone && cd treeport
pnpm install --frozen-lockfile && pnpm cli:install
```

`gh repo fork --clone` creates your fork and clones it. Without the GitHub CLI, [fork in the browser](https://github.com/noice-tech/treeport/fork) and `git clone` your fork.

### Desktop app

```sh
pnpm app:install
```

This builds the desktop app from your clone and installs it in `/Applications` on macOS. Open Treeport like any other app. The first time, choose **Run Treeport on this Mac**, or connect to a server on another computer through [remote access](/features/remote-access/). After you choose this Mac, the app builds and starts the server from the clone it was built from whenever it isn't running; the first start takes a few minutes. Quitting the app leaves the server and your terminals running. **Stop Server…** and **Show Server Logs** are in the Treeport menu.

The app starts the server through your login shell, so `node` and `pnpm` must work in a new terminal window.

### Browser only

```sh
pnpm start
```

`pnpm start` installs dependencies and builds whatever changed, then runs the server in the foreground. Open **http://127.0.0.1:8733**. Ctrl+C stops the server while preserving running terminal sessions.

For automatic startup, see [service supervision](/features/service-supervision/). For another computer or phone, configure [Tailscale Serve](/features/remote-access/).

## CLI and desktop

`pnpm cli:install` links the `treeport` command into pnpm's global bin, so it follows your clone without reinstalling; `pnpm cli:uninstall` removes it. Terminals managed by Treeport always run the CLI of the server that started them.

`pnpm dev` starts the development server, web UI, and Electron app. The desktop app runs the server from your clone and does not bundle it. If the server is already running under pm2 or `pnpm start`, the app connects to it and leaves it alone.

There are no prebuilt downloads or automatic updates.

## Updates

```sh
pnpm sync
```

`pnpm sync` pulls the latest changes, installs dependencies, rebuilds what changed, and restarts the server: through pm2, or by stopping a server the desktop app started so the app starts it again. After `pnpm start`, restart it yourself. If your clone has diverged or the build fails, it stops and leaves the running server untouched. A fork pulls from its own remote, so sync it with upstream first (GitHub **Sync fork** or `gh repo sync`). Run `pnpm app:install` again when the desktop app itself changes.

## Start working

1. Open or create a tree for your task.
2. Open a terminal and start your [coding agent](/building-apps/coding-agents/).
3. Add a [Browser](/features/browser-app/) to check your work.
4. Use the included review and editor apps, or add [local packages](/features/packages/).
