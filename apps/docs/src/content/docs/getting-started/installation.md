---
title: Run Treeport from source
description: Fork or clone Treeport, build it, and run your own server.
---

Treeport is distributed as source. Fork [the repository](https://github.com/noice-tech/treeport) and build it with your coding agent. The server keeps terminals running; connect with a browser or the desktop app.

## Build and start

Use macOS or Linux with Node.js 24+, pnpm, Git, and Rust (the checkout pins its toolchain). Native dependencies may also need your platform's C/C++ build tools and Python.

```sh
git clone https://github.com/YOUR-USERNAME/treeport.git
cd treeport
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open **http://127.0.0.1:8733**. `pnpm start` runs in the foreground; Ctrl+C stops the server while preserving running terminal sessions.

For automatic startup, see [service supervision](/features/service-supervision/). For another computer or phone, configure [Tailscale Serve](/features/remote-access/).

## CLI and desktop

From the clone, run `pnpm exec treeport context` or `pnpm exec treeport /path/to/project`. For use outside the clone, add its `apps/treeport/bin` directory to your shell's PATH. Managed terminals receive the CLI path automatically.

`pnpm dev` starts the development server, web UI, and Electron app. To build a local desktop application, run `pnpm --filter @treeport/desktop package`; the result is under `apps/desktop/out`. The desktop app connects to your server and does not bundle it.

There are no prebuilt downloads or automatic updates.

## Updates

From your clone:

```sh
git pull
pnpm install --frozen-lockfile
pnpm build
```

Restart the foreground server with `pnpm start`. If you use the pm2 setup, `pnpm restart` installs dependencies, rebuilds, and restarts its `treeport` process. Rebuild the desktop app separately if you use it.

## Start working

1. Open or create a tree for your task.
2. Open a terminal and start your [coding agent](/building-apps/coding-agents/).
3. Add a [Browser](/features/browser-app/) to check your work.
4. Use the included review and editor apps, or add [local packages](/features/packages/).
