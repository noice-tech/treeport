---
title: Terminal presets
description: Save the terminal commands you use in every worktree.
---

Terminal presets are named commands you can start from the **New panel** picker in any worktree. They make repeated setup quick without changing how your tools work.

For example:

| Preset             | Command             | Typical behavior                                          |
| ------------------ | ------------------- | --------------------------------------------------------- |
| Pi                 | `pi`                | Keep the terminal open to reconnect to the agent.         |
| Development server | `pnpm dev`          | Keep the server running in the worktree.                  |
| Test watcher       | `pnpm test --watch` | Keep watching while you work.                             |
| VS Code            | `code .`            | Open the worktree, then close the terminal after success. |

## Create a global preset

Open **New panel**, then choose **Manage global presets**. Give the preset a name and the command to run. Treeport saves this user-owned preset for future terminals in any repository and worktree.

[Treeport packages](/features/packages/) can also provide presets globally or for one registered repository. Package presets remain read-only package resources rather than being copied into the user preset list.

## Repository presets

Add `.treeport/terminal-presets.json` to the repository when everyone using a checkout that contains it should receive the same choices:

```json
{
  "version": 1,
  "presets": {
    "dev": {
      "name": "Development server",
      "executable": "pnpm",
      "args": ["dev"],
      "closeOnSuccess": false
    },
    "review": {
      "name": "Review",
      "executable": "pi",
      "args": ["--prompt", "Review this branch"],
      "closeOnSuccess": false
    }
  }
}
```

The file must be valid JSON. `version` must be `1`, and each key in `presets` is a stable lowercase identifier containing letters, numbers, dots, underscores, or hyphens. A preset supports these fields:

- `name`: the name shown in the picker;
- `executable`: one executable, not a shell command line;
- `args`: an array of literal arguments;
- `closeOnSuccess`: optional, defaults to `false`.

Treeport reads this file from the worktree where you open the panel. Each worktree therefore follows the version committed on its own branch, so a preset can be developed and tested before it is merged. After changing the current worktree's file, the picker updates automatically within about five seconds.

Repository presets appear before global presets and are ordered by identifier. Repository-scoped package presets follow direct repository presets. Duplicate display names are retained rather than overriding one another; the picker shows **Repository** or **Global**, package provenance when applicable, and the literal command.

An invalid preset entry is omitted while valid entries remain available. If the file itself is malformed or has an invalid root, Treeport omits its repository presets and shows the error. Shell and global presets remain available in either case.

## Launch behavior

A preset starts as a normal terminal in the selected worktree with a concrete literal argv. Treeport never passes its executable and arguments through an implicit shell. Its program keeps its usual terminal interface, and persistent programs remain available to reconnect to. Removing a preset or its package later does not affect an already running terminal.

Registering or opening a repository does not execute its presets. A repository preset runs only after you select it in **New panel**.

## Close after completion

Enable **Close on success** for one-off commands that do not need a terminal once they complete, such as `code .`. Treeport removes the terminal after a successful exit, but keeps it when the command fails so you can inspect its output.
