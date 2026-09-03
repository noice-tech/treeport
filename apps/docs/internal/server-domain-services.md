# Server domain services

`apps/treeport/src/server/core/service.ts` is a compatibility façade and composition root. New HTTP code should call the domain APIs exposed by the façade (`projects`, `worktrees`, `terminals`, `terminalPresets`, `panels`, `treeFiles`, and `packageManagement`) instead of adding workflows to `TreeportService`.

## Boundaries

- `services/project` owns project persistence, registration, snapshots, availability, and lifecycle. Registration and snapshot collection are separate workflow modules.
- `services/worktree` owns linked-tree creation, durable removal/recovery, and Git worktree reconciliation. Creation and removal have independent workflow modules behind `WorktreeService`.
- `services/terminal` owns terminal inventory, lifecycle state, and terminal presets.
- `services/panel` owns browser/web panels. Definition resolution, permissions, and launch normalization are separated from panel instances and storage.
- `services/tree-file` owns authorized no-follow reads and revision-checked writes.
- `services/package` coordinates package mutations and invalidation of package-provided resources.

The façade remains Promise-compatible for socket, metadata, and other existing callers while HTTP handlers use the domain APIs directly.

## Effect runtime and concurrency

`services/infrastructure/application-runtime.ts` creates the one application `ManagedRuntime`. Adapter values are registered with Effect tags for configuration, database, commands, Git, GitHub, terminal host, events, packages, network listeners, and the web-panel runtime. The web-panel runtime is acquired by a scoped layer and disposed when the application runtime closes.

`MutationCoordinator` is a scoped keyed FIFO executor built from `Queue`, `Deferred`, `SynchronizedRef`, and `FiberSet`. Each key has one worker; different keys may run concurrently. Draining waits for both queued and running work, and closing the runtime interrupts owned workers. Separate coordinators own project worktree mutations, terminal mutations, tree-file writes, project observations, and terminal metadata persistence.

`MutationLocks` stores project/worktree admission state in `SynchronizedRef`. Multi-key acquisition is atomic. A worktree operation can also check a project lock without acquiring the project key, preserving terminal and removal admission behavior.

## Required behavioral invariants

- Worktree mutations are FIFO by project, with cross-project concurrency.
- Creation retains its project queue slot through setup and terminal provisioning, while releasing the destructive project lock after Git discovery.
- Removal waits behind terminal and project work, then keeps the worktree unavailable until durable completion or recovery.
- Project close/delete remain fail-fast when conflicting work is already admitted.
- Terminal creation is FIFO by worktree; rename/delete retain project serialization and the last-terminal invariant.
- Project observation is FIFO by project; snapshots coalesce and retry when invalidated during collection.
- Tree-file writes are FIFO by canonical path and preserve no-follow, UTF-8, size, and revision checks.
- Shutdown drains all mutation coordinators before the application runtime closes its scope.
