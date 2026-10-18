---
title: Web apps (experimental)
description: Add project tools beside your terminals.
---

Web apps are custom tools that belong to a tree. Use them for project interfaces such as a diff viewer or dashboard.

## Open an app

Select a discovered web app from **New app** or the side panel's `+` menu.

Apps remain active when you switch terminals or hide the side panel.

To open a package-provided app from the CLI, run `treeport app open <definition> --worktree .`.

## Add apps

A project can supply apps in `.treeport/web-apps/`. [Packages](/features/packages/) can also supply them.

Treeport supports HTML, TypeScript, React, and CSS app sources. It handles development serving and builds.

The app SDK provides tree context, diffs, saved app data, and file access where permission is granted.

Use only trusted apps. Review package permissions before granting access to Treeport or project files.
