---
title: Packages
description: Install web panels and terminal presets globally or for one repository.
---

A Treeport package is an npm package or local directory. It can supply declarative web panels and terminal presets.

A package cannot load daemon code or register server hooks.

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

`treeport uninstall` is an alias for `treeport remove`.

Treeport does not interpret a bare name as an npm package.

An npm name can include a distribution tag, version range, or exact version after its last `@`.

Commands use global scope by default.

Add `-l` to `install`, `remove`, or `reload` to select the registered repository for the current directory:

```sh
treeport install -l npm:@acme/treeport-tools
treeport remove -l npm:@acme/treeport-tools
treeport reload -l
```

Repository settings always belong to the main tree.

Package resources are available in all trees for that repository.

`treeport reload` reads global settings and all registered repository settings again. It does not restart the daemon.

Treeport installs missing npm packages when it applies settings. This can occur after registration, reopen, or a daemon restart.

A normal reload does not change the version of an installed package that is not pinned.

Use `treeport update <source>` or `treeport update --packages` to update packages. Treeport does not update exact npm versions.

Local packages stay at their original paths. Treeport does not copy them.

After you change a local package manifest or resource, run `treeport reload`.

## Configure package settings

Global package settings are in `settings.json` in the Treeport data directory.

Repository package settings are in `.treeport/settings.json` in the main tree:

```json
{
  "packages": [
    "npm:@acme/treeport-tools@1.2.0",
    "./packages/local-treeport-tools"
  ]
}
```

Treeport resolves relative paths from the settings file.

Use the object form to select resources:

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

- Omit the key to load all resources of that type.
- Use `[]` to load no resources of that type.
- Use a path or glob to include matches.
- Use `!pattern` to exclude matches.
- Use `+path` to include one exact package-relative path.
- Use `-path` to exclude one exact package-relative path.

Filters can reduce only the resources from the package manifest or standard directories.

They cannot give access to other package paths.

A repository package replaces the same global package for that repository.

Use `"autoload": false` to change only the resource selection for an inherited global package:

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

For identity, Treeport ignores an npm package version. A local package uses its canonical resolved path.

## Create a package

Declare package resources in `package.json`:

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

Manifest paths and globs are relative to the package root. They can include `!` exclusions.

Use an object to request the high-trust `same-origin` permission for a web panel:

```json
{
  "treeport": {
    "webPanels": [
      {
        "source": "./web-panels/browser",
        "permissions": ["same-origin"]
      }
    ]
  }
}
```

This permission lets a panel use standard browser storage in nested applications.

It also lets the panel access the same-origin Treeport page and API routes. Use this permission only for trusted code.

An explicit, valid `treeport` manifest controls package discovery.

Without this manifest, Treeport finds resources in these standard locations:

```text
web-panels/<resource-id>/index.html
terminal-presets/*.json
```

A terminal preset file contains one preset:

```json
{
  "name": "Development server",
  "executable": "pnpm",
  "args": ["dev"],
  "closeOnSuccess": false
}
```

Web panels are source-only Vite applications. They do not need a package build step or committed build output.

Publish the panel source and imported assets in the declared panel directory.

Put browser libraries in `dependencies`. Put the host-supplied `@treeport/panel-sdk` in `devDependencies` for types.

Treeport uses development serving and HMR for local packages. It compiles installed npm panels into a fixed cache when you open them.

See [Web panels](/features/web-panels/) for the supported source profile.

The panel folder name supplies its default title.

A package update keeps the panel identity and storage because the resource identity does not contain the npm version.

## Understand failures and removal

`treeport list`, `treeport reload`, and JSON output report invalid settings, manifests, and resources.

A failure in one package does not remove unrelated valid resources.

When settings become invalid, Treeport keeps the previous valid resource set when possible.

Removing a package does not stop terminals that started from its presets.

Removal also does not delete panel instances or panel storage.

An unavailable panel reports its missing definition. It works again when the same package definition returns.

See [Security](/security/) for the package execution boundary.
