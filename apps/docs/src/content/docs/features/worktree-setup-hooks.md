---
title: Tree setup and cleanup
description: Prepare new trees and clean up their external resources.
---

Treeport can run project commands when it creates or removes a tree.

- **Setup** can install dependencies or prepare local configuration.
- **Cleanup** can remove external resources, such as a tree-specific database.

## Configure commands

Projects configure commands in `.treeport/setup.json` in the main tree.

Without that file, Treeport can use compatible Zed `create_worktree` tasks for setup.

These commands run with your user permissions. Use them only in repositories you trust.

## Setup and removal

Setup runs only for trees created by Treeport, not existing trees that it discovers.

Setup output appears in a **Setup** terminal. If setup fails, the tree and error output remain available.

Removing a tree stops its terminals before cleanup. If cleanup fails, Treeport keeps the Git worktree and reports the error.

Make cleanup commands safe to repeat. Removing a worktree outside Treeport does not run its cleanup.
