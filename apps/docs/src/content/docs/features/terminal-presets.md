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

## Create a preset

Open **New panel**, then choose **Manage presets**. Give the preset a name and the command to run. Treeport saves this user-owned preset for future terminals in any project and worktree.

[Treeport packages](/features/packages/) can also provide presets globally or for one registered repository. Package presets remain read-only package resources rather than being copied into the user preset list. The picker shows package and scope provenance so commands with the same title can be distinguished.

A preset starts as a normal terminal in the selected worktree with a concrete literal argv. Its program keeps its usual terminal interface, and persistent programs remain available to reconnect to. Removing its package later does not affect an already running terminal.

## Close after completion

Enable **Close on success** for one-off commands that do not need a terminal once they complete, such as `code .`. Treeport removes the terminal after a successful exit, but keeps it when the command fails so you can inspect its output.
