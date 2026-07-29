---
title: Configuration
description: Environment variables, paths, and defaults for the Treeport daemon and CLI.
---

Treeport is configured with environment variables.

## Daemon

| Variable                 | Default                    | Purpose                                                              |
| ------------------------ | -------------------------- | -------------------------------------------------------------------- |
| `TREEPORT_HOST`          | `127.0.0.1`                | Network interface on which the daemon listens. `HOST` is a fallback. |
| `TREEPORT_PORT`          | `4780`                     | Daemon and web-app port. `PORT` is a fallback.                       |
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

## CLI

The CLI connects to:

```text
TREEPORT_API_URL=http://127.0.0.1:4780
```

If the variable is unset, it defaults to `http://127.0.0.1:4780`.

Managed terminals receive these variables automatically:

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
TREEPORT_PORT=4900 pnpm start:local
```

Use an alternate shell and database:

```sh
TREEPORT_SHELL=/bin/bash \
TREEPORT_DATABASE_PATH=~/Backups/treeport.db \
pnpm start:local
```

Bind beyond loopback only on a trusted private network; see [Security](/security/).
