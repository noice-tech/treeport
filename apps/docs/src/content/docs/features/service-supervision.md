---
title: Service supervision
description: Keep Treeport running under pm2 or another process manager.
---

Treeport runs in the foreground with `pnpm start`. You own startup and supervision; Treeport does not install OS services.

## Optional pm2 setup

Install pm2 separately, then run these commands from your clone:

```sh
pnpm pm2:start
pnpm pm2:save
pnpm pm2:startup
```

Follow the platform-specific instructions printed by `pm2 startup`. Keep the clone at the same path.

- `pm2 status treeport` shows the process.
- `pm2 logs treeport` shows supervisor output.
- `pm2 stop treeport` stops the server.
- `pnpm sync && pm2 restart treeport` updates it; each start installs and builds what changed.

Use your supervisor to start, restart, and stop the server.

## Terminal persistence

Session-keepers run separately from the server. On Linux with an available systemd user manager, each keeper starts in its own transient user scope so stopping or restarting pm2's service does not kill terminals. Without a user manager, Treeport uses detached processes; a supervisor that kills its entire process group or cgroup can then terminate them. macOS keepers use separate sessions.

## Logs

`treeport logs` reads retained server logs, even when the server is stopped. Use `treeport logs --lines 500` for more history.
