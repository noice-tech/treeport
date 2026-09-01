---
title: Persistent terminals
description: Run terminal programs and connect again without a restart.
---

Treeport runs each terminal in its detached terminal host. The host owns one PTY and one canonical terminal model for the session. The process belongs to the tree, not to a client or API daemon.

## Disconnect without a stop

When you close a client or terminal view, only that client disconnects.

Coding agents, shells, development servers, editors, and test watchers continue to run. Open the terminal again to connect to the same process.

Treeport reports whether the terminal process runs or has exited. It also reports the exit code when that code is available.

If a command returns to an interactive shell, the terminal continues to run because the shell is active.

## Connect from another device

Open the same terminal from the browser or desktop client.

You can also connect from a phone through the supported Tailscale Serve endpoint.

## Read earlier output

Each browser keeps its own useful terminal scrollback. Earlier output or a selection can stay visible in one browser while new output continues and other viewers remain at their own positions.

See [Shortcuts](/reference/shortcuts/#selection-scrolling-and-clipboard) for scroll, selection, copy, and paste operations.

## Understand the shared terminal size

A terminal has one size for all connected clients. The client that has control sets the row-and-column grid.

Other clients fit that grid into the available area. A change of control between different devices can change the layout for all clients.

See [Shared terminal size](/reference/shortcuts/#shared-terminal-size).

:::caution
Remote access gives terminal control. Use only the authenticated Tailscale Serve workflow. Give access only to users who can control the host.
:::

Read the [security guidance](/security/) before you enable remote access.

## Run standard terminal applications

Treeport transfers terminal input and output. It does not replace the terminal user interface.

Mouse input, keyboard shortcuts, alternate screens, and interactive prompts continue to work as the terminal application expects.

A tree can have multiple named terminals:

```text
investigate-cache
├── agent       Pi
├── dev         pnpm dev
├── tests       pnpm test --watch
└── shell       login shell
```

## Add runtime information

Applications can add information with standard signals:

- **Title**: Short context, such as `PR #123` or `Development server`.
- **BEL**: An important change that requires attention.
- **OSC 9;4 progress**: Active work, a percentage, or a cleared state.
- **Process exit**: Completion and the exit code, when available.

These signals are not necessary for persistence or control. See the [terminal signals reference](/reference/terminal-signals/).

## Keep the terminal host focused

The Treeport-owned terminal host provides persistence, canonical history, reconnect snapshots, and byte-stream fanout. It does not implement windows, panes, layouts, prefix keys, or server-side copy mode.

Browser clients own scrolling, selection, and clipboard behavior.

The [Pi integration](/building-apps/coding-agents/#use-pi) can create persistent terminals for long-running agent tasks.
