---
title: Design principles
description: Understand the main design choices in Treeport.
---

Treeport gives terminal tools a standard application interface. You do not need detailed knowledge of terminal multiplexers.

## 1. Keep terminal applications unchanged

Treeport runs terminal applications as normal terminal applications. It does not replace their terminal user interfaces.

Use familiar tabs, keyboard shortcuts, and mouse navigation to move between repositories, Trees, and terminals.

You can continue to use your editor, shell, coding agent, and review tools.

## 2. Keep tmux out of the interface

Treeport uses tmux because tmux keeps terminal sessions active. In Treeport, tmux is an implementation component, not the user interface.

You do not need to use tmux sessions, windows, panes, prefixes, or configuration.

## 3. Use specialist tools

Treeport connects tools that have a specific purpose:

- Tailscale supplies authenticated private networking.
- Coding agents supply coding workflows.
- Terminal commands supply development tools.
- Editors supply code navigation and editing.
- GitHub pull requests supply a review workflow.

Treeport supplies the persistent Tree and terminal context. It does not make less capable copies of specialist tools.

## 4. Use one Tree for one task

A Tree gives each task separate files, changes, terminals, agents, and development servers.

Each Tree represents a Git worktree. Treeport uses the Tree as the task boundary.

Git remains the source of truth. This rule applies when Git, an editor, an agent, a script, or Treeport creates the worktree.

## 5. Keep the product boundary small

Treeport makes Tree-based development persistent and easy to access. It does not replace an agent, editor, review system, or cloud platform.

When a suitable tool exists, Treeport connects to it or stays out of its operation.
