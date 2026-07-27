---
title: Web, mobile, and desktop
description: Attach to the same Treeport workspaces from multiple interfaces.
---

Treeport's desktop companion, browser UI, and responsive PWA all connect to the same daemon and terminal sessions.

## Browser

The web interface provides the full repository, worktree, and terminal hierarchy. Select any terminal to attach to it. Switching to another workspace does not stop the previous process.

## Mobile and PWA

The responsive web app can be installed as a PWA. Use it to check an agent, respond to a prompt, inspect terminal attention, or control a development process from another device on your trusted network.

Mobile controls provide terminal selection and paste actions without replacing the underlying TUI.

## Desktop companion

The Electron companion wraps the same Treeport web interface and server. Its navigation follows familiar tabbed-application shortcuts:

| Action         | macOS     | Windows / Linux |
| -------------- | --------- | --------------- |
| New worktree   | `⌘N`      | `Ctrl+N`        |
| New terminal   | `⌘T`      | `Ctrl+T`        |
| Close terminal | `⌘W`      | `Ctrl+W`        |
| Switch project | `⌘⇧P`     | `Ctrl+Shift+P`  |
| Terminal 1–9   | `⌘1`–`⌘9` | —               |

## Shared state

All clients observe the same terminals and runtime metadata. A BEL attention signal remains unread until the corresponding terminal is viewed, and acknowledgement is synchronized between connected clients.

:::caution
Remote access grants terminal control. Treeport currently has no authentication. Follow the [private-network guide](/guides/private-network-access/) and [security guidance](/security/).
:::
