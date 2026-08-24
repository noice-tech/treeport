---
title: CLI reference
description: Use commands for projects, trees, terminals, context, and automation.
---

Run `treeport` without a folder or command to show help.

Most identifiers can be exact IDs or paths in a registered project or tree.

## Open a folder

```sh
treeport [folder] [--json]
```

Give a relative or absolute folder.

Treeport starts its daemon when necessary.

If you select a Git repository root, Treeport opens the repository and finds its trees.

If a repository with commits contains the folder, Treeport opens that repository.

Otherwise, Treeport registers the selected folder with one folder tree.

A repeated command uses the current project registration.

Treeport rejects missing paths and files.

In a managed terminal, Treeport opens the folder in clients that show that terminal.

On macOS, other terminals use the installed desktop client for loopback or HTTPS backends.

If the desktop client is not available, Treeport uses the default browser.

Linux and other backend URLs use the default browser.

With `--json`, success output contains these fields:

- `projectId`
- `worktreeId`
- canonical input `path`
- `projectKind`, with a value of `repository` or `folder`
- direct `url`
- `client`, with a value of `current`, `desktop`, or `browser`

## Control the daemon lifecycle

```sh
treeport start [--host <address>] [--port <port>] [--foreground]
treeport stop [--terminate-terminals --force]
treeport status
treeport logs [--lines <count>]
treeport doctor
treeport version
treeport update [--json]

treeport service enable [--headless]
treeport service status
treeport service disable

treeport remote enable [--port <port>]
treeport remote status
treeport remote disable
```

`treeport start` starts the daemon in the background and waits until it is ready. It then prints the URL.

You can run the command again safely. It reports the active healthy daemon instead of starting another daemon.

`treeport stop` stops only a verified Treeport daemon. It keeps Treeport tmux sessions for the next start.

Use `treeport stop --terminate-terminals --force` only when you intend to terminate all terminal sessions.

Service mode starts Treeport automatically and restarts it after an unexpected exit.

On macOS, `service enable` registers user/login mode without administrator access.

Use `--headless` only for explicit startup before login. This advanced macOS mode requires administrator approval.

`service status` checks the service, including when the daemon is stopped. It shows the selected mode.

`service disable` stops and removes service mode.

When service mode is installed, lifecycle commands use the operating-system manager.

See [Service supervision](/features/service-supervision/) for platform requirements and administrator actions.

With `--json`, service status reports the mode, manager, state, installation, health, expected paths, issues, and recovery commands.

Stable service states are:

- `disabled`
- `action_required`
- `starting`
- `healthy`
- `stopped`
- `unhealthy`
- `stale`

The default listener is `http://127.0.0.1:8733`.

Treeport saves host and port options for later starts.

`--host` accepts only `127.0.0.1`, `::1`, or `localhost`.

Treeport rejects a non-loopback option, environment value, or saved preference.

To repair an old preference, run `treeport start --host 127.0.0.1`.

`remote enable` starts the loopback daemon when necessary. It then configures a persistent private HTTPS Tailscale Serve endpoint.

The default HTTPS port is `8733`.

Tailscale Serve authenticates remote users. Tailnet policy controls access.

Treeport does not create a separate credential.

A remote CLI can set `TREEPORT_API_URL` to the Serve HTTPS URL for API commands.

Run lifecycle commands on the computer that runs Treeport.

These commands include `start`, `stop`, `update`, `service`, `status`, `logs`, `doctor`, and `remote`.

Bare `treeport update` resolves and verifies the latest stable npm release before it stops the local daemon. It preserves tmux terminals and an enabled service. It restarts the same lifecycle only when the daemon was running before the update. The command does not use `sudo` and refuses remote, external, development, and non-writable installations.

With `--json`, update success has stable `schemaVersion`, `operationId`, `status`, `phase`, `fromVersion`, `toVersion`, `installation`, `daemon`, `terminals`, and `rollback` fields. `status` is `current` or `updated`. Update errors identify the failed phase, rollback safety, and the next safe action.

Stable update refusal codes are:

- `UPDATE_INSTALLATION_UNSUPPORTED`
- `UPDATE_INSTALLATION_NOT_WRITABLE`
- `UPDATE_REMOTE_REFUSED`
- `UPDATE_EXTERNAL_REFUSED`
- `UPDATE_IN_PROGRESS`
- `UPDATE_DOWNGRADE_REFUSED`
- `UPDATE_DAEMON_OWNERSHIP_FAILED`
- `UPDATE_SERVICE_ADMINISTRATOR_ACTION_REQUIRED`

Stable execution and recovery codes are:

- `UPDATE_RELEASE_RESOLUTION_FAILED`
- `UPDATE_RELEASE_INVALID`
- `UPDATE_STAGING_FAILED`
- `UPDATE_VERIFICATION_FAILED`
- `UPDATE_INTERRUPTED`
- `UPDATE_HEALTH_VERIFICATION_FAILED`
- `UPDATE_TERMINAL_VERIFICATION_FAILED`
- `UPDATE_ROLLED_BACK`
- `UPDATE_ROLLBACK_FAILED`
- `UPDATE_RECOVERY_REQUIRED`

See [Remote access](/features/remote-access/) for setup and security information.

## Get terminal context

```sh
treeport context [--json]
```

This command reports the exact managed project, tree, and terminal context.

Outside a managed terminal, it exits successfully and reports that no managed context is present.

## Manage packages

```sh
treeport install <source> [-l|--local] [--json]
treeport remove <source> [-l|--local] [--json]
treeport uninstall <source> [-l|--local] [--json]
treeport list [--json]
treeport update <source> [--json]
treeport update --packages [--json]
treeport reload [-l|--local] [--json]
```

