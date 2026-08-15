---
title: Persistent terminals
description: Run normal terminal programs and reconnect without restarting them.
---

Every terminal created by Treeport runs in a dedicated, application-owned tmux server. The process belongs to the worktree, not to a browser tab.

## Detach without stopping

Closing the desktop app, browser, or terminal view only detaches that client. Coding agents, shells, development servers, editors, and test watchers keep running. Reopen the terminal to attach to the same screen and process.

Treeport tracks the terminal as running or exited and reports an exit code when available. If a command returns to an interactive shell, the terminal remains running because the shell is still alive.

## Reconnect from another device

Open the same terminal from the browser or desktop app. On a trusted private network, you can also reconnect from a phone using Treeport's responsive web app.

## Browse earlier output

Treeport uses tmux history, so you can keep earlier output or a selection visible while new output continues. See [Shortcuts](/reference/shortcuts/#selection-scrolling-and-clipboard) for scrolling, selection, copy, and paste interactions.

## Shared terminal size

A terminal has one shared size across its attached clients. The controlling client sets the row-and-column grid, while viewers adapt that grid to their available space. Taking control from a differently sized device can reflow the terminal for all attachments. See [Shared terminal size](/reference/shortcuts/#shared-terminal-size).

:::caution
Remote access grants terminal control. Treeport currently has no authentication. Use it only on a trusted private network; see the [security guidance](/security/).
:::

## Normal terminal applications

Treeport transports terminal input and output without replacing the application's TUI. Mouse input, keyboard shortcuts, alternate screens, and interactive prompts continue to work as terminal applications expect.

A worktree can have multiple named terminals, for example:

```text
investigate-cache
├── agent       Pi
├── dev         pnpm dev
├── tests       pnpm test --watch
└── shell       login shell
```

## Runtime awareness

Applications can progressively enrich their terminal with standard signals:

- **Title** — short semantic context such as `PR #123` or `Development server`.
- **BEL** — a meaningful transition that needs attention.
- **OSC 9;4 progress** — active work, an optional percentage, or a cleared state.
- **Process exit** — completion and exit code where available.

None of these signals is needed for persistence or control. See the [terminal signals reference](/reference/terminal-signals/).

## Dedicated tmux ownership

Treeport does not expose a nested tmux workspace as its product navigation. It uses tmux as a durable terminal runtime while presenting repositories, worktrees, and named terminal tabs in its own interface. Your personal tmux server and configuration remain separate.
