# `@treeport/claude-code`

Tell Claude Code that it works inside Treeport and how to use the Treeport CLI for persistent terminals, shared browser tabs, projects, and trees.

## Requirements

- Claude Code;
- Node.js 24 or later;
- macOS or Linux.

Make sure that the `treeport` command is on `PATH`.

## Install

In Claude Code, add the Treeport marketplace and install the plugin:

```text
/plugin marketplace add https://treeport.app/claude-code/marketplace.json
/plugin install treeport@treeport
```

Then start `claude` in a Treeport terminal.

The plugin acts only in a terminal that Treeport manages. Outside Treeport, its hooks do nothing.

## What it does

- Adds the Treeport skill, so Claude starts servers in persistent Treeport terminals, uses the shared browser, and creates separate trees.
- Tells Claude at session start that it runs in a Treeport terminal.
- Blocks background Bash commands and points Claude to `treeport terminal create`, so long-running processes stay visible and keep running after the session ends.

Claude Code reports its working, blocked, and done status to Treeport on its own.
