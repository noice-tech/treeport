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

## Zed task compatibility

Treeport also offers compatible tasks from `.zed/tasks.json` as terminal presets. It reads this file from the registered repository's **main worktree** and shares those choices with every existing worktree in that repository. A linked worktree's own `.zed/tasks.json` does not override the main file.

The file may be a task array or an object with a `tasks` array. Comments and trailing commas are accepted. Treeport supports this subset of each task:

- `label`: required name shown in the picker;
- `command`: required command string;
- `args`: optional array of string arguments, defaulting to `[]`;
- `cwd`: optional working directory, defaulting to the selected worktree root;
- `env`: optional object containing string environment values.

Relative `cwd` values resolve from the selected worktree. Absolute paths remain absolute. Treeport expands both `$NAME` and `${NAME}` forms of these variables in the label, command, arguments, working directory, and environment values:

- `ZED_WORKTREE_ROOT`: the worktree where the terminal will start;
- `ZED_MAIN_GIT_WORKTREE`: the registered main worktree.

Both variables are also present in the launched environment. Other values such as `$HOME` remain unchanged unless the command itself requires shell interpretation.

A simple `command`, such as `pnpm`, starts directly with its arguments. A command containing shell syntax, such as `pnpm build && pnpm test`, runs through Treeport's configured shell; explicit `args` retain their argument boundaries. The picker displays the concrete shell invocation before launch. Zed's `shell` field is not supported.

Other Zed options, including `reveal`, `hide`, `allow_concurrent_runs`, and `use_new_terminal`, are ignored. Tasks with a `create_worktree` hook remain available for manual launch; the hook's separate automatic behavior is described in [Worktree setup](/features/worktree-setup-hooks/#zed-compatibility).

Zed tasks keep file order, and duplicate labels remain separate choices. They appear after direct Treeport repository presets and before repository package and global presets, with **Repository · Zed** provenance. An invalid task is omitted independently. A malformed file omits only the Zed choices and shows a diagnostic; Shell and every non-Zed preset source remain available. Changes appear in the picker within about five seconds.

Zed choices require an existing selected worktree, so they do not appear in the **Initial terminal** field while creating a worktree.

## Launch behavior

A preset starts as a normal terminal and keeps its usual terminal interface. Treeport-native, user, and package presets launch their executable and arguments literally without an implicit shell. Compatible Zed commands use the shell behavior described above. Persistent programs remain available to reconnect to, and removing a preset or its package later does not affect an already running terminal.

Registering or opening a repository does not execute its manual presets. A repository preset or Zed task runs from the picker only after you select it in **New panel**.

## Close after completion

Enable **Close on success** for one-off commands that do not need a terminal once they complete, such as `code .`. Treeport removes the terminal after a successful exit, but keeps it when the command fails so you can inspect its output.
