# Decision 0005: The daemon resolves package resources

- Status: Accepted
- Date: 2026-08-04

## Context

Treeport needs reusable web panels and terminal presets at global and repository scope.

The daemon serves remote clients, owns persistent panel records, and starts terminals for all linked worktrees.

Resource consumers cannot separately scan npm installations or worktree settings.

Separate scans can cause different identities, duplicate installations, and unsafe asset boundaries.

Pi supplies a useful model for package sources, manifests, conventions, filters, package identity, and `autoload: false` changes.

Treeport needs these package behaviors without privileged extension execution.

## Decision

The main daemon resolves all resources.

It reads global package settings from `<data-dir>/settings.json`.

It reads repository package settings only from `.treeport/settings.json` in the main worktree.

Direct terminal presets use different source rules.

The daemon reads `.treeport/terminal-presets.json` from the worktree where the terminal will start.

Zed tasks are an intentional exception. The daemon reads `.zed/tasks.json` from the main worktree.

This rule is the same as Zed-compatible worktree setup.

The daemon resolves each Zed task for the selected worktree.

Repository registration authorizes these configuration reads.

Linked worktrees do not have separate package installations or package setting priority.

However, their direct native resources follow their branch files.

The package boundary performs these operations:

- parse settings without a partial live-state change;
- update managed npm roots;
- resolve package manifests and standard directories;
- validate each resource;
- apply filters and scope de-duplication;
- replace source-aware effective registries as one operation.

The direct repository preset loader validates the versioned root and each keyed definition independently.

Web panel and terminal preset consumers receive combined source-aware definitions.

They do not parse npm, settings, or repository files.

An npm package identity is its name without a version.

A local package identity is its canonical directory.

Durable resource IDs use this package identity, resource type, and relative resource name.

For a canonical local identity, the ID uses a stable hash.

Resource IDs do not include versions or managed installation paths.

Each effective resource keeps this information:

- configured source;
- global or project scope;
- package identity and root;
- enabled state;
- diagnostics.

A standard project entry replaces the same global package.

A project entry with `autoload: false` changes the enabled state of an inherited global package.

Without a global match, this entry starts with no enabled resources.

## Updates and failures

Treeport serializes package operations for each global or project scope.

Install validates and installs a package before it saves the requested state.

Removal changes only the matching managed dependency and source.

Reload installs missing dependencies. It does not update an installed npm package that is not pinned.

Only explicit update changes an unpinned version. It skips exact versions.

Treeport checks setting fingerprints during resource lookup.

It updates the applicable scope at these times:

- daemon initialization;
- repository registration;
- repository reopen;
- explicit reload;
- a fingerprint change.

The package-manager lockfile stays as the dependency lock. Treeport does not add another package lock format.

Invalid package settings keep the prior valid registry for that scope.

A package install or load failure keeps the prior package definition when one exists.

Treeport reports an invalid individual resource and omits it. Other valid resources continue to load.

Direct repository sources do not keep old definitions.

An invalid native or Zed file omits only definitions from that source until correction.

An invalid native preset or Zed task omits only that entry.

Other direct resources, user presets, package presets, and shells stay available.

The daemon reads these files for each definition request. Remote clients receive changes through their standard refresh cycle.

Persistent panel records and storage refer to durable definition IDs, not installed files.

Package removal makes a definition unavailable but does not remove persistent records.

An active terminal already has literal arguments. It does not continue to depend on its package.

## Safety boundary

Treeport V1 packages contain declarative resources, not daemon extensions:

- Treeport disables lifecycle scripts for npm and supported wrappers.
- A package cannot load daemon modules or register hooks.
- A preset starts only after explicit user selection.
- Panel JavaScript starts only when a user opens the panel.
- Panel JavaScript stays in the scoped iframe runtime.
- Package discovery stays in manifest or standard-directory boundaries.
- Each asset must stay in its declared canonical panel root.
- V1 does not accept Git or temporary package sources.
- Automatic package version changes are not permitted.

This model uses Pi package behavior with a smaller execution surface for a persistent daemon.

## Consequences

- Global resources are available to all registered projects.
- Repository packages and Zed tasks apply to all worktrees in one repository.
- Direct native resources follow each worktree branch.
- Local and remote clients receive the same definitions and source information.
- Resource IDs, panel storage, and active terminals continue after updates and temporary package loss.
- V1 package management uses only the CLI.
- The web interface uses resources and shows their sources, but it does not change package state.
- New declarative sources can use daemon resource composition without a dependency on npm.
