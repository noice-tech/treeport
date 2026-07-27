---
title: Terminal signals
description: Publish titles, attention, and progress through standard terminal protocols.
---

Treeport preserves and controls terminal applications without any integration. Applications can optionally publish semantic state through standard terminal signals.

## Capability levels

### Process lifecycle

Every Treeport terminal provides persistent execution, running or exited status, an exit code where available, terminal rendering and input, and reconnection. No application integration is required.

### Terminal title

Interactive zsh, Bash, and fish sessions capture the command entered at the shell execution boundary. This lets Treeport display `pnpm dev` while the foreground process visible to tmux is only `node`. The captured value can include arguments, is limited to 256 characters, and is cleared when the prompt returns.

Treeport preserves the user's shell startup files while installing these hooks. Nushell retains its native title behavior. Unsupported shells, non-interactive invocations, and Bash configurations that replace Treeport's one-time prompt bootstrap fall back to the foreground executable name because the original command cannot be reconstructed reliably from a process tree.

Applications can publish a more useful title with OSC `0` or `2`; a fresh application title takes priority over the shell-captured command.

```sh
printf '\033]2;Waiting for review\007'
```

Keep titles concise. Useful examples include `Implementing authentication`, `PR #123`, `PR MERGED`, and `Development server`.

Application titles are runtime metadata and may be reset after the daemon or observer restarts. Shell-captured commands are also stored as pane-scoped tmux metadata while they run, allowing Treeport to recover the command after an observer restart.

### BEL attention

Emit a real BEL when a meaningful transition needs attention:

```sh
printf '\007'
```

Suitable uses include waiting for input, completion of a long-running operation, failed checks, or required approval. Treeport synchronizes unread attention between connected clients. BEL used only as an OSC sequence terminator is not treated as attention.

### OSC 9;4 progress

Treeport supports OSC `9;4` progress states:

```sh
# Normal progress at 42%
printf '\033]9;4;1;42\007'

# Error progress at 100%
printf '\033]9;4;2;100\007'

# Indeterminate active work
printf '\033]9;4;3\007'

# Paused at 7%
printf '\033]9;4;4;7\007'

# Clear progress
printf '\033]9;4;0\007'
```

Values must be integers from 0 through 100. Every valid active frame renews a five-minute inactivity lease. Refresh long-running progress more frequently and send an explicit clear when work finishes.

The absence of progress does not prove that a process is idle or complete; the application may not support the protocol.

### Process exit

When the retained foreground process exits, Treeport reports its exited state and exit code where available. An application that returns to a shell leaves the terminal running because the shell remains alive.

## Progressive enhancement

```text
No integration
└── Pi — running

Title only
└── Pi — PR #123

Title + progress
└── Pi — PR #123 · working

Title + progress + BEL
└── Pi — PR #123 · needs attention
```

## Application responsibilities

Applications and extensions should publish semantic state they understand better than Treeport does. For example, a coding-agent extension may update the title when a pull request is created or merged, emit progress while working, clear progress while waiting, and emit BEL when user action is required.

## Treeport responsibilities

Treeport observes supported terminal signals, presents them consistently, synchronizes attention across clients, avoids stale state where possible, and degrades gracefully when signals are absent. It does not guarantee that terminal applications publish accurate semantic state.

## Integration guidance

Prefer, in order:

1. process lifecycle for universal status;
2. terminal titles for short semantic context;
3. BEL for attention;
4. OSC progress for active and cleared transitions;
5. the Treeport CLI or API only for structured lifecycle operations.

Treeport does not parse arbitrary terminal output or duplicate provider-specific state. Applications should publish semantics they understand better than Treeport does.
