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

## Configure settings

Global settings are at `<data-dir>/settings.json`.

Project settings are at `<project-root>/.treeport/settings.json`.

For a repository, the main tree is the project root. Its settings apply to all linked trees.

For a folder project, the selected folder is the project root.

## Configure tree context fields

Tree context fields collect optional information when you use the **Create tree** form.

Add field definitions to global or project settings:

```json
{
  "treeContext": {
    "fields": [
      {
        "id": "issue",
        "label": "Issue",
        "input": "text"
      },
      {
        "id": "brief",
        "label": "Task description",
        "input": "textarea"
      }
    ]
  }
}
```

Each field supports these properties:

- `id`: A stable lowercase identifier.
- `label`: The label in the form.
- `input`: Either `text` or `textarea`.

An identifier can contain letters, numbers, dots, underscores, and hyphens. It can contain a maximum of 120 characters.

Treeport shows global fields first. It adds new project fields after them.

A project field with the same identifier replaces the global field. The field keeps its global position.

Treeport supports 64 effective fields. Each saved value can contain a maximum of 16,384 characters.

The identifiers and values can contain a combined maximum of 65,536 characters.

All fields are optional. Treeport does not save an empty value.

Treeport saves submitted values with the tree. It removes the values when it removes the tree.

Do not use tree context for secrets. Managed terminals can read these values with `treeport context`.

## Configure project terminal presets

A project tree can contain `.treeport/terminal-presets.json`.

Treeport reads this file from the selected tree. In a repository, each tree uses the file from its branch.

The file maps stable preset identifiers to a name, executable, literal argument array, and optional `closeOnSuccess` value.

Treeport also reads compatible `.zed/tasks.json` tasks from the main tree.

These tasks apply to all trees in that repository. They support path expansion, working directories, and environments.

See [Repository presets](/features/terminal-presets/#repository-presets) and [Zed task compatibility](/features/terminal-presets/#zed-task-compatibility).

## Configure package settings

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

Project managed npm files are in `<project-root>/.treeport/npm`.

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
| `TREEPORT_WORKTREE_ID` | Exact current tree ID       |
| `TREEPORT_TERMINAL_ID` | Exact current terminal ID   |

After a daemon restart, CLI commands in managed terminals connect to the current local daemon.

This also works when the listener URL changes.

`treeport context` makes sure that all IDs are present and still have the correct relationship.

It refuses partial or old context. It does not infer missing IDs from the current directory.

## Update the service environment

`treeport service enable` saves the daemon configuration that the operating-system manager requires.

This configuration includes Treeport paths, listener, tool paths, `PATH`, and locale.

It does not include terminal context, SSH agent state, or unrelated shell variables.

In user service mode, run `treeport service enable` again after you change one of these items:

- the Node.js installation;
- the npm prefix;
- `PATH`;
- Treeport paths;
- the listener;
- the shell;
- the Git path;
- the tmux path.

In advanced headless mode, use `treeport service enable --headless` instead.

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
