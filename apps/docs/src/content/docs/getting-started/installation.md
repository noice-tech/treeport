---
title: Install Treeport
description: Fork Treeport, open it, and keep it up to date.
---

Treeport runs from your own fork, so you and your coding agent can [change it](/getting-started/change-treeport/). You need macOS or Linux with Node.js 24+, pnpm, and Git.

## Install

```sh
gh repo fork noice-tech/treeport --clone && cd treeport
pnpm install && pnpm cli:install
```

Without the GitHub CLI, [fork in the browser](https://github.com/noice-tech/treeport/fork) and `git clone` your fork. `pnpm cli:install` adds the `treeport` command.

## Open

On a Mac, install the app:

```sh
pnpm app:install
```

Open Treeport from Launchpad or Spotlight and choose **Run Treeport on this Mac**. The first start takes a few minutes. After that, the app starts Treeport whenever it isn't running, and quitting the app leaves your terminals running.

Without the app, run `pnpm start` and open **http://127.0.0.1:8733**.

To control Treeport on another computer, such as a Linux server, set it up there with [Always on](/features/service-supervision/) and [Remote access](/features/remote-access/), then choose **Connect to another computer** in the app.

## Update

```sh
treeport update
```

Or choose **Update Treeport…** in the app's Treeport menu. Treeport pulls your fork, rebuilds, and restarts; if anything fails, the running Treeport stays as it was. Use **Sync fork** on GitHub first to get upstream changes.

## Start working

1. Open or create a tree for your task.
2. Open a terminal and start your [coding agent](/building-apps/coding-agents/).
3. Add a [Browser](/features/browser-app/) to check your work.
4. Use the included review and editor apps, or add [local packages](/features/packages/).

## Troubleshooting

- **The app can't find node or pnpm:** the app starts Treeport through your login shell, so both must work in a new terminal window.
- **Rust:** only needed when no prebuilt session keeper matches your platform; the build tells you if so.
