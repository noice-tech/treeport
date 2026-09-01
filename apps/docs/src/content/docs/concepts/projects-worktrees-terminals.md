---
title: Projects, trees, and terminals
description: Learn how Treeport organizes folders, repositories, trees, and terminals.
---

Treeport uses a tree as the boundary for one unit of work.

```text
Project
└── Tree
    └── Terminal
```

## Projects

A project is a folder or Git repository that you open in Treeport.

A repository project includes a main tree and any linked trees. Each of these trees uses a Git worktree.

A folder project includes one tree for the selected folder. It does not have branches, commits, or linked trees.

### Change a folder project to a repository project

If you initialize Git in an open folder project, create an initial commit.

Then open the same path again with **Open project** or run `treeport .` in that folder.

Treeport changes the folder project to a repository project. The existing folder tree becomes the main tree.

Treeport does not require a remote. Select the main tree's current commit when you create a linked tree.

Treeport uses the canonical path as the persistent identity of a folder project. During one daemon session, it also uses filesystem metadata to recognize a moved folder and detect a replacement. Treeport refreshes this metadata after a daemon restart because device and inode values are not durable identifiers.

If a folder moves while Treeport is not running, open its new path. Treeport can register it as a new project because it cannot reliably recognize that move without adding a marker to the folder.

When you close a project, Treeport disconnects its terminal clients. The terminals and their processes continue to run.

Treeport does not remove folders, Git worktrees, or files. Open the project again to connect to the same terminals.

You can remove a closed project from the Recent projects list.

This action does not stop terminals or remove the repository, Git worktrees, or files.

Use Open project with the repository path to show the project again.

## Trees

A tree is Treeport's persistent workspace for an isolated development environment.

The tree name does not tie the workspace to one isolation mechanism. Treeport currently uses a Git worktree for each tree in a repository project.

A Git worktree is a checkout in a project. Git identifies one as the main worktree or a linked worktree.

Treeport finds Git worktrees that Git, editors, agents, scripts, or other tools create. It shows each worktree as a tree.

[Rift](https://github.com/anomalyco/rift) is one example of a different isolation mechanism. It creates copy-on-write workspaces instead of Git worktrees. Treeport does not currently support Rift.

A folder tree uses the selected folder directly. Treeport does not use Git operations for this tree.

## Terminals

Each terminal belongs to a tree. Treeport's detached terminal host owns its PTY and canonical terminal state.

When you close a client, the client disconnects from the terminal. The terminal and its process continue to run.

Open Treeport again to connect to the same session.

## Keep your current tools

Git controls branches, commits, and worktrees in repository projects. Other terminal tools keep their usual interfaces in all projects.

Read [How Treeport uses your tools](/concepts/fits-around-your-tools/).
