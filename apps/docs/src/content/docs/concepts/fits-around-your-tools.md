---
title: Fits around your tools
description: Add context and automation without adopting a Treeport workflow.
---

Treeport adds persistent terminals around your Git worktrees. It does not replace Git, your editor, coding agent, shell, or the tools you already use.

That is progressive enhancement: Treeport is useful with no integration, while your tools can optionally add the context they understand best.

## Signals, not workflow

Treeport observes standard [terminal signals](/reference/terminal-signals/) for titles, progress, and attention. It does not require a Treeport-specific command such as `treeport progress report`, or define task states that every tool must adopt.

A normal terminal still gets persistent execution, reconnection, and process status. Applications and extensions can publish richer semantic state when they have it.

## Example: Pi

[Pi](https://pi.dev) extensions can add Treeport-aware behavior while leaving Pi's normal terminal interface intact. For example, an extension can:

- update its terminal title with the current GitHub pull request, such as `PR #123`, so Treeport shows that context in its UI;
- report custom progress while it implements or reviews a change; and
- watch CI and emit BEL when it completes, fails, or needs attention, notifying every connected Treeport client.

The extension owns the GitHub and CI logic. Treeport only presents the terminal signals consistently across browser, desktop, and phone clients.

## Build what fits your workflow

Use the integrations that help, and leave the rest alone. Treeport does not require a particular coding agent, provider, task tracker, or orchestration system. You can start with ordinary terminal programs and add small, local enhancements as your workflow needs them.
