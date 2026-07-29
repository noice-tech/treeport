---
title: Attention and progress
description: Show terminal context, progress, and attention in Treeport.
---

A terminal can give Treeport three small pieces of information: a title, progress, and a request for attention. Treeport displays them next to the terminal; it does not infer them by parsing command output.

## Title and progress

A terminal title replaces an unhelpful process name with useful context in the Treeport interface. For example, an agent can set its title to `PR #123`, and a task can publish that it is currently working.

```sh
# Set the terminal title.
printf '\033]2;PR #123\007'

# Report indeterminate active work.
printf '\033]9;4;3\007'
```

Treeport keeps normal process status even when an application sends none of these signals.

## Attention notifications

Emit BEL when a terminal needs a person to look at it:

```sh
printf '\007'
```

Treeport marks the terminal as needing attention and, unless you are already viewing it, shows an in-app notification. The desktop app also requests your attention. That state is shared by connected clients and stays visible until someone opens the terminal or dismisses the notification.

Useful moments for BEL include a failed check, an input prompt, completed CI, or an agent that has finished a task.

## Example: Pi and CI

A Pi extension can look up the pull request it created, set the terminal title to `PR #123`, and report progress while it works. It can then wait for the pull request's CI checks and emit BEL on completion or failure. Treeport provides the UI state and notification; the extension owns the GitHub and CI logic.

See [Terminal signals](/reference/terminal-signals/) for the complete title, BEL, and progress protocols.
