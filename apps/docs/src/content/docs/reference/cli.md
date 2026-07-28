---
title: CLI reference
description: Commands for projects, worktrees, terminals, context, and automation.
---

The `treeport` CLI talks to a running daemon. Identifiers can usually be exact IDs or paths inside a registered project or worktree.

## Context

```sh
treeport context [--json]
```

Reports exact managed project, worktree, and terminal context. Outside a managed terminal it exits successfully and reports that no managed context is present.

## Projects

```sh
treeport project add <path> [--json]
treeport project list [--json]
```

`project add` registers a Git repository and discovers its main and linked worktrees. `project list` prints all registered repositories.

## Worktrees

```sh
treeport worktree list [--project <id-or-path>] [--json]

treeport worktree create \
  --project <id-or-path> \
  --name <name> \
  [--from-current] [--json]

treeport worktree remove <id-or-path-or-dot> [--force] [--json]
```

By default, creation starts from the fetched remote default branch. `--from-current` uses the current worktree's committed `HEAD`; it does not copy uncommitted changes.

Removal obtains a fresh safety preview. `--force` confirms reported warnings when cleanup is still eligible; see [safe worktree cleanup](/features/safe-cleanup/).

## Terminals

```sh
treeport terminal list [--worktree <id-or-path>] [--json]

treeport terminal create \
  --worktree <id-or-path-or-dot> \
  --name <name> \
  [-- <program> <arg> ...] [--json]

treeport terminal inspect <terminal-id-or-dot> [--json]

treeport terminal capture <terminal-id-or-dot> [--lines <count>] [--json]

treeport terminal wait <terminal-id-or-dot> \
  --until <idle|working|bell|exit> \
  [--timeout <duration>] [--json]

treeport terminal delete <terminal-id> [--json]
```

Omitting a command from `terminal create` starts a login shell. Arguments after `--` are passed directly as an argv array.

`terminal capture` returns recent terminal contents. It returns up to 200 pane rows by default; use `--lines` to request between 1 and 5,000. Plain output is the captured text. JSON output includes `terminalId`, `capturedAt`, `lineLimit`, and `content`.

Wait conditions mean:

- `idle`: no OSC progress is currently observed;
- `working`: active OSC progress is currently observed;
- `bell`: the next real BEL after event subscription;
- `exit`: the retained terminal process has exited.

There is no default timeout. Valid timeout units are `ms`, `s`, `m`, and `h`, such as `500ms`, `30s`, or `2h`.

## Spawn

Create a linked worktree and its first terminal in one operation:

```sh
treeport spawn \
  --project <id-or-path-or-dot> \
  --worktree-name <name> \
  --name <terminal-name> \
  [--from-current] \
  [-- <program> <arg> ...] [--json]
```

Creation is intentionally non-atomic after Git creates the worktree. In JSON output, inspect `terminal`, `terminalError`, and `setupError`; a retained worktree can exist even if setup or terminal creation fails. Do not blindly rerun `spawn` after a partial result.

## Dot shorthand

Inside a managed terminal, `.` can resolve the current project, worktree, or terminal where the command supports it. `treeport context` provides the exact IDs for scripts that should avoid path inference.

## JSON output

Place `--json` before the command separator:

```sh
treeport terminal create \
  --worktree . \
  --name tests \
  --json -- pnpm test
```

Success output is JSON on stdout. Errors are JSON on stderr:

```json
{ "error": { "code": "DOMAIN_ERROR", "message": "…", "details": {} } }
```

| Exit code | Meaning                                            |
| --------- | -------------------------------------------------- |
| `0`       | Command completed; inspect partial `spawn` fields. |
| `2`       | Invalid CLI usage.                                 |
| `3`       | Daemon unreachable or event stream failed.         |
| `4`       | Terminal wait timed out.                           |
| `5`       | API, domain, or invalid-context refusal.           |
| `130`     | Wait interrupted with Ctrl+C.                      |
