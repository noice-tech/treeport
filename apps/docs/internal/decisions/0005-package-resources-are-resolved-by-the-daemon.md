# Decision 0005: Package resources are resolved by the daemon

- Status: Accepted
- Date: 2026-08-04

## Context

Treeport needs reusable web panels and terminal presets at global and repository scope. The daemon serves remote clients, owns persistent panel rows, and launches terminals for every linked worktree. Resource consumers therefore cannot independently scan npm installations or worktree-local settings without creating inconsistent identities, duplicated installs, and unsafe asset boundaries.

Pi's package manager, settings manager, and resolve-then-load resource architecture provide a mature model for global/project sources, manifests, conventions, filtering, package identity, and `autoload: false` deltas. Treeport needs those semantics but not Pi's privileged extension execution.

## Decision

The main daemon owns one package system boundary. It reads global desired state from `<data-dir>/settings.json` and repository desired state only from the registered main worktree's `.treeport/settings.json`. Registration is the authorization boundary for reading repository settings. Linked worktrees never receive separate package installations or settings precedence.

The boundary parses settings without partially mutating live state, reconciles managed npm roots, resolves package manifests and conventions, validates individual resources, applies filters and scope deduplication, and atomically replaces source-aware effective registries. Web-panel and terminal-preset code consume resolved definitions and do not contain npm or settings logic.

Npm identity is its package name without version. Local identity is the canonical resolved directory. Durable resource IDs use that package identity (or a stable hash of a canonical local identity), resource type, and package-relative resource name; versions and managed installation paths are excluded.

Each effective resource retains its configured source, global or project scope, package identity and root, enabled state, and diagnostics. A normal project entry replaces the matching global package. A project `autoload: false` entry changes enabled state over the inherited global package; without a global match it starts with an empty enabled set.

## Reconciliation and failure behavior

Package operations are serialized per global or project scope. Install validates and installs before persisting desired state. Removal updates only the matching managed dependency and source. Reload installs missing dependencies but does not move an already installed unpinned npm package. Explicit update skips exact versions and is the only operation that moves unpinned versions.

Settings fingerprints are checked on resource lookup. Daemon initialization, registration, reopen, explicit reload, and changed fingerprints reconcile the relevant scope. The package-manager lockfile remains the dependency lock; Treeport does not introduce another package lock format.

Malformed settings preserve the previous valid scoped registry. A package install or package-level load failure preserves the previous resolved package when one exists. Invalid individual resources produce diagnostics and are omitted while valid resources continue loading. Unrelated user presets, direct project panels, shells, and packages remain available.

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

- Global resources are consistently available to every registered project, while repository resources apply to every worktree of only that repository.
- Remote clients receive the same definitions and provenance as local clients without accessing package files themselves.
- Package resource IDs, panel storage, and existing terminal processes survive updates and temporary package loss.
- Package management remains CLI-only in V1; the web UI consumes resources and displays provenance but does not edit package desired state.
- Future direct repository presets, additional declarative resources, and source kinds can reuse the resolver boundary without coupling their consumers to npm.
