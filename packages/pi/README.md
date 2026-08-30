# `@treeport/pi`

Give Pi compact Treeport context and access to the Treeport CLI.

## Requirements

Install these applications first:

- Treeport `0.5.0` or later;
- Pi `0.84.3` or later;
- Node.js 24 or later;
- macOS or Linux.

Make sure that the `treeport` command is on `PATH`.

## Install

Install the package globally in Pi:

```sh
pi install npm:@treeport/pi
```

The package contains a Pi extension and the detailed Treeport skill.

The extension starts only in a terminal that Treeport manages.

A managed Pi session shows this footer status:

```text
treeport · <tree-name>
```

Outside Treeport, the extension adds no guidance, notification, or footer status.

## Use natural requests

Ask Pi to do the work. You do not have to name Treeport.

Examples:

- “Start the development server.”
- “Stop the development server.”
- “Open the app and check the settings page.”
- “Do this side quest in a separate tree.”

In a managed session, the extension briefly defines Treeport projects and trees.

It includes the current project and tree names. It does not include IDs, paths, or the daemon URL.

The guidance tells Pi to use the `treeport` CLI through its standard Bash tool.

Pi uses a persistent terminal for a long-running process. Pi uses Bash directly for a finite command.

When you ask Pi to stop a process, Pi can delete its persistent terminal. Pi must not delete its own terminal.

For a side quest, Pi can use another terminal in the current tree. It can use `treeport spawn` for another tree.

Pi can control visible browser tabs when the Treeport CLI and daemon support browser commands.

The browser tabs stay open so you can inspect them.

The guidance requires your approval before a Chromium installation.

## Use the skill for detailed workflows

The bundled skill contains detailed Treeport CLI procedures.

Pi does not need the skill for routine terminal or browser operations.

Use the skill for lifecycle operations, remote access, updates, recovery, or complex child-tree work.

## Remove

Remove the package from Pi:

```sh
pi remove npm:@treeport/pi
```
