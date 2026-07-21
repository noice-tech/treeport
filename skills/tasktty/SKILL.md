---
name: tasktty
description: Understand TaskTTY-managed terminal context and safely create persistent, observable terminals and child worktrees with the TaskTTY CLI. Use when an agent or extension needs to inspect its TaskTTY environment, open another session, or spawn work in a separate worktree.
compatibility: Requires the tasktty CLI on PATH and a reachable TaskTTY daemon. Creation commands also require the requested child executable to be installed.
---

# TaskTTY

TaskTTY is a generic terminal and worktree layer. Its terminals are persistent tmux sessions that appear in the TaskTTY UI. A user can open a created terminal, take control of the normal application TUI, and continue working in the same session.

TaskTTY does not define task sources, planning or approval states, agent tool policies, or provider-specific workflows. The caller owns names, commands, prompts, and higher-level orchestration.

## Operating rules

- Use normal CLI output when you are reading the result. Use `--json` only for programmatic extraction or branching.
- Treat command arguments after `--` as an argv array. Do not turn them into a shell command string.
- Do not use `eval` or an implicit `sh -lc`. Launch a shell explicitly only when the caller intentionally requests shell semantics.
- Do not place untrusted titles, prompts, or other external text into interpolated shell fragments. Pass each value as one argument or use a caller-managed file when the child supports file arguments.
- Never delete a terminal or remove a worktree unless the user explicitly asks.
- Do not restrict a launched agent's normal tools or make it ephemeral unless the caller explicitly asks. The persistent interactive session is intended to remain useful when the user takes over.

## Understand the current context

Run:

```sh
tasktty context
```

Inside a managed terminal, this reports the current project, worktree, terminal, paths, statuses, IDs, and daemon URL. It resolves the injected IDs strictly; it does not guess identity from the current path.

Outside TaskTTY it reports that the terminal is not managed and exits successfully. `TASKTTY_API_URL` may be configured outside a managed terminal; if any context ID is present, however, all injected values are required. Partial IDs or IDs that no longer belong together fail instead of falling back to path inference.

Use the exact IDs from this command for subsequent operations. `.` is a convenient shorthand for the current project or worktree, but exact IDs are clearer once context has been resolved.

## Create a terminal in the current worktree

Create a persistent login shell:

```sh
tasktty terminal create --worktree <worktree-id> --name <terminal-name>
```

Launch a program directly:

```sh
tasktty terminal create --worktree <worktree-id> --name <terminal-name> -- <program> <arg> ...
```

The command returns after TaskTTY creates the tmux session. The program continues independently of the browser and of the caller that created it.

## Create a child worktree and terminal

Create a linked worktree and its first persistent terminal together:

```sh
tasktty spawn \
  --project <project-id> \
  --worktree-name <worktree-name> \
  --name <terminal-name> \
  -- <program> <arg> ...
```

The child program and its arguments are entirely caller-owned. TaskTTY preserves them but does not add prompts, modes, capability restrictions, or lifecycle policy.

By default, TaskTTY bases the worktree on the fetched remote default branch. Add `--from-current` only when the caller wants the current worktree's committed `HEAD` as the base. Uncommitted changes are not copied.

TaskTTY serializes worktree mutations per project. If a caller needs several child worktrees, create them one at a time; their terminal programs can run concurrently after creation.

## Interpret creation results

A successful `terminal create` means the tmux session was created. The requested program can still exit later.

`spawn` is intentionally non-atomic after Git creates the worktree:

- A terminal ID means the persistent session was created.
- `terminalError` means the worktree remains but its initial terminal could not be created.
- `setupError` means worktree setup could not be prepared. A retained terminal may display that error and exit without launching the requested program.
- Setup tasks can also fail after the create response. Their output and failure remain visible in the retained terminal.

Report partial creation with the returned worktree and terminal IDs. Do not blindly rerun `spawn`: the worktree may already exist. Do not remove retained resources automatically.

Inspect terminals later with:

```sh
tasktty terminal list --worktree <worktree-id>
```

## Automation and integrations

Extensions and scripts should add `--json` before the `--` command separator:

```sh
tasktty context --json

tasktty terminal create \
  --worktree <worktree-id> \
  --name <terminal-name> \
  --json -- <program> <arg> ...

tasktty spawn \
  --project <project-id> \
  --worktree-name <worktree-name> \
  --name <terminal-name> \
  --json -- <program> <arg> ...
```

JSON success output is written to stdout. JSON errors use `{ "error": { "code", "message", "details"? } }` on stderr. Relevant exit codes are:

- `0`: command completed; for `spawn`, still inspect `terminal`, `terminalError`, and `setupError`.
- `2`: invalid CLI usage.
- `3`: the daemon could not be reached.
- `5`: API, domain, or invalid-context refusal.

TaskTTY currently has no authentication. Use it only through a trusted local or private-network listener; do not invent credentials or put secrets in command arguments or URLs.
