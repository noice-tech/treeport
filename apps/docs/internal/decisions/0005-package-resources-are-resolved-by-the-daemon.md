# Decision 0005: Package resources are resolved by the daemon

- Status: Accepted
- Date: 2026-08-04

## Context

Treeport needs reusable web panels and terminal presets at global and repository scope. The daemon serves remote clients, owns persistent panel rows, and launches terminals for every linked worktree. Resource consumers therefore cannot independently scan npm installations or worktree-local settings without creating inconsistent identities, duplicated installs, and unsafe asset boundaries.

Pi's package manager, settings manager, and resolve-then-load resource architecture provide a mature model for global/project sources, manifests, conventions, filtering, package identity, and `autoload: false` deltas. Treeport needs those semantics but not Pi's privileged extension execution.

## Decision

The main daemon owns resource resolution. Its package system reads global desired state from `<data-dir>/settings.json` and repository package desired state only from the registered main worktree's `.treeport/settings.json`. Direct repository terminal presets instead follow direct web-panel semantics: the daemon resolves `.treeport/terminal-presets.json` from the worktree where the terminal will launch. The Zed task compatibility source is a deliberate exception: the daemon resolves `.zed/tasks.json` from the registered main worktree, matching the authority already used by Zed-compatible worktree setup, and resolves each task for the selected target worktree. Registration is the authorization boundary for reading repository configuration. Linked worktrees never receive separate package installations or package-settings precedence, but their native direct resources follow the files on their own branches.

The package boundary parses settings without partially mutating live state, reconciles managed npm roots, resolves package manifests and conventions, validates individual resources, applies filters and scope deduplication, and atomically replaces source-aware effective registries. The direct repository preset loader validates its versioned root and each keyed definition independently on every definition request. Web-panel and terminal-preset consumers receive combined source-aware definitions and do not contain npm, settings, or repository-file parsing logic.

Npm identity is its package name without version. Local identity is the canonical resolved directory. Durable resource IDs use that package identity (or a stable hash of a canonical local identity), resource type, and package-relative resource name; versions and managed installation paths are excluded.

Each effective resource retains its configured source, global or project scope, package identity and root, enabled state, and diagnostics. A normal project entry replaces the matching global package. A project `autoload: false` entry changes enabled state over the inherited global package; without a global match it starts with an empty enabled set.

## Reconciliation and failure behavior

Package operations are serialized per global or project scope. Install validates and installs before persisting desired state. Removal updates only the matching managed dependency and source. Reload installs missing dependencies but does not move an already installed unpinned npm package. Explicit update skips exact versions and is the only operation that moves unpinned versions.

Settings fingerprints are checked on resource lookup. Daemon initialization, registration, reopen, explicit reload, and changed fingerprints reconcile the relevant scope. The package-manager lockfile remains the dependency lock; Treeport does not introduce another package lock format.

Malformed package settings preserve the previous valid scoped registry. A package install or package-level load failure preserves the previous resolved package when one exists. Invalid individual package resources produce diagnostics and are omitted while valid resources continue loading.

Direct repository sources deliberately do not preserve stale definitions. A malformed native or Zed task file omits only that source's definitions until fixed; an invalid keyed preset or indexed task omits only that entry. These failures produce diagnostics while the other direct source, user presets, package presets, and shells remain available. Re-reading on each definition request lets remote clients observe the relevant selected- or main-worktree file through their normal refresh cycle.

Persistent web-panel rows and storage are references to durable definition IDs, not installed files. Package removal makes the definition unavailable but never cascades to those rows. Running terminals already contain literal argv and have no ongoing package dependency.

## Safety boundary and deliberate differences from Pi

Treeport V1 packages are declarative resources, not daemon extensions:

- npm and supported wrapper invocations always disable lifecycle scripts;
- packages cannot load daemon modules or register hooks;
- preset commands run only after explicit selection;
- web JavaScript runs only when a panel is opened, inside the existing scoped iframe runtime;
- package resource discovery is constrained by the manifest or conventions;
- every served asset is canonicalized and must remain inside its declared panel root;
- git and temporary package sources are not accepted in V1;
- automatic background version movement is forbidden.

This intentionally borrows Pi's package semantics while applying a smaller execution surface suitable for a persistent multi-project daemon.

## Consequences

- Global resources are consistently available to every registered project. Repository package resources and main-worktree Zed tasks apply to every worktree of only that repository, while native direct repository resources follow each worktree's checked-out files.
- Remote clients receive the same definitions and provenance as local clients without accessing package files themselves.
- Package resource IDs, panel storage, and existing terminal processes survive updates and temporary package loss.
- Package management remains CLI-only in V1; the web UI consumes resources and displays provenance but does not edit package desired state.
- Direct repository presets and future declarative source kinds reuse daemon resource composition without coupling their consumers to npm.
