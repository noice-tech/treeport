# `@treeport/pi`

Tell Pi that it works inside Treeport, describe Treeport capabilities, and provide access to the Treeport CLI.

## Setup

Use the package directly from the clone. See [Coding agents](https://treeport.app/building-apps/coding-agents/#work-with-pi) for local installation instructions.

The integration activates inside Treeport-managed terminals and provides on-demand Treeport tools and the detailed CLI skill.

## Use natural requests

Ask Pi to do the work. You do not have to name Treeport.

Examples:

- “Start the development server.”
- “Stop the development server.”
- “Open the app and check the settings page.”
- “Do this side quest in a separate tree.”

In a managed session, the extension tells Pi that it works inside Treeport.

It describes persistent terminals, browser support, and project and tree management.

It includes the current project and tree names. It does not include IDs, paths, or the daemon URL.

Pi uses the `treeport` CLI through its standard Bash tool.

Pi consults CLI `--help` when it needs command syntax or options. The context does not include command procedures or help output.

Pi uses a persistent terminal for a long-running process. Pi uses Bash directly for a finite command.

When you ask Pi to stop a process, Pi can delete its persistent terminal. Pi must not delete its own terminal.

For a side quest, Pi can use another terminal in the current tree. It can use `treeport spawn` for another tree.

Pi can control visible browser tabs when the Treeport CLI and daemon support browser commands.

The browser tabs stay open so you can inspect them.

The safety guidance requires your approval before a browser runtime installation.

## Detailed workflows

The bundled skill covers CLI orchestration and server lifecycle boundaries. To remove the integration, use `pi remove /absolute/path/to/treeport/packages/pi`.
