---
title: Install Treeport
description: Install and run Treeport with curl or npm.
---

Treeport currently supports macOS. It requires Git and tmux 3.2 or newer.

## Install with curl

The recommended installer provides a private Node.js runtime and installs the Treeport npm package without changing an existing Node installation:

```sh
curl -fsSL https://treeport.app/install.sh | sh
```

If tmux is unavailable and Homebrew is installed, the installer offers to run `brew install tmux`. It does not install Homebrew. If Git is unavailable, install the Xcode Command Line Tools and rerun the installer.

Add `~/.local/bin` to `PATH` if requested, then start Treeport:

```sh
treeport up
```

Treeport starts in the background and prints:

```text
Treeport is up
http://127.0.0.1:8733
```

Run `treeport open` when you want Treeport to open the browser.

Rerun the same curl command to install a newer version. The installer preserves whether the local daemon was running.

## Install with npm

If Node.js 24 or newer is already installed:

```sh
npm install --global @treeport/treeport
treeport up
```

For upgrades, stop Treeport while npm replaces package files:

```sh
treeport down
npm install --global @treeport/treeport@latest
treeport up
```

## Check the installation

```sh
treeport status
treeport doctor
treeport version
```

`treeport down` stops the daemon but preserves persistent tmux sessions. A later `treeport up` reconnects them.

## Uninstall

A curl-managed installation can be removed while preserving application data:

```sh
curl -fsSL https://treeport.app/uninstall.sh | sh
```

To terminate every terminal and remove application data as well:

```sh
curl -fsSL https://treeport.app/uninstall.sh | TREEPORT_PURGE=1 sh
```

For npm installations:

```sh
treeport down
npm uninstall --global @treeport/treeport
```

npm uninstall preserves application data by default.

:::caution
Treeport provides terminal access and does not include authentication. Keep it on loopback unless you deliberately configure a trusted private-network address. Never expose it directly to the public internet.
:::
