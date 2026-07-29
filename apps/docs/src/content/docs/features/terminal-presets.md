---
title: Terminal presets
description: Save the terminal commands you use in every worktree.
---

Terminal presets are named commands you can start from the **New terminal** menu in any worktree. They make repeated setup quick without changing how your tools work.

For example:

| Preset             | Command             | Typical behavior                                          |
| ------------------ | ------------------- | --------------------------------------------------------- |
| Pi                 | `pi`                | Keep the terminal open to reconnect to the agent.         |
| Development server | `pnpm dev`          | Keep the server running in the worktree.                  |
| Test watcher       | `pnpm test --watch` | Keep watching while you work.                             |
| VS Code            | `code .`            | Open the worktree, then close the terminal after success. |

## Create a preset

Open **New terminal**, then choose **Manage presets**. Give the preset a name and the command to run. Treeport saves it for future terminals in any project and worktree.

A preset starts as a normal terminal in the selected worktree. Its program keeps its usual terminal interface, and persistent programs remain available to reconnect to.

## Close after completion

Enable **Close on success** for one-off commands that do not need a terminal once they complete, such as `code .`. Treeport removes the terminal after a successful exit, but keeps it when the command fails so you can inspect its output.
