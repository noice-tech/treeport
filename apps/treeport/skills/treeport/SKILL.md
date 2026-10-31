---
name: treeport
description: Detailed Treeport CLI guidance for child-tree orchestration and server access. Use when compact Pi guidance or command help is not sufficient. Do not load for routine background processes or browser tabs in a managed Pi session.
compatibility: Requires the treeport CLI on PATH and a reachable Treeport daemon. Creation commands also require the requested child executable to be installed.
---

# Treeport

In a managed Pi session, use the injected CLI guidance for routine terminal and browser operations. Load this skill only when you need more detail.

Treeport is a generic terminal and tree layer. Its persistent terminals are owned by Treeport's detached terminal host and appear in the Treeport UI. A user can open a created terminal, take control of the normal application TUI, and continue working in the same session.

Treeport does not define task sources, planning or approval states, agent tool policies, or provider-specific workflows. The caller owns names, commands, prompts, and higher-level orchestration.

## Operating rules

- Use normal CLI output when you are reading the result. Use `--json` only for programmatic extraction or branching.
- Treat command arguments after `--` as an argv array. Do not turn them into a shell command string.
- Do not use `eval` or an implicit `sh -lc`. Launch a shell explicitly only when the caller intentionally requests shell semantics.
- Do not place untrusted titles, prompts, or other external text into interpolated shell fragments. Pass each value as one argument or use a caller-managed file when the child supports file arguments.
- Create terminals only for long-running processes such as servers, watchers, and agents.
- Delete terminals you started once their processes are no longer needed. Never delete other terminals or remove a tree unless the user explicitly asks.
- The user's shell or supervisor owns server startup, shutdown, and remote exposure.
- Treeport runs from a source checkout. Update with Git and rebuild; restart only the intended server through its supervisor, with the user's permission.
- Remote access is configured by the user with Tailscale Serve, not by Treeport commands.
- Do not restrict a launched agent's normal tools or make it ephemeral unless the caller explicitly asks. The persistent interactive session is intended to remain useful when the user takes over.

## Understand the current context

Run:

```sh
treeport context
```

Inside a managed terminal, this reports the current project, tree, terminal, paths, statuses, IDs, and daemon URL. It resolves the injected IDs strictly. It does not guess identity from the current path.

Outside Treeport it reports that the terminal is not managed and exits successfully. `TREEPORT_API_URL` may be configured outside a managed terminal; if any context ID is present, however, all injected values are required. Partial IDs or IDs that no longer belong together fail instead of falling back to path inference.

Use the exact IDs from this command when an operation targets a different project or tree. `.` is a convenient shorthand for the current project or tree.

When the current folder is in the target project, omit `--project` from `worktree create` and `spawn`. Treeport detects the registered project from the current folder.

## Create a terminal in the current tree

Create a persistent login shell:

```sh
treeport terminal create --worktree <tree-id> --name <terminal-name>
```

Launch a program directly:

```sh
treeport terminal create --worktree <tree-id> --name <terminal-name> -- <program> <arg> ...
```

The command returns after the detached terminal host creates the session. The program continues independently of the browser, API daemon, and caller that created it.

Inside a managed terminal, Treeport records the calling terminal as the new terminal's parent and shows it nested under the caller in the UI. `spawn` and `launch --new-tree` record the calling tree as the new tree's origin and show the new tree under it.

## Create a child tree and terminal

Create a linked tree and its first persistent terminal together:

```sh
treeport spawn \
  --worktree-name <tree-name> \
  --name <terminal-name> \
  -- <program> <arg> ...
```

The child program and its arguments are entirely caller-owned. Treeport preserves them but does not add prompts, modes, capability restrictions, or lifecycle policy.

By default, Treeport bases the tree on the fetched remote default branch. Add `--from-current` only for the current tree's committed `HEAD`. Uncommitted changes are not copied.

Treeport serializes tree mutations per project. If a caller needs several child trees, create them one at a time. Their terminal programs can run concurrently after creation.

## Interpret creation results

A successful `terminal create` means the hosted terminal was created. The requested program can still exit later.

`spawn` is intentionally non-atomic after Git creates the worktree:

- A terminal ID means the persistent session was created.
- `terminalError` means the tree remains but its initial terminal could not be created.
- `setupError` means tree setup could not be prepared. A retained terminal may display that error and exit without launching the requested program.
- Setup tasks can also fail after the create response. Their output and failure remain visible in the retained terminal.

Report partial creation with the returned tree and terminal IDs. Do not blindly rerun `spawn`: the tree may already exist. Do not remove retained resources automatically.

Inspect terminal inventory later with:

```sh
treeport terminal list --worktree <tree-id>
```

Inspect one terminal's refreshed process status and volatile runtime metadata with:

```sh
treeport terminal inspect <terminal-id>
treeport terminal inspect <terminal-id> --json
```

