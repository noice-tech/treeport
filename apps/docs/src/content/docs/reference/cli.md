---
title: CLI reference
description: Commands for projects, worktrees, terminals, context, and automation.
---

Running `treeport` without a folder or command shows help. Identifiers can usually be exact IDs or paths inside a registered project or worktree.

## Open a folder

```sh
treeport [folder] [--json]
```

Pass a relative or absolute folder anywhere inside a Git worktree. Treeport starts its managed daemon if necessary, registers or reopens the containing repository, discovers its main and linked worktrees, and opens the worktree containing the folder. Repeating the command reuses the existing project registration. Missing paths, files, and folders outside a Git repository are rejected with an actionable error.

On macOS, Treeport prefers the installed desktop app for loopback or HTTPS backends and falls back to the default browser when the app is unavailable. Other backend URLs and Linux use the default browser. Running `treeport` without a folder still shows help.

With `--json`, success output contains `projectId`, `worktreeId`, the canonical input `path`, the direct `url`, and `client`, which is either `desktop` or `browser`.

## Lifecycle

```sh
treeport start [--host <address>] [--port <port>] [--foreground]
treeport stop [--terminate-terminals --force]
treeport status
treeport logs [--lines <count>]
treeport doctor
treeport version

treeport service enable
treeport service status
treeport service disable

treeport remote enable [--port <port>]
treeport remote status
treeport remote disable
```

`treeport start` starts the daemon in the background, waits until it is ready, and prints its URL. Repeating it is safe: it reports the existing healthy daemon rather than starting another. `treeport stop` stops only a verified Treeport-owned daemon. It preserves Treeport's tmux sessions so the next start can reconcile them. `treeport stop --terminate-terminals --force` is the explicit destructive alternative.

Service mode is an explicit option for startup after reboot and restart after an unexpected exit. `service enable` registers it, `service status` checks it even when the daemon is stopped, and `service disable` stops and unregisters it. While service mode is installed, normal `start`, `stop`, `status`, `logs`, and `doctor` commands use the OS manager. See [Service supervision](/features/service-supervision/) for platform requirements and administrator actions.

With `--json`, service status reports support, manager, state, installation, boot enablement, active and healthy state, reboot readiness, definition and environment matches, expected paths, daemon state, issues, recovery commands, and a pending administrator command. Stable states are `disabled`, `action_required`, `starting`, `healthy`, `stopped`, `unhealthy`, and `stale`.

The default listener is `http://127.0.0.1:8733`. Host and port options are persisted for later starts. `--host` accepts only `127.0.0.1`, `::1`, or `localhost`. Treeport refuses a non-loopback option, environment value, or saved preference. Repair an old preference with `treeport start --host 127.0.0.1`.

`remote enable` starts the loopback daemon if needed, then configures a persistent private HTTPS [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) endpoint. It uses port `8733` by default. Serve authenticates each remote user, and tailnet policy controls access. Treeport does not create a separate credential.

A CLI on another permitted tailnet device can set `TREEPORT_API_URL` to the Serve HTTPS URL for API commands. Keep `start`, `stop`, `service`, `status`, `logs`, `doctor`, and `remote` lifecycle operations on the computer that runs Treeport. See [Remote access](/features/remote-access/) for prerequisites, persistence, tagged-device limits, and access-policy guidance.

## Context

```sh
treeport context [--json]
```

Reports exact managed project, worktree, and terminal context. Outside a managed terminal it exits successfully and reports that no managed context is present.

## Packages

```sh
treeport install <source> [-l|--local] [--json]
treeport remove <source> [-l|--local] [--json]
treeport uninstall <source> [-l|--local] [--json]
treeport list [--json]
treeport update <source> [--json]
treeport update --packages [--json]
treeport reload [-l|--local] [--json]
```

Sources must be explicit npm sources such as `npm:@acme/treeport-tools@1.2.0` or local directory paths such as `./packages/tools`. Global scope is the default. `-l` resolves the registered repository containing the current directory and uses its main-worktree settings.

`update` changes only eligible configured npm packages. Exact versions and local directories are skipped. Bare `treeport update` is reserved for a future Treeport self-update, so package-wide updates require `--packages`.

`reload` rereads settings, installs missing configured packages, and refreshes resources without restarting the daemon. Without `-l`, it reloads global settings and every registered repository. See [Packages](/features/packages/) for manifests, filters, and failure behavior.

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

By default, creation starts from the fetched remote default branch. `--from-current` uses the current worktree's committed `HEAD`; it does not copy uncommitted changes. Treeport lowercases and slugifies worktree names, replacing whitespace and punctuation with hyphens.

Removal obtains a fresh safety preview. `--force` confirms reported warnings when removal is eligible. Once accepted, removal continues independently of the browser and resumes after a Treeport restart. The worktree disappears when Git stops reporting it; Treeport handles any safely identifiable residual files separately.

## Remote Browser

```sh
treeport browser install [--json]
treeport browser status [--json]
treeport browser remove [--json]
treeport browser list [--json]

treeport browser snapshot [--panel <panel-id>] [--json]
treeport browser click <target> [--panel <panel-id>] [--json]
treeport browser fill <target> <text> [--panel <panel-id>] [--json]
treeport browser press <key> [--panel <panel-id>] [--json]
treeport browser goto <url> [--panel <panel-id>] [--json]
treeport browser back [--panel <panel-id>] [--json]
treeport browser forward [--panel <panel-id>] [--json]
treeport browser reload [--panel <panel-id>] [--json]
treeport browser console [level] [--panel <panel-id>] [--json]
treeport browser network [--panel <panel-id>] [--json]
treeport browser screenshot [--panel <panel-id>] [--json]
```

`install` downloads the Chromium build that matches Treeport's pinned Playwright runtime into Treeport's cache. `status` reports whether that build is ready. `remove` requires all Remote Browser sessions to be closed.

The remaining commands use the Playwright Agent CLI against an existing Remote Browser panel. Without `--panel`, Treeport selects the only Remote Browser panel in the current worktree. Use `list` to find panel IDs. Snapshot output contains element references that `click` and `fill` can use. The agent and Remote Browser panel operate on the same disposable browser session. These commands do not control the client-side Browser panel.

See [Browser panels](/features/browser-panel/) for permission, networking, persistence, and feature limits.

## Web panels

```sh
treeport web-panel open <definition> \
  --worktree <id-or-path-or-dot> \
  [--input <json-object>] [--new] [--json]
```

`open` reuses the newest instance of the same definition by default. Use `--new` to create a separate instance. When it runs inside a managed terminal, clients that currently show that terminal select the resulting panel. Other clients keep their current selection.

`--input` accepts one inline JSON object. Treeport stores this input with the panel. It also stores the current directory relative to the worktree. Do not put secrets in panel input. The first version does not read panel input from files or standard input.

A definition can be an exact ID or an unambiguous short name.

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

| Exit code | Meaning                                               |
| --------- | ----------------------------------------------------- |
| `0`       | Command completed; inspect partial `spawn` fields.    |
| `1`       | Startup failed or a service action is still required. |
| `2`       | Invalid CLI usage.                                    |
| `3`       | Daemon unreachable or event stream failed.            |
| `4`       | Terminal wait timed out.                              |
| `5`       | API, domain, or invalid-context refusal.              |
| `130`     | Wait interrupted with Ctrl+C.                         |
