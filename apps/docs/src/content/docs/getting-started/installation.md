---
title: Install Treeport
description: Build and run Treeport from source.
---

Treeport is currently installed from source.

## Requirements

- Node.js 22 or newer
- [pnpm](https://pnpm.io/) 11
- Git
- tmux 3.2 or newer
- Optional: the GitHub CLI (`gh`) for pull-request status

## Build

Clone the repository, install dependencies, and build all packages:

```sh
git clone https://github.com/noice-tech/treeport.git
cd treeport
pnpm install
pnpm build
```

Install the CLI globally from the built workspace package:

```sh
pnpm --global add ./packages/cli
```

Confirm that it is available:

```sh
treeport context
```

Outside a Treeport-managed terminal, this prints `Not running in a Treeport-managed terminal.` That is expected.

## Start locally

Start the daemon on the loopback interface:

```sh
pnpm start:local
```

Then open [http://127.0.0.1:4780](http://127.0.0.1:4780).

:::caution
Treeport provides arbitrary terminal access and does not currently include authentication. Keep the daemon on loopback unless you have configured a trusted private network. Never expose it directly to the public internet.
:::

## Development mode

To run the server, web app, and desktop companion from source with live reload:

```sh
pnpm dev
```

The command prints the selected local web and API URLs. It automatically chooses the next free ports when another checkout is already running.

Continue with [your first workspace](/getting-started/first-workspace/).
