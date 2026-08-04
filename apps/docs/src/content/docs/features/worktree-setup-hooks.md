---
title: Worktree setup
description: Prepare new worktrees with repository-defined setup commands.
---

Treeport can run repository-defined setup when it creates a worktree. Use setup commands to install dependencies, copy local environment files, generate code, or prepare other local prerequisites.

Setup runs only for worktrees Treeport creates. Registering, rediscovering, or refreshing an existing worktree does not run it.

:::caution[Setup runs repository code]
Setup commands execute automatically with your user account's permissions. Use setup only in repositories and revisions you trust. See [Security](/security/) for Treeport's broader trust model.
:::

## Configure setup

Create `.treeport/setup.json` in the repository's main worktree:

```json
{
  "version": 1,
  "commands": [
    {
      "name": "Install dependencies",
      "argv": ["pnpm", "install"],
      "timeout": "10m"
    },
    {
      "name": "Copy local environment",
      "argv": ["cp", "${TREEPORT_MAIN_WORKTREE_PATH}/.env", ".env"]
    },
    {
      "name": "Generate code",
      "argv": ["pnpm", "generate"],
      "cwd": "packages/api",
      "env": {
        "NODE_ENV": "development",
        "GENERATED_ROOT": "${TREEPORT_WORKTREE_PATH}/generated"
      }
    }
  ]
}
```

Treeport always reads setup configuration from the registered repository's **main worktree**, even when you create the new worktree from another linked worktree. This also lets setup reference untracked files that exist only in the main worktree.

The file accepts JSON with comments and trailing commas. Treeport validates it strictly and reports unknown or invalid fields instead of ignoring them.

### Fields

The root object requires:

- `version`: currently `1`.
- `commands`: an ordered array. An empty array explicitly disables setup.

Each command supports:

- `name` (required): a non-empty name shown in setup progress and failures.
- `argv` (required): a non-empty array containing the executable followed by its literal arguments.
- `cwd` (optional): a working directory inside the new worktree. Relative paths resolve from the worktree root; the default is the root.
- `env` (optional): string environment variable names and values for the command.
- `timeout` (optional): a positive duration ending in `ms`, `s`, `m`, or `h`, such as `500ms`, `30s`, `10m`, or `1h`, up to `2147483647ms`. The default is 30 minutes for each command.

Timeouts apply independently to each command, not to the complete list.

### Paths and environment

Every command receives:

- `TREEPORT_WORKTREE_PATH`: the new worktree's path.
- `TREEPORT_MAIN_WORKTREE_PATH`: the main worktree's path.

Treeport replaces the exact `${TREEPORT_WORKTREE_PATH}` and `${TREEPORT_MAIN_WORKTREE_PATH}` placeholders in `argv`, `cwd`, and configured `env` values. It leaves other values such as `$HOME` and `${OTHER_VARIABLE}` unchanged. The two Treeport variables are reserved and cannot be overridden in `env`.

A `cwd` must resolve to the new worktree or one of its descendants. Both `"packages/api"` and `"${TREEPORT_WORKTREE_PATH}/packages/api"` are valid. A path that escapes with `..`, or the main worktree path itself, is rejected. The directory may be created by an earlier setup command; it only needs to exist when its command starts.

### Exact commands, without an implicit shell

Treeport starts the `argv` executable directly and preserves each argument literally. Spaces, quotes, pipes, redirects, globs, and environment syntax do not receive shell interpretation.

If a command intentionally needs shell syntax, invoke a shell explicitly:

```json
{
  "name": "Generate and format",
  "argv": ["/bin/sh", "-lc", "pnpm generate && pnpm format:generated"]
}
```

Prefer direct argv when a shell is not required.

## Execution and failures

Commands run one at a time in their listed order. A spawn error, timeout, signal, or non-zero exit stops setup immediately, so later commands do not run. Setup failure does not remove the new worktree.

When creation includes an initial terminal, Treeport starts that terminal immediately and runs setup alongside it in a separate **Setup** terminal. The Setup terminal streams command output and closes automatically after every command succeeds. If preparation or a command fails, it stays available with the failure output. Because setup can still be running when creation returns, the retained Setup terminal is the source of later command failures.

`treeport worktree create` does not request an initial terminal. It waits for setup, reports the first failure as the setup error, and then attempts to create the default shell whether setup succeeds or fails.

## Zed compatibility

If `.treeport/setup.json` is absent, Treeport continues to read compatible `create_worktree` tasks from `.zed/tasks.json` in the main worktree:

```json
{
  "tasks": [
    {
      "label": "Install dependencies",
      "command": "pnpm install",
      "hooks": ["create_worktree"]
    },
    {
      "label": "Copy local environment",
      "command": "cp",
      "args": [".env.example", ".env"],
      "hooks": ["create_worktree"]
    }
  ]
}
```

Treeport supports the Zed task fields `label`, `command`, `args`, `cwd`, `env`, and `hooks` for this compatibility path. It also provides `ZED_WORKTREE_ROOT` and `ZED_MAIN_GIT_WORKTREE` in commands, arguments, `cwd`, and environment values.

Native and Zed commands are never combined:

- If `.treeport/setup.json` exists, Treeport uses only that file.
- An empty native `commands` array disables setup even when Zed hooks exist.
- An invalid native file reports a setup error instead of falling back to Zed.
- Removing the native file restores Zed fallback.

To migrate, add equivalent native commands and verify them before removing `create_worktree` from the Zed tasks. Other Zed tasks can remain in the same file. See the [Zed task documentation](https://zed.dev/docs/tasks) for Zed's format; Treeport's compatibility support is limited to the fields described above.
