---
title: Tree setup
description: Prepare new Trees with repository setup commands.
---

Treeport can run repository setup commands when it creates a Tree.

Use setup commands to install dependencies, copy local files, generate code, or prepare other prerequisites.

Setup runs only for Trees that Treeport creates.

Treeport does not run setup when it registers, finds, or refreshes an existing Tree.

:::caution[Setup runs repository code]
Setup commands run automatically with your user permissions. Use setup only in repositories and revisions that you trust.
:::

See [Security](/security/) for the Treeport trust boundaries.

## Configure setup

Create `.treeport/setup.json` in the main Tree:

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

Treeport always reads setup configuration from the main Tree.

This rule applies when you create a Tree from a linked Tree.

The setup can reference untracked files that are present only in the main Tree.

The file can contain comments and trailing commas.

Treeport reports unknown or invalid fields. It does not ignore them.

### Configure the root object

The root object requires these fields:

- `version`: The current value is `1`.
- `commands`: An ordered array. An empty array disables setup.

Each command supports these fields:

- `name`: Required name in setup progress and errors.
- `argv`: Required array with the executable and its literal arguments.
- `cwd`: Optional directory in the new Tree. The default is the Tree root.
- `env`: Optional object with string environment names and values.
- `timeout`: Optional positive duration with `ms`, `s`, `m`, or `h`.

Examples of valid timeouts are `500ms`, `30s`, `10m`, and `1h`.

The maximum timeout is `2147483647ms`. The default for each command is 30 minutes.

A timeout applies to one command, not to the complete command list.

### Use paths and environment variables

Each command receives these variables:

- `TREEPORT_WORKTREE_PATH`: The new Tree path.
- `TREEPORT_MAIN_WORKTREE_PATH`: The main Tree path.

Treeport replaces these exact placeholders in `argv`, `cwd`, and configured `env` values.

It does not replace other values, such as `$HOME` and `${OTHER_VARIABLE}`.

The two Treeport variables are reserved. You cannot replace them in `env`.

A `cwd` must resolve to the new Tree or one of its child directories.

Both `"packages/api"` and `"${TREEPORT_WORKTREE_PATH}/packages/api"` are valid.

Treeport rejects a path that uses `..` to leave the new Tree. It also rejects the main Tree path.

An earlier command can create the directory. The directory must exist only when its command starts.

### Start commands without an implicit shell

Treeport starts the `argv` executable directly. It keeps each argument literal.

It does not interpret spaces, quotation marks, pipes, redirects, globs, or environment syntax.

When a command requires shell syntax, start a shell explicitly:

```json
{
  "name": "Generate and format",
  "argv": ["/bin/sh", "-lc", "pnpm generate && pnpm format:generated"]
}
```

Use direct arguments when you do not need a shell.

## Understand execution and failures

Treeport runs commands one at a time in their listed order.

A start error, timeout, signal, or nonzero exit stops setup immediately. Treeport does not run later commands.

A setup failure does not remove the new Tree.

When creation includes an initial terminal, Treeport starts that terminal immediately.

It runs setup at the same time in a separate **Setup** terminal.

The Setup terminal shows command output. It closes after all commands are successful.

If preparation or a command fails, the Setup terminal stays available with the error output.

Setup can continue after the creation request returns. Thus, use the Setup terminal to find later command failures.

`treeport worktree create` does not request an initial terminal.

It waits for setup and reports the first setup error. It then tries to create the default shell after success or failure.

## Zed compatibility

If `.treeport/setup.json` is not present, Treeport reads compatible `create_worktree` tasks from the main `.zed/tasks.json` file:

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

Treeport supports `label`, `command`, `args`, `cwd`, `env`, and `hooks` in this compatibility mode.

It also supplies `ZED_WORKTREE_ROOT` and `ZED_MAIN_GIT_WORKTREE`.

These variables are available in commands, arguments, `cwd`, and environment values.

Treeport does not combine native and Zed commands during automatic setup:

- If `.treeport/setup.json` exists, Treeport uses only that file.
- An empty native `commands` array disables setup, even when Zed hooks exist.
- An invalid native file reports an error. Treeport does not use Zed as a fallback.
- When you remove the native file, Treeport uses Zed tasks again.

This order applies only to automatic Tree setup.

Zed tasks, including tasks with `create_worktree`, stay available for manual start in **New panel**.

A manual start does not start automatic setup again.

See [Zed task compatibility](/features/terminal-presets/#zed-task-compatibility) for supported manual task behavior.

To migrate, add equivalent native commands and test them. Then, remove `create_worktree` from the Zed tasks.

Other Zed tasks can stay in the same file.

See the [Zed task documentation](https://zed.dev/docs/tasks) for the full Zed format.

Treeport supports only the fields in this section.
