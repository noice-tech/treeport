---
title: Configuration
description: Environment variables, paths, and defaults for the Treeport daemon and CLI.
---

`treeport up --host/--port` persists listener preferences. `treeport remote enable` separately persists its Tailscale HTTPS port. Environment variables override listener preferences for advanced and contributor use.

## Daemon

| Variable                 | Default                    | Purpose                                                              |
| ------------------------ | -------------------------- | -------------------------------------------------------------------- |
| `TREEPORT_HOST`          | `127.0.0.1`                | Network interface on which the daemon listens. `HOST` is a fallback. |
| `TREEPORT_PORT`          | `8733`                     | Daemon and web-app port. `PORT` is a fallback.                       |
| `TREEPORT_DATA_DIR`      | Platform data directory    | Treeport's durable application data.                                 |
| `TREEPORT_DATABASE_PATH` | `<data-dir>/treeport.db`   | SQLite database path.                                                |
| `TREEPORT_RUNTIME_DIR`   | Platform runtime directory | Runtime files, including Treeport-owned tmux state.                  |
| `TREEPORT_SHELL`         | `$SHELL`, then `/bin/sh`   | Shell used for login-shell terminals.                                |
| `TREEPORT_TMUX_PATH`     | `tmux`                     | tmux executable or path.                                             |
| `TREEPORT_GIT_PATH`      | `git`                      | Git executable or path.                                              |
| `TREEPORT_GH_PATH`       | `gh`                       | Optional GitHub CLI executable or path.                              |
| `TREEPORT_API_URL`       | `http://<host>:<port>`     | URL injected into managed terminals and used for callbacks.          |

`~` and `~/…` are expanded in path variables.

### Default data directory

- macOS: `~/Library/Application Support/treeport`
- Other Unix-like systems: `$XDG_DATA_HOME/treeport`, or `~/.local/share/treeport`

### Default runtime directory

Treeport uses `$XDG_RUNTIME_DIR/treeport` when `XDG_RUNTIME_DIR` is set. Otherwise it uses a user-specific directory below the operating system's temporary directory.

## Repository terminal presets

A registered repository can commit terminal choices in `.treeport/terminal-presets.json`. Treeport reads the file from the worktree where a panel is being opened, so each worktree follows the version on its own branch. The versioned file maps stable preset identifiers to a name, executable, literal argument array, and optional `closeOnSuccess` behavior.

See [Terminal presets](/features/terminal-presets/#commit-presets-with-a-repository) for the complete schema, precedence, validation, and refresh behavior.

## Package settings

Global package settings live at `<data-dir>/settings.json`. A registered repository's settings live at `<main-worktree>/.treeport/settings.json`; the main worktree is authoritative for every linked worktree.

Supported fields are:

```json
{
  "npmCommand": ["npm"],
  "packages": ["npm:@acme/treeport-tools", "./local-tools"]
}
```

`npmCommand` is an argv-style command used for managed npm operations. It defaults to `["npm"]` and can use a wrapper without shell parsing:

```json
{
  "npmCommand": ["mise", "exec", "node@24", "--", "npm"]
}
```

Global managed npm state is stored under `<data-dir>/npm`. Repository managed npm state is stored under `<main-worktree>/.treeport/npm`; Treeport creates its ignore file so generated dependencies and lock state are not accidentally committed. Lifecycle scripts are disabled for every managed package operation.

See [Packages](/features/packages/) for package source, filtering, and scope behavior.

## CLI

The CLI connects to:

```text
TREEPORT_API_URL=http://127.0.0.1:8733
```

If the variable is unset, it uses the listener saved by `treeport up`, or defaults to `http://127.0.0.1:8733`.

Managed terminals receive these variables automatically. Treeport CLI commands in a managed terminal reconnect to the current local daemon after a restart, even when its listener URL changes.

| Variable               | Meaning                     |
| ---------------------- | --------------------------- |
| `TREEPORT_API_URL`     | Daemon URL                  |
| `TREEPORT_PROJECT_ID`  | Exact registered project ID |
| `TREEPORT_WORKTREE_ID` | Exact current worktree ID   |
| `TREEPORT_TERMINAL_ID` | Exact current terminal ID   |

`treeport context` validates that all IDs are present and still belong together. It refuses partial or stale managed context rather than guessing from the current directory.

## Examples

Keep Treeport local on a custom port:

```sh
treeport up --port 4900
```

Use an alternate shell and database:

```sh
TREEPORT_SHELL=/bin/bash \
TREEPORT_DATABASE_PATH=~/Backups/treeport.db \
treeport up
```

For private remote browser access, prefer `treeport remote enable`, which keeps the daemon on loopback and exposes it through Tailscale Serve; see [Remote access](/features/remote-access/). Bind beyond loopback only on a trusted private network; see [Security](/security/).
