---
title: Terminal signals
description: Send titles, attention, and progress through standard terminal protocols.
---

Treeport preserves and controls terminal applications without an integration.

Applications can send more information through standard terminal signals.

## Process lifecycle

Each Treeport terminal supplies these functions:

- persistent execution;
- active or exited status;
- an exit code, when available;
- terminal rendering and input;
- reconnection.

An application integration is not necessary.

## Terminal title

Interactive zsh, Bash, and fish sessions capture the command when the shell starts it.

For example, Treeport can show the complete `pnpm dev` command instead of only a foreground `node` executable.

The captured title can include arguments and has a maximum of 256 characters.

Treeport clears the title when the shell prompt returns.

Treeport keeps your shell startup files when it installs these hooks.

Nushell keeps its native title behavior.

A preset terminal uses the preset name as its initial title.

Other terminals started with commands use the command as the initial title.

If a terminal returns to a shell, normal interactive-shell title tracking resumes after the command exits.

Other interactive shells use the foreground executable name.

This fallback also applies when a shell does not load Treeport's integration.

An application can replace the initial title with a more useful OSC `0` or `2` title.

A current application title has priority over a captured shell command.

```sh
printf '\033]2;Waiting for review\007'
```

Use a short title. Examples are `Implementing authentication`, `PR #123`, `PR MERGED`, and `Development server`.

Application titles and active shell commands live in the detached terminal host. They survive API daemon replacement, but not a terminal-host or computer restart.

## BEL attention

Send an actual BEL when an important change requires attention:

```sh
printf '\007'
```

Use BEL for an input request, operation completion, failed check, or required approval.

Treeport synchronizes unread attention between clients.

A BEL that only ends an OSC sequence does not request attention.

## OSC 9;4 progress

Treeport supports OSC `9;4` progress states:

```sh
# Normal progress at 42%.
printf '\033]9;4;1;42\007'

# Error progress at 100%.
printf '\033]9;4;2;100\007'

# Active work without a percentage.
printf '\033]9;4;3\007'

# Paused at 7%.
printf '\033]9;4;4;7\007'

# Clear progress.
printf '\033]9;4;0\007'
```

A percentage must be an integer from 0 through 100.

Each valid active frame renews a five-minute inactivity period.

For long operations, send progress more frequently. Send an explicit clear when the operation completes.

No progress signal does not prove that a process is idle or complete. The application can lack protocol support.

## Process exit

When the retained foreground process exits, Treeport reports the exited state.

It also reports the exit code when that code is available.

If an application returns to a shell, the terminal stays active because the shell continues to run.

## Add signals in levels

```text
No integration
└── Pi — running

Title only
└── Pi — PR #123

Title and progress
└── Pi — PR #123 · working

Title, progress, and BEL
└── Pi — PR #123 · needs attention
```

## Divide responsibilities

Applications and extensions must send the information that they understand.

For example, an agent extension can update a title when it creates or merges a pull request.

It can send progress while it works, clear progress while it waits, and send BEL when user action is necessary.

Treeport observes supported terminal signals and shows them on all clients.

It synchronizes attention and removes old state when possible.

Treeport cannot guarantee that an application sends correct information.

## Select an integration method

Use these methods in this order:

1. Use process lifecycle for universal status.
2. Use terminal titles for short context.
3. Use BEL for attention.
4. Use OSC progress for active and cleared states.
5. Use the Treeport CLI or API for structured lifecycle operations.

Treeport does not parse arbitrary terminal output or copy provider-specific state.
