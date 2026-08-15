---
title: Persistent terminals
description: Run normal terminal programs and reconnect without restarting them.
---

Every terminal created by Treeport runs in a dedicated, application-owned tmux server. The process belongs to the worktree, not to a browser tab.

## Detach without stopping

Closing the desktop app, browser, or terminal view only detaches that client. Coding agents, shells, development servers, editors, and test watchers keep running. Reopen the terminal to attach to the same screen and process.

Treeport tracks the terminal as running or exited and reports an exit code when available. If a command returns to an interactive shell, the terminal remains running because the shell is still alive.

## Reconnect from another device

Open the same terminal from the browser or desktop app. Through the supported Tailscale Serve endpoint, you can also reconnect from a phone using Treeport's responsive web app.

## Browse earlier output

Scrolling up or selecting earlier output keeps that part of the terminal stable while new output continues in the background. Treeport labels this state **Scrolled back in tmux** or **Selection is active** while noting that new output is continuing off-screen. Without a selection, scrolling to the bottom resumes following current output automatically.

With an active selection, Treeport stays scrolled back to preserve its highlight and offers **Clear** instead of **Follow latest**. Clearing the selection resumes live output. Terminal input, paste, clicking the terminal, or beginning a new selection also clears it.

## Shared terminal size

A terminal has one shared size across its attached clients. Treeport resizes it automatically to fit the client you are using, and synchronizes that size with other attachments. Opening or resizing it on a phone can therefore reflow the terminal on a desktop, and vice versa.

:::caution
Remote access grants terminal control. Use only Treeport's authenticated Tailscale Serve workflow, and give access only to users who may control the host; see the [security guidance](/security/).
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
