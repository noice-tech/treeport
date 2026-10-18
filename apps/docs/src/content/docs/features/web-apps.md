---
title: Web apps
description: Add editors, diff viewers, dashboards, and custom tools to your workspace.
---

Web apps are tools supplied by your project or an installed package. Open an editor, diff viewer, or dashboard in a tree alongside your agent and browser.

Use a [browser app](/features/browser-app/) to open a website.

## Open an app

Select an available web app from **New app** or the side panel's `+` menu.

Apps remain active when you switch terminals or hide the side panel.

To open a package-provided app from the CLI, run `treeport app open <definition> --worktree .`.

## App services

Some web apps need a backend. An editor, for example, might use code-server. A package can declare an app service that Treeport starts when the app requests it. The service uses your existing Treeport connection, so you do not need a separate public port or remote-access URL.

### Open an app that needs a service

1. Install the trusted [package](/features/packages/) that supplies the app.
2. Install any external executable the app requires on the Treeport host. It must be available on Treeport's `PATH`.
3. Open the app from **New app**.

The app can start or attach to its service, show its status and output, and offer a retry if startup fails.

### Shared across trees

Apps from the same package share a service across the Treeport instance. Treeport does not start a separate process for each tree, so stopping the service affects every app using it.

Switching trees or hiding an app does not stop its service. Services stop when the Treeport backend shuts down and do not survive a backend restart, though persistent terminal sessions do.

Services run native programs with the host user's permissions. Install only packages you trust. A separate tree is not a security boundary.

App services are different from [service supervision](/features/service-supervision/), which starts and restarts the Treeport backend itself.

## Add apps

Put project apps in `.treeport/web-apps/`, or install them through [packages](/features/packages/).

Treeport supports HTML, TypeScript, React, and CSS app sources. It handles development serving and builds.

The app SDK gives apps access to tree context, diffs, and saved app data. Apps can also access files with your permission.

Use only trusted apps. Review package permissions before granting access to Treeport or project files.
