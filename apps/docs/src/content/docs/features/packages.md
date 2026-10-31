---
title: Packages
description: Add web apps and launchers globally or for one project.
---

Treeport's package and extension system is proudly stolen from [Pi](https://pi.dev).

Treeport packages supply [Web apps](/features/web-apps/) and [Launchers](/features/launchers/).

Packages load from local directories only. With no user settings file, Treeport loads review, VSCode, and GitHub from the clone's `packages/` directory. The editor requires `code-server`; GitHub features require an authenticated `gh` CLI.

## Manage packages

Register a local directory (Treeport does not copy it or install its dependencies):

```sh
treeport install ./my-treeport-package
```

Packages are global by default. To install a package for the current project, add `-l`. Treeport saves project package sources in [`.treeport/settings.json`](/reference/project-configuration/#packages).

- `treeport list` shows configured packages.
- `treeport reload` reloads package resources without restarting Treeport.
- `treeport remove <source>` removes a configured package.

Update package code with Git or your editor, then run `treeport reload`. User package settings live in the Treeport data directory's `settings.json`; an explicit packages list replaces the defaults. Relative paths in settings resolve from that settings file.

Removal does not stop terminals that were started from package launchers.

Install only packages you trust. Review requested web app permissions before approval; they can allow access to Treeport or tree files.