Use explicit npm sources, such as `npm:@acme/treeport-tools@1.2.0`.

You can also use local directory paths, such as `./packages/tools`.

The default scope is global.

`-l` selects the registered project for the current directory.

It changes settings in the repository main tree or the ordinary folder.

`update` changes only configured npm packages that are eligible for update. It skips exact versions and local directories.

`treeport update` without a source updates Treeport itself. A source or `--packages` updates configured packages instead.

Use `--packages` to update all eligible packages.

`reload` reads settings again, installs missing packages, and refreshes resources. It does not restart the daemon.

Without `-l`, it reloads global settings and settings for all registered projects.

See [Packages](/features/packages/) for manifests, filters, and error behavior.

## Manage projects

```sh
treeport project add <path> [--json]
treeport project list [--json]
```

`project add` registers a folder or Git repository.

For a repository, it also finds the main and linked trees.

`project list` shows all registered projects.

<a id="manage-worktrees"></a>

## Manage trees

```sh
treeport worktree list [--project <id-or-path>] [--json]

treeport worktree create \
  [--project <id-or-path>] \
  --name <name> \
  [--from-current] [--json]

treeport worktree remove <id-or-path-or-dot> [--force] [--json]
```

`worktree create` and `spawn` select the registered project that contains the current folder when you omit `--project`.

Use `--project` to select a different project.

Tree creation and removal apply only to Git repository projects.

By default, creation uses the remote default branch when available. Otherwise, it uses the local default branch.

`--from-current` uses the committed `HEAD` of the current tree. It does not copy uncommitted changes.

Treeport changes tree names to lowercase slugs. It replaces spaces and punctuation with hyphens.

Before removal, Treeport gets a current safety preview.

`--force` confirms the reported warnings when removal is permitted.

After confirmation, removal continues without the browser. It also continues after a Treeport restart.

The tree disappears when Git no longer reports its worktree.

Treeport separately handles residual files that it can identify safely.

## Manage Browser

```sh
treeport browser install [--json]
treeport browser status [--json]
treeport browser remove [--json]
treeport browser open [url] --worktree <id-or-path-or-dot> [--json]
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

`install` downloads the compatible Chromium build to the Treeport cache.

`status` reports whether the browser is ready.

Before you use `remove`, close all Browser sessions.

`open` starts Browser. Omit the URL to open a blank page.

The URL must use HTTP or HTTPS and must not contain credentials.

In a managed terminal, `open` selects Browser in clients that show that terminal.

The remaining commands control Browser.

Without `--panel`, Treeport uses the only Browser session in the current tree.

Use `list` to find Browser IDs. Use snapshot element references with `click` and `fill`.

These commands control the daemon browser session. A web client can share it.

The commands do not control the desktop native page or iframe Browser.

See [Browser](/features/browser-panel/) for networking, saved state, and limits.

## Open web panels

```sh
treeport web-panel open <definition> \
  --worktree <id-or-path-or-dot> \
  [--input <json-object>] [--new] [--json]
```

By default, `open` uses the newest instance of the same definition.

Use `--new` to create a separate instance.

In a managed terminal, the command selects the panel on clients that show that terminal.

Other clients keep their current selection.

`--input` accepts one inline JSON object. Treeport saves this input with the panel.

It also saves the current directory relative to the tree.

Do not put secrets in panel input.

This command does not read panel input from a file or standard input.

A definition can be an exact ID or one clear short name.

## Manage terminals

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

If you omit the `terminal create` command, Treeport starts a login shell.

Treeport passes arguments after `--` directly as an argument array.

`terminal capture` returns recent terminal content.

The default maximum is 200 pane rows. Use `--lines` to request from 1 through 5,000 rows.

Plain output contains the captured text.

JSON output includes `terminalId`, `capturedAt`, `lineLimit`, and `content`.

Wait conditions have these meanings:

- `idle`: Treeport currently sees no OSC progress.
- `working`: Treeport currently sees active OSC progress.
- `bell`: The next actual BEL after event subscription.
- `exit`: The retained terminal process has exited.

There is no default timeout.

Use `ms`, `s`, `m`, or `h` for a timeout. Examples are `500ms`, `30s`, and `2h`.

## Create a tree and terminal

Use `spawn` to create a linked tree and its first terminal:

```sh
treeport spawn \
  [--project <id-or-path-or-dot>] \
  --worktree-name <name> \
  --name <terminal-name> \
  [--from-current] \
  [-- <program> <arg> ...] [--json]
```

After Git creates the worktree, the remaining operation is not atomic.

In JSON output, inspect `terminal`, `terminalError`, and `setupError`.

A tree can remain when setup or terminal creation fails.

Do not run `spawn` again until you inspect a partial result.

## Use dot shorthand

In a managed terminal, `.` can identify the current project, tree, or terminal when the command supports it.

For scripts, use `treeport context` to get exact IDs instead of path inference.

## Use JSON output

Put `--json` before the command separator:

```sh
treeport terminal create \
  --worktree . \
  --name tests \
  --json -- pnpm test
```

Success output is JSON on standard output. Error output is JSON on standard error:

```json
{ "error": { "code": "DOMAIN_ERROR", "message": "…", "details": {} } }
```

| Exit code | Meaning                                                             |
| --------- | ------------------------------------------------------------------- |
| `0`       | The command completed. Inspect partial `spawn` fields.              |
| `1`       | Startup failed, an update failed, or a service action is necessary. |
| `2`       | The CLI use is invalid.                                             |
| `3`       | The daemon or event stream is not available.                        |
| `4`       | The terminal wait reached its time limit.                           |
| `5`       | The API, domain, or context refused the operation.                  |
| `130`     | The user stopped the wait with Ctrl+C.                              |
