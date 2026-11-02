---
title: Always on
description: Keep Treeport running without opening the app, with pm2.
---

The Mac app starts Treeport when you open it. Use pm2 when Treeport should run without anyone opening the app: on a server, at boot, and after a crash. Treeport does not install OS services.

## Set up pm2

pm2 comes with your clone. Run these commands from your clone:

```sh
pnpm pm2:start
pnpm pm2:save
pnpm pm2:startup
```

Follow the platform-specific instructions printed by `pnpm pm2:startup`. Keep the clone at the same path.

- `pnpm pm2 status treeport` shows the process.
- `pnpm pm2 logs treeport` shows supervisor output.
- `pnpm pm2 stop treeport` stops the server.
- `treeport update` updates and restarts it, and leaves it running if the update fails.

Use your supervisor to start, restart, and stop the server.

## Terminal persistence

Session-keepers run separately from the server. On Linux with an available systemd user manager, each keeper starts in its own transient user scope so stopping or restarting pm2's service does not kill terminals. Without a user manager, Treeport uses detached processes; a supervisor that kills its entire process group or cgroup can then terminate them. macOS keepers use separate sessions.

## Logs

`treeport logs` reads retained server logs, even when the server is stopped. Use `treeport logs --lines 500` for more history.
