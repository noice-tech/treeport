---
title: Coding agents
description: Run coding agents alongside browsers, development servers, and project tools.
---

Run a coding agent in a [persistent terminal](/features/persistent-terminals/) and keep its tools in the same tree. The agent keeps running when you disconnect, as long as the host stays running.

Treeport currently supports integration with Pi. Other terminal programs can run in Treeport without that integration.

## Work with Pi

Install the `@treeport/pi` package in Pi, then start Pi in a Treeport terminal. See the [package setup instructions](https://github.com/noice-tech/treeport/tree/main/packages/pi#install).

Pi can use Treeport tools to manage terminals, browser tabs, projects, and trees. For example, you can ask:

- "Start the development server."
- "Open the app and check the settings page."
- "Do this side quest in a separate tree."

Long-running processes use their own terminals. Browser tabs stay visible so you can inspect the page and interact with it yourself. Pi asks for your approval before installing a browser runtime.

## Work in separate trees

Use a separate tree for each independent change. Each tree keeps its agent, server, [browser](/features/browser-app/), and [custom apps](/features/web-apps/) together when you switch tasks.

Tree context can hold a task description or other project-defined fields. Run `treeport context` inside a managed terminal to see the current project, tree, terminal, and tree context.

## Attention and progress

Supported terminal applications can show a descriptive title, progress, and attention notifications in Treeport.

Titles identify the current task. Progress shows active work or a completion percentage. Attention notifications mark terminals that need you when a task finishes or a program asks for input.

Applications without these signals still show their normal process status.

### Open a notification

Select a notification to open its terminal. Viewing the terminal clears its attention state and notification.

Unread notifications are shared across connected clients and remain after Treeport restarts.

The macOS app also requests your attention for notifications from background terminals.
