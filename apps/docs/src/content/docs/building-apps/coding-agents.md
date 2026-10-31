---
title: Coding agents
description: Run coding agents alongside browsers, development servers, and project tools.
---

Run a coding agent in a [persistent terminal](/features/persistent-terminals/) and keep its tools in the same tree. The agent keeps running when you disconnect, as long as the host stays running.

Pi, Claude Code, and Cursor integrations are included in the clone. Other agent CLIs also run in Treeport. To start an agent with a prompt, add it as a [launcher](/features/launchers/#add-any-agent-cli).

## Work with Pi

From the clone, run `pi install ./packages/pi`, then start Pi in a Treeport terminal. Pi loads the integration directly from that path.

Pi can use Treeport tools to manage terminals, browser tabs, projects, and trees. For example, you can ask:

- "Start the development server."
- "Open the app and check the settings page."
- "Do this side quest in a separate tree."

Long-running processes use their own terminals. Browser tabs stay visible so you can inspect the page and interact with it yourself. Pi asks for your approval before installing a browser runtime.

## Claude Code and Cursor

Start Claude Code with `claude --plugin-dir /absolute/path/to/treeport/packages/claude-code`.

For Cursor, run `node /absolute/path/to/treeport/packages/cursor/bin/setup.mjs install-hooks`, then use `agent` normally. Add `--project` to install into the current project's `.cursor` directory instead of your home. Re-run the setup after pulling integration changes; `uninstall-hooks` removes the managed hooks and skill.

## Work in separate trees

Use a separate tree for each independent change. Each tree keeps its agent, server, [browser](/features/browser-app/), and [custom apps](/features/web-apps/) together when you switch tasks.

A [launcher](/features/launchers/#start-in-a-new-tree) can start an agent with its task in a new tree and give the tree a title. Run `treeport context` inside a managed terminal to see the current project, tree, and terminal.

## Attention and progress

Supported terminal applications can show a descriptive title, progress, and attention notifications in Treeport.

Titles identify the current task. Progress shows active work or a completion percentage. Attention notifications mark terminals that need you when a task finishes or a program asks for input.

Applications without these signals still show their normal process status.

### Open a notification

Select a notification to open its terminal. Viewing the terminal clears its attention state and notification.

Unread notifications are shared across connected clients and remain after Treeport restarts.

The macOS app also requests your attention for notifications from background terminals.
