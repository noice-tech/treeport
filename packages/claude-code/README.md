# `@treeport/claude-code`

Tell Claude Code that it works inside Treeport and how to use the Treeport CLI for persistent terminals, shared browser tabs, projects, and trees.

## Requirements

- Claude Code;
- Node.js 24 or later;
- macOS or Linux.

Make sure that the `treeport` command is on `PATH`.

## Setup

Load the plugin directly from the clone. See [Coding agents](https://treeport.app/building-apps/coding-agents/#claude-code-and-cursor) for the local plugin command.

The plugin acts only in a terminal that Treeport manages. Outside Treeport, its hooks do nothing.

## What it does

- Adds the Treeport skill, so Claude starts servers in persistent Treeport terminals, uses the shared browser, and creates separate trees.
- Tells Claude at session start that it runs in a Treeport terminal.
- Reminds Claude, when it runs a background Bash command, to use `treeport terminal create` for long-running processes, so they stay visible and keep running after the session ends.

Claude Code reports its working, blocked, and done status to Treeport on its own.
