---
title: Packages
description: Install reusable web panels and terminal presets globally or for one registered repository.
---

Treeport packages are npm packages or local directories that contribute declarative web panels and terminal presets. Packages cannot load daemon code or register server hooks.

Treeport's package model is inspired by [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md). Pi's thoughtfully designed combination of global and project-local settings, package manifests, conventional resource directories, filtering, and source-aware deduplication provided the model for this system. Treeport adapts those ideas to daemon-served resources such as persistent web panels and terminal presets.

## Install and manage packages

Use an explicit `npm:` source or a local directory path:

```sh
treeport install npm:@acme/treeport-tools
treeport install npm:@acme/treeport-tools@1.2.0
treeport install ./packages/local-treeport-tools

treeport list
treeport update npm:@acme/treeport-tools
treeport update --packages
treeport remove npm:@acme/treeport-tools
```

`treeport uninstall` is an alias for `treeport remove`. Bare names are not interpreted as npm packages. An npm name may include a dist-tag, version range, or exact version after its final `@`.

Commands are global by default. Add `-l` to `install`, `remove`, or `reload` to target the registered repository containing the current directory:

```sh
treeport install -l npm:@acme/treeport-tools
treeport remove -l npm:@acme/treeport-tools
treeport reload -l
```

Repository settings always belong to the registered main worktree, even when the command runs in a linked worktree. Package resources are then available in every worktree of that repository. `treeport reload` rereads global settings and all registered repository settings without restarting the daemon.

Treeport installs a missing npm package when settings are reconciled, including after registration, reopening, or daemon restart. Ordinary reloads never move an installed unpinned package. Updates happen only through `treeport update <source>` or `treeport update --packages`; exact npm versions are skipped.

Local packages remain at their original paths and are not copied. Run `treeport reload` after changing their manifest or resources.

## Package settings

Global desired state is stored in Treeport's data directory as `settings.json`. Repository desired state is stored in the main worktree at `.treeport/settings.json`:

```json
{
  "packages": [
    "npm:@acme/treeport-tools@1.2.0",
    "./packages/local-treeport-tools"
  ]
}
```

Relative local paths are resolved from the settings file. A package can use object form to select resources:

```json
{
  "packages": [
    {
      "source": "npm:@acme/treeport-tools",
      "webPanels": ["web-panels/review", "!web-panels/legacy"],
      "terminalPresets": []
    }
  ]
}
```

For each resource type:

- omit the key to load all resources of that type;
- use `[]` to load none;
- use a plain path or glob to include matches;
- use `!pattern` to exclude matches;
- use `+path` to force-include an exact package-relative path;
- use `-path` to force-exclude an exact package-relative path.

Filters can only narrow resources declared by the package manifest or conventional directories. They cannot grant access to arbitrary package paths.

When the same package exists globally and in repository settings, the repository entry replaces the global entry for that repository. Use `"autoload": false` to apply only explicit enable/disable changes to the inherited global package:

```json
{
  "packages": [
    {
      "source": "npm:@acme/treeport-tools",
      "autoload": false,
      "webPanels": ["-web-panels/legacy", "+web-panels/review"]
    }
  ]
}
```

Npm identity ignores the configured version. Local identity uses the canonical resolved path.

## Create a package

A package can declare resources in `package.json`:

```json
{
  "name": "@acme/treeport-tools",
  "keywords": ["treeport-package"],
  "treeport": {
    "webPanels": ["./web-panels/*"],
    "terminalPresets": ["./terminal-presets/*.json"]
  }
}
```

Manifest paths and globs are relative to the package root and may include `!` exclusions. A valid explicit `treeport` manifest is authoritative. Without one, Treeport discovers these conventional resources:

```text
web-panels/<resource-id>/index.html
terminal-presets/*.json
```

A terminal preset file contains one preset definition:

```json
{
  "name": "Development server",
  "executable": "pnpm",
  "args": ["dev"],
  "closeOnSuccess": false
}
```

Web panels are source-only Vite applications and require no package build step or committed output. Publish `index.html`, TypeScript/TSX or JavaScript, CSS, and imported assets in the declared panel directory. Put browser libraries in normal `dependencies`, not `devDependencies`; Treeport uses Vite to resolve and bundle the installed dependency graph. The host-provided `@treeport/panel-sdk` is the exception and belongs in `devDependencies` for authoring types. Local-path packages use development serving and HMR, while npm-installed packages are compiled into Treeport's immutable cache when opened. See [Web panels](/features/web-panels/) for the supported profile.

Panel folder names supply humanized titles. Package resource identities do not include npm versions, so updating a package preserves persistent panel identity and storage.

## Failure and removal behavior

Malformed settings, manifests, or individual resources are reported by `treeport list`, `treeport reload`, and JSON output. Valid unrelated packages, direct project web panels, user-created terminal presets, and shells remain available. If settings become malformed, Treeport keeps the previous valid resource set where possible.

Removing or temporarily losing a package does not stop terminals that were already launched from its presets. It also does not delete persistent panel instances or panel storage. An unavailable panel reports that its definition is missing and becomes usable again if the same package definition returns.

See [Security](/security/) for the package execution boundary.
