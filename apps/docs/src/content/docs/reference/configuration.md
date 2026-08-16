---
title: Configuration
description: Configure Treeport environment variables, paths, and defaults.
---

`treeport start --host/--port` saves listener preferences.

The host must be `127.0.0.1`, `::1`, or `localhost`.

`treeport remote enable` separately saves its Tailscale HTTPS port.

Environment variables replace listener preferences. They cannot enable a non-loopback listener.

## Configure the daemon

| Variable                 | Default                    | Purpose                                                |
| ------------------------ | -------------------------- | ------------------------------------------------------ |
| `TREEPORT_HOST`          | `127.0.0.1`                | Daemon loopback address. `HOST` is a fallback.         |
| `TREEPORT_PORT`          | `8733`                     | Daemon and web application port. `PORT` is a fallback. |
| `TREEPORT_DATA_DIR`      | Platform data directory    | Durable Treeport application data.                     |
| `TREEPORT_DATABASE_PATH` | `<data-dir>/treeport.db`   | SQLite database path.                                  |
| `TREEPORT_RUNTIME_DIR`   | Platform runtime directory | Runtime files, including Treeport tmux state.          |
| `TREEPORT_SHELL`         | `$SHELL`, then `/bin/sh`   | Shell for login-shell terminals.                       |
| `TREEPORT_TMUX_PATH`     | `tmux`                     | tmux executable or path.                               |
| `TREEPORT_GIT_PATH`      | `git`                      | Git executable or path.                                |
| `TREEPORT_GH_PATH`       | `gh`                       | Optional GitHub CLI executable or path.                |
| `TREEPORT_API_URL`       | `http://<host>:<port>`     | Daemon URL for managed terminals and callbacks.        |

Treeport expands `~` and `~/…` in path variables.

### Find the default data directory

- macOS: `~/Library/Application Support/treeport`
- Other Unix systems: `$XDG_DATA_HOME/treeport`, or `~/.local/share/treeport`

### Find the default runtime directory

When `XDG_RUNTIME_DIR` is set, Treeport uses `$XDG_RUNTIME_DIR/treeport`.

Otherwise, it uses a user-specific directory in the operating-system temporary directory.

## Configure repository terminal presets

A repository can contain `.treeport/terminal-presets.json`.

Treeport reads this file from the selected worktree. Thus, each worktree uses the file from its branch.

The file maps stable preset identifiers to a name, executable, literal argument array, and optional `closeOnSuccess` value.

Treeport also reads compatible `.zed/tasks.json` tasks from the main worktree.

These tasks apply to all worktrees in that repository. They support path expansion, working directories, and environments.

See [Repository presets](/features/terminal-presets/#repository-presets) and [Zed task compatibility](/features/terminal-presets/#zed-task-compatibility).

## Configure package settings

Global package settings are at `<data-dir>/settings.json`.

Repository settings are at `<main-worktree>/.treeport/settings.json`. The main worktree controls all linked worktrees.

Supported fields are:

```json
{
  "npmCommand": ["npm"],
  "packages": ["npm:@acme/treeport-tools", "./local-tools"]
}
```

`npmCommand` is an argument-array command for managed npm operations. The default is `["npm"]`.

You can use a wrapper without shell parsing:

```json
{
  "npmCommand": ["mise", "exec", "node@24", "--", "npm"]
}
```

Global managed npm files are in `<data-dir>/npm`.

Repository managed npm files are in `<main-worktree>/.treeport/npm`.

Treeport creates an ignore file in this directory. This prevents accidental commits of dependencies and lock data.

Treeport disables lifecycle scripts for all managed package operations.

See [Packages](/features/packages/) for package sources, filters, and scope.

## Configure the CLI

The default CLI connection is:

```text
TREEPORT_API_URL=http://127.0.0.1:8733
```

If the variable is not set, Treeport uses the saved listener. If no listener is saved, it uses the default URL.

Treeport puts these variables in managed terminals:

| Variable               | Meaning                     |
| ---------------------- | --------------------------- |
| `TREEPORT_API_URL`     | Daemon URL                  |
| `TREEPORT_PROJECT_ID`  | Exact registered project ID |
| `TREEPORT_WORKTREE_ID` | Exact current worktree ID   |
| `TREEPORT_TERMINAL_ID` | Exact current terminal ID   |

After a daemon restart, CLI commands in managed terminals connect to the current local daemon.

This also works when the listener URL changes.

`treeport context` makes sure that all IDs are present and still have the correct relationship.

It refuses partial or old context. It does not infer missing IDs from the current directory.

## Update the service environment

`treeport service enable` saves the daemon configuration that the operating-system manager requires.

This configuration includes Treeport paths, listener, tool paths, `PATH`, and locale.

It does not include terminal context, SSH agent state, or unrelated shell variables.

Run `treeport service enable` again after you change one of these items:

- the Node.js installation;
- the npm prefix;
- `PATH`;
- Treeport paths;
- the listener;
- the shell;
- the Git path;
- the tmux path.

`treeport service status` and `treeport doctor` report an old service environment.

## Examples

Start Treeport on a different local port:

```sh
treeport start --port 4900
```

Use a different shell and database:

```sh
TREEPORT_SHELL=/bin/bash \
TREEPORT_DATABASE_PATH=~/Backups/treeport.db \
treeport start
```

For private remote access, use `treeport remote enable`.

This command keeps the daemon on loopback and adds Tailscale Serve. See [Remote access](/features/remote-access/).

To repair an old non-loopback preference, run:

```sh
treeport start --host 127.0.0.1
treeport remote enable
```
