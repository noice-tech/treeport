---
title: Service supervision
description: Start Treeport automatically and restart it after an unexpected exit.
---

Service mode is optional. It starts Treeport automatically and restarts the backend after an unexpected exit.

## Enable service mode

```sh
treeport service enable
```

- **macOS:** Starts after login without administrator approval.
- **Linux:** Uses a systemd user service. Follow the printed instructions for startup without login.

For macOS startup before login, use `treeport service enable --headless`. This mode requires administrator approval.

## Manage the service

- `treeport service status` shows its status.
- `treeport start` starts the backend.
- `treeport stop` stops the backend while keeping terminal sessions.
- `treeport service disable` removes automatic startup.

Disable service mode before uninstalling Treeport.

## Check the logs

If the backend stops or does not respond, run this command:

```sh
treeport logs
```

This command also works when the backend is stopped. The logs include start and stop events, error details, the software version, and backend output. Treeport keeps a limited log history after a restart.

To read more lines, use `treeport logs --lines 500`.

For service-manager logs, run this command:

```sh
treeport logs --service
```

A forced stop or a loss of power can prevent an exit event. Without this event, the cause of the stop can be unknown.
