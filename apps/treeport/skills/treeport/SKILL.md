---
name: treeport
description: Understand Treeport-managed terminal context and safely create persistent, observable terminals and child Trees with the Treeport CLI. Use when an agent or extension needs to inspect its Treeport environment, open another session, or spawn work in a separate Tree.
compatibility: Requires the treeport CLI on PATH and a reachable Treeport daemon. Creation commands also require the requested child executable to be installed.
---

# Treeport

Treeport is a generic terminal and Tree layer. Its terminals are persistent tmux sessions that appear in the Treeport UI. A user can open a created terminal, take control of the normal application TUI, and continue working in the same session.

Treeport does not define task sources, planning or approval states, agent tool policies, or provider-specific workflows. The caller owns names, commands, prompts, and higher-level orchestration.

## Operating rules

- Use normal CLI output when you are reading the result. Use `--json` only for programmatic extraction or branching.
- Treat command arguments after `--` as an argv array. Do not turn them into a shell command string.
- Do not use `eval` or an implicit `sh -lc`. Launch a shell explicitly only when the caller intentionally requests shell semantics.
- Do not place untrusted titles, prompts, or other external text into interpolated shell fragments. Pass each value as one argument or use a caller-managed file when the child supports file arguments.
- Never delete a terminal or remove a Tree unless the user explicitly asks.
- Obey the daemon lifecycle reported by `treeport context`. When it is `external`, never run `treeport start`, `treeport stop`, or `treeport remote enable`; the parent process owns startup, shutdown, and remote exposure. When it is `service`, normal `start` and `stop` delegate to the OS manager and can require the printed administrator action.
- Do not restrict a launched agent's normal tools or make it ephemeral unless the caller explicitly asks. The persistent interactive session is intended to remain useful when the user takes over.

## Understand the current context

Run:

```sh
treeport context
```

Inside a managed terminal, this reports the current project, Tree, terminal, paths, statuses, IDs, and daemon URL. It reports whether Treeport, the OS service, or an external process manages the daemon lifecycle. It resolves the injected IDs strictly. It does not guess identity from the current path.

Outside Treeport it reports that the terminal is not managed and exits successfully. `TREEPORT_API_URL` may be configured outside a managed terminal; if any context ID is present, however, all injected values are required. Partial IDs or IDs that no longer belong together fail instead of falling back to path inference.

Use the exact IDs from this command for subsequent operations. `.` is a convenient shorthand for the current project or Tree. Exact IDs are clearer after context is resolved.

## Create a terminal in the current Tree

Create a persistent login shell:

```sh
treeport terminal create --worktree <tree-id> --name <terminal-name>
```

Launch a program directly:

```sh
treeport terminal create --worktree <tree-id> --name <terminal-name> -- <program> <arg> ...
```

The command returns after Treeport creates the tmux session. The program continues independently of the browser and of the caller that created it.

## Create a child Tree and terminal

Create a linked Tree and its first persistent terminal together:

```sh
treeport spawn \
  --project <project-id> \
  --worktree-name <tree-name> \
  --name <terminal-name> \
  -- <program> <arg> ...
```

The child program and its arguments are entirely caller-owned. Treeport preserves them but does not add prompts, modes, capability restrictions, or lifecycle policy.

By default, Treeport bases the Tree on the fetched remote default branch. Add `--from-current` only for the current Tree's committed `HEAD`. Uncommitted changes are not copied.

Treeport serializes Tree mutations per project. If a caller needs several child Trees, create them one at a time. Their terminal programs can run concurrently after creation.

## Interpret creation results

A successful `terminal create` means the tmux session was created. The requested program can still exit later.

`spawn` is intentionally non-atomic after Git creates the worktree:

- A terminal ID means the persistent session was created.
- `terminalError` means the Tree remains but its initial terminal could not be created.
- `setupError` means Tree setup could not be prepared. A retained terminal may display that error and exit without launching the requested program.
- Setup tasks can also fail after the create response. Their output and failure remain visible in the retained terminal.

Report partial creation with the returned Tree and terminal IDs. Do not blindly rerun `spawn`: the Tree may already exist. Do not remove retained resources automatically.

Inspect terminal inventory later with:

```sh
treeport terminal list --worktree <tree-id>
```

Inspect one terminal's refreshed process status and volatile runtime metadata with:

```sh
treeport terminal inspect <terminal-id>
treeport terminal inspect <terminal-id> --json
```

Runtime metadata includes the title, current OSC `9;4` progress, last progress start and clear timestamps, and latest daemon-observed real BEL. BEL metadata also reports daemon-lifetime unread attention shared by every browser; inspection and waits never acknowledge it, while viewing the terminal acknowledges the exact observed BEL sequence. `.` resolves to the exact `TREEPORT_TERMINAL_ID` inside a managed terminal; it is not a name or path lookup.

Read recent terminal contents with:

```sh
treeport terminal capture <terminal-id>
treeport terminal capture <terminal-id> --lines 500
treeport terminal capture <terminal-id> --json
```

Capture returns up to 200 pane rows by default. Plain output is the terminal text; JSON output includes the terminal ID, capture time, line limit, and content. `.` can be used for the current managed terminal.

Wait for raw terminal conditions without polling or scraping output:

```sh
treeport terminal wait <terminal-id> --until working
treeport terminal wait <terminal-id> --until idle --timeout 30m
treeport terminal wait <terminal-id> --until bell
treeport terminal wait <terminal-id> --until exit
```

- `idle` means no daemon-owned OSC progress is currently observed and can return immediately.
- `working` means daemon-owned OSC progress is currently present and can return immediately. Every valid active progress frame renews a five-minute inactivity lease; an explicit clear or terminal/observer shutdown clears immediately.
- `bell` means the next real BEL after the event subscription is established.
- `exit` means the retained terminal process has exited.
- Waits have no default timeout. Use a positive `ms`, `s`, `m`, or `h` duration when a deadline is required; Ctrl+C cancels.

Treeport does not infer agent settlement. An orchestrator can inspect first, wait for `working` if no progress cycle has been observed, and then wait for `idle`. Progress depends on the child application emitting OSC `9;4`; for Pi, `terminal.showTerminalProgress` must be enabled. Applications should clear progress or refresh active progress more frequently than the five-minute lease. A null progress value is not proof that every application supports progress reporting.

## Automation and integrations

Extensions and scripts should add `--json` before the `--` command separator:

```sh
treeport context --json

treeport terminal create \
  --worktree <tree-id> \
  --name <terminal-name> \
  --json -- <program> <arg> ...

treeport spawn \
  --project <project-id> \
  --worktree-name <tree-name> \
  --name <terminal-name> \
  --json -- <program> <arg> ...
```

JSON success output is written to stdout. JSON errors use `{ "error": { "code", "message", "details"? } }` on stderr. Relevant exit codes are:

- `0`: command completed; for `spawn`, still inspect `terminal`, `terminalError`, and `setupError`.
- `2`: invalid CLI usage.
- `3`: the daemon could not be reached or its event stream failed.
- `4`: a terminal wait timed out.
- `5`: API, domain, or invalid-context refusal.
- `130`: a terminal wait was interrupted with Ctrl+C.

Treeport trusts the local OS boundary for loopback access and delegates supported remote authentication to Tailscale Serve. Do not expose the daemon through a direct network listener, invent credentials, or put secrets in command arguments or URLs.
