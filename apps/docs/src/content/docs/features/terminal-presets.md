---
title: Terminal presets
description: Save terminal commands for repeated use in trees.
---

Terminal presets are named commands in **New panel**. Use them to start Pi, a development server, or a test watcher.

## Create a preset

1. Open **New panel**.
2. Select **Manage global presets**.
3. Enter a name and command.

Global presets are available in all projects and trees.

Enable **Close on success** to close a terminal after a successful command. Failed commands stay visible for inspection.

## Share presets

To share presets, add a `terminalPresets` section to `.treeport/settings.json`. Each tree reads its own copy of this file. For the fields and an example, see [Project configuration](/reference/project-configuration/#terminal-presets).

Treeport also shows compatible tasks from the main tree's `.zed/tasks.json`.

[Packages](/features/packages/) can supply presets globally or for one project.

Removing a preset does not stop terminals that are already running.