Runtime metadata includes the title, the current activity (`idle`, `working`, `blocked`, `done`, or `error`, with optional progress, kind, and message) and when it began, and the latest attention event with its reason: a real BEL, or the activity becoming `done`, `blocked`, or `error`. Attention also reports unread state shared by every browser; inspection and waits never acknowledge it, while viewing the terminal acknowledges the exact observed attention sequence. `.` resolves to the exact `TREEPORT_TERMINAL_ID` inside a managed terminal; it is not a name or path lookup.

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
treeport terminal wait <terminal-id> --until attention
treeport terminal wait <terminal-id> --until exit
```

- `idle` means the terminal's activity is not `working` and can return immediately.
- `working` means the terminal's activity is `working` and can return immediately. Activity from OSC `9;4` progress expires after five minutes without a new progress frame; an explicit clear or terminal/observer shutdown clears immediately.
- `attention` means the next attention event after the event subscription is established.
- `exit` means the retained terminal process has exited.
- Waits have no default timeout. Use a positive `ms`, `s`, `m`, or `h` duration when a deadline is required; Ctrl+C cancels.

Treeport does not infer agent settlement. An orchestrator can inspect first, wait for `working` if no activity has been observed, and then wait for `idle`. Activity depends on the child application reporting it, with OSC `7501` program status or OSC `9;4` progress; once an application sends OSC `7501`, Treeport ignores its OSC `9;4` until a full terminal reset. For Pi, `terminal.showTerminalProgress` must be enabled for OSC `9;4`. Applications using OSC `9;4` should clear progress or refresh active progress more frequently than the five-minute lease. An `idle` activity is not proof that every application supports progress reporting.

Send input to a terminal, for example to answer a prompt or drive a TUI. `send-keys` follows `tmux send-keys`: an argument that names a key is sent as that key, and any other argument is typed literally.

```sh
treeport terminal send-keys <terminal-id> 'npm test' Enter
treeport terminal send-keys <terminal-id> C-c
treeport terminal send-keys <terminal-id> -N 3 Down Enter
```

Keys include `Enter`, `Escape`, `Tab`, `BTab`, `BSpace`, `Space`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, `IC`, `DC`, and `F1` through `F12`. Prefix `C-`, `M-`, or `S-` for Ctrl, Alt, or Shift. `-l` types every argument literally.

Paste text, such as a multi-line prompt, with `send-text`. It uses bracketed paste when the application enables it, so newlines do not submit early. Send `Enter` separately to submit:

```sh
cat prompt.md | treeport terminal send-text <terminal-id>
treeport terminal send-keys <terminal-id> Enter
```

Sending to an exited terminal fails. Follow up with `terminal wait` and `terminal capture` to observe the result.

## Register and run launchers

Launchers are saved programs that the Treeport UI and `treeport launch` start in a tree. A lowercase `${name}` inside an argument is an input that the caller fills in when launching. Treeport passes input values through without interpreting them.

To register an agent CLI, check its `--help` for how it accepts an initial prompt, then save it:

```sh
treeport launcher add --name Claude -- claude '${prompt}'
```

Quote `${...}` inputs so the shell does not expand them. Add `--repo` to save the launcher in the current tree's `.treeport/settings.json` instead of for every project. Use `treeport launcher list` to see available launcher IDs and inputs.

Start a launcher in the current tree, or in a new tree:

```sh
treeport launch claude --input prompt="Fix the login redirect loop"
treeport launch claude --new-tree --tree-name login-redirect --input prompt="Fix the login redirect loop"
```

Without `--tree-name`, the new tree is named `tree`, `tree-2`, and so on.

A tree's folder name is fixed, but its title can change. A launcher can title its new trees with `--tree-title '["claude","-p","Reply with a 3-5 word title for: ${task}"]'`: after the tree starts, the command's first output line becomes the title. To title the current tree yourself, run:

```sh
treeport worktree title "Fix the login redirect loop"
```

## Inspect the worktree application in a browser tab

The Browser primitive has one live runtime for each browser tab.

Electron owns the visible `<webview>` page for a local desktop connection.

Playwright controls native Chrome on macOS or a browser-only Docker container on Linux for a web or remote desktop connection.

Never attach Treeport to a personal browser profile.

First, inspect the available browser tabs:

```sh
treeport browser list
```

If no browser tab is open, open one in the current tree:

```sh
treeport browser open --worktree .
```

Use these commands on the current live page:

```sh
treeport browser snapshot
treeport browser click e12
treeport browser fill e14 "value"
treeport browser press Enter
treeport browser console
treeport browser network
treeport browser run 'return await page.title()'
treeport browser screenshot
```

The commands select the only browser tab in the current tree.

When more than one browser tab exists, add `--app <app-id>`.

Snapshot references belong to one runtime generation.

Take a new snapshot after navigation or a runtime change.

A local desktop owner does not need the daemon browser.

If no local owner exists, check the browser runtime before daemon automation:

```sh
treeport browser status
```

Ask the user before you run `treeport browser install`. On Linux, this builds or updates the browser container image.

On macOS, use installed Chrome directly. Do not install Docker for a Mac browser.

For a native Linux browser, set `TREEPORT_BROWSER_EXECUTABLE` to its absolute path when starting the daemon.

Leave the browser tab open so the user can inspect the result.

## Automation and integrations

Extensions and scripts should add `--json` before the `--` command separator:

```sh
treeport context --json

treeport terminal create \
  --worktree <tree-id> \
  --name <terminal-name> \
  --json -- <program> <arg> ...

treeport spawn \
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
