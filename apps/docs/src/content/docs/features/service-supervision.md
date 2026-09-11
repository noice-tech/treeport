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
