---
title: Packages
description: Add web apps and launchers globally or for one project.
---

Treeport's package and extension system is proudly stolen from [Pi](https://pi.dev).

Treeport packages supply [Web apps](/features/web-apps/) and [Launchers](/features/launchers/).

A package can come from npm or a local directory.

## Manage packages

Install an npm package with `treeport install npm:<package-name>`, or install a local directory:

```sh
treeport install ./my-treeport-package
```

Packages are global by default. To install a package for the current project, add `-l`. Treeport saves project package sources in [`.treeport/settings.json`](/reference/project-configuration/#packages).

- `treeport list` shows configured packages.
- `treeport update --packages` updates packages that are not pinned to an exact version.
- `treeport reload` reloads package resources without restarting Treeport.
- `treeport remove <source>` removes a configured package.

Removal does not stop terminals that were started from package launchers.

Install only packages you trust. Review requested web app permissions before approval; they can allow access to Treeport or tree files.
