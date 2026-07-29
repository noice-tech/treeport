---
title: Install Treeport
description: Install and run Treeport with curl or npm.
---

## Requirements

- Node.js 24 or newer
- Git
- tmux 3.2 or newer

## Install with curl

```sh
curl -fsSL https://treeport.app/install.sh | sh
```

Restart your shell if the installer asks you to, then start Treeport:

```sh
treeport
```

## Install with npm

```sh
npm install --global @treeport/cli
treeport
```

:::caution
Treeport provides terminal access and does not include authentication. Keep it on loopback unless you have configured a trusted private network. Never expose it directly to the public internet.
:::
