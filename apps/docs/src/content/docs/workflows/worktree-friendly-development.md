---
title: Worktree-friendly development
description: Let every worktree run an independent copy of your application.
---

A worktree is most useful when it can run the application independently.

## Make sure your ports don't conflict

Two worktrees should not contend for the same development ports. Do not require every development server to use one fixed port. Accept a port through a command-line option or environment variable, or choose an unused port automatically.

Print the selected URL clearly so it can be opened or passed to another tool. If several processes make up the application, start them through one development command that assigns a compatible set of ports.

Avoid solving conflicts by silently stopping the process that already owns a port. It may belong to another active worktree.
