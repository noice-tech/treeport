---
title: How Treeport uses your tools
description: Add context and automation without a required Treeport workflow.
---

Treeport adds persistent terminals to your Git worktrees. It does not replace Git, your editor, coding agent, shell, or other tools.

Treeport works without an integration. A tool can add more context when it has useful information.

## Use signals, not a required workflow

Treeport reads standard [terminal signals](/reference/terminal-signals/) for titles, progress, and attention.

It does not require a Treeport progress command. It also does not define task states that all tools must use.

A standard terminal has persistent execution, connection recovery, and process status. Applications and extensions can supply more detailed state.

## Example: Pi

A [Pi](https://pi.dev) extension can add Treeport functions without a change to the Pi terminal interface.

For example, an extension can:

- set the terminal title to a pull request, such as `PR #123`;
- report progress while Pi makes or reviews a change;
- monitor CI and send BEL when CI completes or fails.

The extension controls the GitHub and CI operations. Treeport shows the terminal signals on browser, desktop, and phone clients.

## Add only useful integrations

You can start with standard terminal programs. Add small integrations when they improve your workflow.

Treeport does not require a specified coding agent, provider, task tracker, or orchestration system.
