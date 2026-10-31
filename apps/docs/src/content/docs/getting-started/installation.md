---
title: Run Treeport
description: Fork Treeport and run it on your machine.
---

[Fork Treeport](https://github.com/noice-tech/treeport/fork) and run it on your machine. It's your copy, so your coding agent can change it too. The server keeps terminals running; connect with a browser or the desktop app.

## Install and start

Use macOS or Linux with Node.js 24+, pnpm, Git, and Rust (the checkout pins its toolchain). Native dependencies may also need your platform's C/C++ build tools and Python.

```sh
gh repo fork noice-tech/treeport --clone && cd treeport
pnpm install --frozen-lockfile && pnpm cli:install && pnpm start
```

`gh repo fork --clone` creates your fork and clones it. Without the GitHub CLI, [fork in the browser](https://github.com/noice-tech/treeport/fork) and `git clone` your fork.

`pnpm start` installs dependencies and builds whatever changed, then runs the server in the foreground. Open **http://127.0.0.1:8733**. Ctrl+C stops the server while preserving running terminal sessions.

For automatic startup, see [service supervision](/features/service-supervision/). For another computer or phone, configure [Tailscale Serve](/features/remote-access/).

## CLI and desktop

`pnpm cli:install` links the `treeport` command into pnpm's global bin, so it follows your clone without reinstalling; `pnpm cli:uninstall` removes it. Terminals managed by Treeport always run the CLI of the server that started them.

`pnpm dev` starts the development server, web UI, and Electron app. To build a local desktop application, run `pnpm --filter @treeport/desktop package`; the result is under `apps/desktop/out`. The desktop app connects to your server and does not bundle it.

There are no prebuilt downloads or automatic updates.

## Updates

```sh
pnpm sync && pm2 restart treeport
```

`pnpm sync` pulls the latest changes and stops if your clone has diverged, so you can merge. Restarting installs and builds whatever changed. Without pm2, rerun `pnpm start`. A fork pulls from its own remote, so sync it with upstream first (GitHub **Sync fork** or `gh repo sync`). Rebuild the desktop app separately if you use it.

## Start working

1. Open or create a tree for your task.
2. Open a terminal and start your [coding agent](/building-apps/coding-agents/).
3. Add a [Browser](/features/browser-app/) to check your work.
4. Use the included review and editor apps, or add [local packages](/features/packages/).
