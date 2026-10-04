---
title: Tree setup and cleanup
description: Prepare new trees and remove their external resources.
---

Treeport can run project commands when it creates or removes a tree.

- **Setup** can install dependencies or prepare local configuration.
- **Cleanup** can remove external resources, such as a database for one tree.

## Configure commands

Set commands in the `setup` section of the main tree's `.treeport/settings.json`. For the fields and an example, see [Project configuration](/reference/project-configuration/#setup).

If this section is absent, Treeport can use compatible Zed `create_worktree` tasks for setup. An empty `setup.commands` array disables this fallback. Treeport does not use Zed tasks for cleanup.

These commands run with your user permissions. Use them only in repositories that you trust.

## Setup and removal

Treeport runs setup only for trees that it creates. It does not run setup for existing trees that it finds.

Treeport shows setup output in a **Setup** terminal. If setup fails, Treeport keeps the tree and error output.

Before cleanup, Treeport stops the tree's terminals. If cleanup fails, Treeport keeps the Git worktree and reports the error.

Make sure that cleanup commands are safe to repeat. If you remove a worktree outside Treeport, its cleanup commands do not run.
