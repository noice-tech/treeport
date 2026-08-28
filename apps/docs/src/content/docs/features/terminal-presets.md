---
title: Terminal presets
description: Save terminal commands for repeated use in trees.
---

A terminal preset is a named command in the top-bar **New panel** picker. Use presets for commands that you start frequently.

| Preset             | Command             | Result                                           |
| ------------------ | ------------------- | ------------------------------------------------ |
| Pi                 | `pi`                | Keep the agent terminal available.               |
| Development server | `pnpm dev`          | Keep the server active in the tree.              |
| Test watcher       | `pnpm test --watch` | Continue tests while you work.                   |
| VS Code            | `code .`            | Open the tree and close after a successful exit. |

## Create a global preset

1. Open **New panel**.
2. Select **Manage global presets**.
3. Enter a name and command.

Treeport saves the preset for all projects and trees.

[Treeport packages](/features/packages/) can also supply global or repository presets.

Package presets stay as read-only package resources. Treeport does not copy them to the user preset list.

## Repository presets

Add `.treeport/terminal-presets.json` to the repository or ordinary folder:

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

The file must contain valid JSON. `version` must be `1`.

Each preset key is a stable lowercase identifier. It can contain letters, numbers, periods, underscores, and hyphens.

A preset supports these fields:

- `name`: The name in the picker.
- `executable`: One executable, not a shell command line.
- `args`: An array of literal arguments.
- `closeOnSuccess`: An optional Boolean value. The default is `false`.

Treeport reads the file from the tree where you open the panel.

Each tree uses the file from its own branch. Thus, you can test a preset before you merge it.

An ordinary folder project uses the file from its one tree.

After you change the file, the picker updates in approximately five seconds.

Repository presets appear before global presets. Treeport sorts repository presets by their identifier.

Repository package presets appear after direct repository presets.

Treeport keeps duplicate display names. The picker shows the scope, package source when applicable, and literal command.

Treeport omits an invalid preset entry but keeps valid entries.

If the complete file is invalid, Treeport omits its repository presets and shows the error.

Shell and global presets stay available.

## Zed task compatibility

Treeport also shows compatible tasks from `.zed/tasks.json` as terminal presets.

Treeport reads this file from the main tree. The same tasks are available in all trees for that repository.

A `.zed/tasks.json` file in a linked tree does not replace the main file.

The file can contain a task array or an object with a `tasks` array. Treeport permits comments and trailing commas.

Treeport supports these task fields:

- `label`: Required name in the picker.
- `command`: Required command string.
- `args`: Optional array of string arguments. The default is `[]`.
- `cwd`: Optional working directory. The default is the selected tree root.
- `env`: Optional object with string environment values.

Treeport resolves a relative `cwd` from the selected tree. It does not change an absolute path.

Treeport expands `$NAME` and `${NAME}` forms for these variables:

- `ZED_WORKTREE_ROOT`: The selected tree.
- `ZED_MAIN_GIT_WORKTREE`: The main tree.

Expansion applies to the label, command, arguments, working directory, and environment values.

Treeport also puts both variables in the terminal environment.

Treeport does not expand other values, such as `$HOME`, unless the command uses a shell.

A simple command, such as `pnpm`, starts directly with its arguments.

A command with shell syntax runs through the configured shell. For example, `pnpm build && pnpm test` uses a shell.

Explicit `args` keep their argument boundaries. The picker shows the resolved Zed command before start.

Treeport does not support the Zed `shell` field.

It ignores other Zed fields, such as `reveal`, `hide`, `allow_concurrent_runs`, and `use_new_terminal`.

Tasks with a `create_worktree` hook stay available for manual start.

See [Tree setup](/features/worktree-setup-hooks/#zed-compatibility) for their separate automatic behavior.

Treeport keeps Zed task file order and duplicate labels.

Zed tasks appear after direct repository presets. They appear before repository package presets and global presets.

The picker shows **Repository · Zed** as their source.

Treeport omits one invalid task without omitting valid tasks.

An invalid file omits only the Zed tasks and shows a diagnostic. All non-Zed preset sources stay available.

Changes appear in the picker in approximately five seconds.

Zed tasks require an existing tree. They do not appear in **Initial terminal** during tree creation.

## Launch behavior

A preset starts a standard terminal and keeps its terminal interface.

The preset name is the initial terminal title.

Treeport native, user, and package presets start one executable with literal arguments. Compatible Zed commands use the shell rules in the prior section.

Removing a preset does not affect a terminal that is already active.

Treeport does not run manual presets during repository registration or open.

A preset starts only after you select it in **New panel**.

The side panel does not list terminal presets. It lists Browser and discovered web panels.

## Close after completion

Enable **Close on success** for a command that does not need a terminal after completion. For example, use it with `code .`.

Treeport removes the terminal after a successful exit. It keeps the terminal after a failure so you can read its output.
