---
title: Install Treeport
description: Install Treeport and open your first project.
---

Requires macOS or Linux, Node.js 24+, npm, and Git.

## Backend

```sh
npm install --global @treeport/treeport
treeport /path/to/project
```

Treeport starts the backend and opens your project in the desktop client or browser.

## macOS app

Download the DMG from the [latest release](https://github.com/noice-tech/treeport/releases/latest).
Drag **Treeport** to Applications, then open it.

Requires macOS 12+ on Apple Silicon or Intel. Install the backend separately with the command above.

For another computer, use [Remote access](/features/remote-access/).

## Updates

Run `treeport update` for the backend. The macOS app offers its own updates.

If an update fails, reinstall the latest release.
