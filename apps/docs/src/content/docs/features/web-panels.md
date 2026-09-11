---
title: Web panels (experimental)
description: Add project tools beside your terminals.
---

Web panels are custom tools that belong to a tree. Use them for project interfaces such as a diff viewer or dashboard.

## Open a panel

Select a discovered web panel from **New panel** or the side panel's `+` menu.

Panels remain active when you switch terminals or hide the side panel.

## Add panels

A project can supply panels in `.treeport/web-panels/`. [Packages](/features/packages/) can also supply them.

Treeport supports HTML, TypeScript, React, and CSS panel sources. It handles development serving and builds.

The panel SDK provides tree context, diffs, saved panel data, and file access where permission is granted.

Use only trusted panels. Review package permissions before granting access to Treeport or project files.
