---
title: Attention and progress
description: Show terminal titles, progress, and attention in Treeport.
---

A terminal can give Treeport a title, progress state, and attention signal. Treeport does not parse command output to find this information.

## Set a title and progress state

Use a terminal title to replace a process name with useful context. For example, an agent can set its title to `PR #123`.

```sh
# Set the terminal title.
printf '\033]2;PR #123\007'

# Report active work without a percentage.
printf '\033]9;4;3\007'
```

If an application sends no signals, Treeport continues to show the standard process status.

## Send an attention notification

Send BEL when a terminal requires attention:

```sh
printf '\007'
```

Treeport marks the terminal for attention. If you do not view the terminal, Treeport also adds a notification.

The desktop client requests your attention when a new BEL comes from a background terminal. Unread notifications remain after Treeport restarts.

Notifications are the same on all connected clients.

Open a notification to add its terminal to the workspace navigation history.

In the desktop client, select **Back** or press `Command+[` to return to the previous workspace.

Select **Forward** or press `Command+]` to open the notification target again.

When you open the terminal, Treeport clears its notification and attention state. Closing the notification center does not clear notifications.

Treeport keeps only the most recent notification for each terminal.

Send BEL after an important event. Examples include a failed check, an input prompt, completed CI, or a completed agent task.

## Example: Pi and CI

A Pi extension can set a title after it creates a pull request. It can also report progress while it works.

The extension can then monitor CI and send BEL when CI completes or fails.

Treeport supplies the interface state and notification. The extension controls the GitHub and CI operations.

See [Terminal signals](/reference/terminal-signals/) for the supported title, BEL, and progress protocols.
