# Effect server migration map

This document records the completed server migration and its final boundary audit.
It is an internal architecture map, not a supported user contract.

## Target state

The server core composes domain workflows as `Effect` values.
Expected domain failures use the Effect error channel.
Unexpected failures remain defects.
Infrastructure adapters wrap Promise libraries only at their ports.
HTTP, WebSocket, CLI, terminal-host, and process code execute the final Effects.
One application layer owns all services, fibers, queues, and resource scopes.

## Current Effect-native code

- `services/infrastructure/mutation-coordinator.ts` provides scoped keyed FIFO execution.
- `services/infrastructure/mutation-locks.ts` provides atomic project and worktree admission state.
- `services/infrastructure/application-runtime.ts` creates one `ManagedRuntime` and adapter layer.
- `services/infrastructure/application-lifecycle.ts` owns startup recovery and queue draining as Effects.
- `ApplicationDaemons` owns repeating process work separately from finite accepted workflows; application-update polling uses an Effect `Schedule` and is interrupted with the runtime scope.
- `services/infrastructure/ports.ts` defines tags for existing infrastructure adapters.
- `services/project/project-store.ts` provides typed Effect reads for durable project, worktree, and operation state.
- `ProjectFolderIdentities` owns observed folder identity state in a scoped `Ref`; updates use immutable map snapshots and teardown clears retained state.
- `services/project/project-observation-service.ts` validates paths and reconciles projects in the Effect graph.
- `services/project/project-snapshot-service.ts` shares concurrent snapshots with `Deferred` and composes observation and enrichment Effects.
- `services/project/project-registration-service.ts` composes repository and folder registration with native locks and observation coordination.
- `services/project/project-service.ts` and `project-directory-service.ts` expose project reads, path resolution, directory browsing, and mutations as typed Effects.
- Project update, refresh, open, close, recent dismissal, and deletion workflows use native locks and coordinators.
- `services/terminal/terminal-service.ts` composes terminal discovery, creation, mutation, and shutdown with native coordinators and lock finalizers.
- `services/terminal/terminal-state.ts` owns the terminal observation cache in the application scope with a `Ref` and deterministic teardown.
- `services/tree-file/tree-file-service.ts` composes authorization, bounded listing and search, scoped reads, and coordinated writes as Effects.
- `services/package/package-service.ts` composes package operations, permission cleanup, runtime disposal, and project events as Effects.
- `services/panel/panel-service.ts` and `panel-definition-service.ts` compose browser panels, web panels, permissions, storage, listeners, and asset resolution as typed Effects.
- Domain services consumed by other workflows are provided as `PanelOperations`, `ProjectObservationOperations`, `ProjectSnapshotOperations`, `TerminalOperations`, `WorktreeOperations`, and `WorktreeReconciliation` context services.
- Package cleanup, project snapshots, tree-file authorization, terminal workflows, reconciliation, and recovery compose those tagged services without callback dependency graphs.
- `package-system.ts` uses scoped `PackageMutations` workers for per-settings-scope coordination instead of Promise tails.
- Terminal metadata writes, terminal attachment protocol operations, and terminal file uploads use native mutation coordinators.
- Terminal-host writes now return their request completion to the attachment workflow; asynchronous host failures produce `INPUT_FAILED` and disconnect the controller instead of being silently dropped.
- `services/worktree/worktree-creation-service.ts` composes tree creation as an Effect workflow.
- `services/worktree/worktree-removal-service.ts` composes preview, admission, durable removal, recovery, and cleanup as Effects.
- `services/worktree/worktree-reconciler.ts` composes identity recovery, discovery, retirement, and persistence as an Effect.
- `core/command.ts` provides an interruptible Effect command operation.

The mutation coordinator uses `Queue`, `Deferred`, `SynchronizedRef`, and `FiberSet`.
Its scope interrupts owned workers.
The web-panel runtime uses `acquireRelease` and closes with the application runtime.

## Composition root and boundary execution

- `TreeportService` is the single composition owner for the server domain APIs and the `ManagedRuntime` created by `makeApplicationRuntime`.
- Domain API getters expose Effect-returning operations only; the duplicated Promise façade has been removed.
- `TreeportService.runEffect` is the boundary interpreter used by HTTP, WebSocket, browser-session, terminal-attachment, and terminal-metadata adapters.
- Process startup and shutdown execute lifecycle Effects directly against the same runtime.
- The Promise mutation and lock adapters have been removed.

Domain services are stateless workflow definitions. Their cross-service dependencies are Context services supplied by the application layer rather than constructor callback objects.

## Promise and mixed domain workflows

| Area                  | Main files                                    | Migration risk                                                                                                          |
| --------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Worktree creation     | `worktree-creation-service.ts`                | Effect-native workflow; terminal-host and filesystem Promise APIs are wrapped at their ports                            |
| Worktree removal      | `worktree-removal-service.ts`                 | Effect-native workflow; terminal-host, Git, and filesystem Promise APIs are wrapped at their ports                      |
| Reconciliation        | `worktree-reconciler.ts`                      | Effect-native workflow composed directly by project observation and registration                                        |
| Application lifecycle | `application-lifecycle.ts`, `server/index.ts` | Effect-native recovery and draining; process resources close through one scope after HTTP and Socket.IO stop            |
| Terminal lifecycle    | `terminal-service.ts`, terminal-host files    | Workflows, attachment coordination, cache ownership, metadata subscriptions, and host client disposal are scoped        |
| Project lifecycle     | files in `services/project`                   | Effect-native; filesystem, Git, and database Promises are wrapped at infrastructure operations                          |
| Package lifecycle     | `package-system.ts`, `package-service.ts`     | Effect-native orchestration and coordination; filesystem, npm, and manifest loaders remain Promise infrastructure       |
| Panels                | files in `services/panel`                     | Effect-native; filesystem, database, listener discovery, and Vite Promise APIs are wrapped at infrastructure operations |
| Tree files            | `tree-file-service.ts`                        | Effect-native; open read/write handles use interruption-safe finalizers                                                 |
| Terminal presets      | `terminal-preset-service.ts`                  | Effect-native; repository and package loaders remain infrastructure Promise operations                                  |

Pure normalization, mapping, serialization, validation, and path calculations remain ordinary TypeScript.

## Resource and concurrency ownership

| Resource or state                     | Current owner                               | Lifecycle treatment                                                                    |
| ------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Mutation workers                      | Scoped application runtime                  | Native workflows enqueue Effects directly                                              |
| Mutation lock state                   | Application runtime                         | Native workflows compose lock admission and finalizers directly                        |
| Application update polling            | `ApplicationDaemons`                        | A scheduled scoped fiber replaces detached timers and is interrupted at shutdown       |
| Recovered removals                    | `ApplicationFibers` and `WorktreeMutations` | Scoped fibers own recovery and queue draining                                          |
| Background creations                  | `ApplicationFibers` and `WorktreeMutations` | Scoped fibers own work after the request returns                                       |
| Background removals                   | `ApplicationFibers` and `WorktreeMutations` | Scoped fibers own accepted removal work                                                |
| Web-panel development servers         | `WebPanelViteRuntime` layer                 | Disposal is scoped and package workflows access it through the infrastructure port     |
| HTTP, Socket.IO, Vite                 | `server/index.ts`                           | Framework shutdown remains at the process boundary before scope closure                |
| Ownership, database, browser sessions | Process resource scope                      | `acquireRelease` finalizers close in reverse acquisition order                         |
| Terminal-host client                  | Process resource scope                      | Client disposal runs after application drain and before database closure               |
| Terminal observation cache            | Scoped `TerminalState`                      | `Ref` updates are atomic and its finalizer clears retained state                       |
| Observed folder identities            | Scoped `ProjectFolderIdentities`            | `Ref` snapshots replace the manually shared mutable map                                |
| Terminal metadata manager             | Process resource scope                      | `acquireRelease` initializes subscriptions and disposes and drains them on scope close |
| Terminal metadata writes              | `TerminalMetadataMutations`                 | Scoped keyed workers serialize persisted bell state changes                            |
| Terminal attachment operations        | `TerminalAttachmentMutations`               | Scoped keyed workers replace detached Promise operation tails                          |
| Terminal file uploads                 | `TerminalUploadMutations`                   | One scoped worker preserves quota/pruning serialization and drains at shutdown         |
| Package settings/install coordination | Scoped `PackageMutations`                   | Keyed workers isolate global and per-project package changes                           |

## Completed migration order

1. Move execution to HTTP, WebSocket, CLI, terminal-host, child-process, and process boundaries.
2. Remove the compatibility façade after all callers use Effect entry points.
3. Audit infrastructure Promise adapters and retain only the ports justified below.
4. Replace generic Promise coordination and detached lifecycle work with scoped Effect ownership; retain only protocol-specific browser/IPC sequencing at those adapters.
5. Complete the prompt-to-artifact audit, targeted tests, workspace typecheck, and `pnpm ci:local`.

After each slice, run its integration tests and the node typecheck.
Inspect lock release, interruption, durable operation state, events, and returned errors.
Optional filesystem probes catch only Promise rejections; Effect interruption is not converted into a missing-path result. Worktree creation propagates interrupted terminal/setup work instead of degrading it into a partial-success result, and removal cleanup preserves interruption while retaining durable failure reporting.
Run `pnpm ci:local` only after all slices pass their targeted checks.

## Non-Effect server file audit

The following production files intentionally do not import Effect. Each is either pure/configuration code or an external/application boundary. This list is reviewed from file contents, not treated as an import-count completion signal.

| Files                                                                                                                                    | Classification and reason                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser-sessions.ts`, `playwright-browser.ts`                                                                                           | Socket/Playwright application adapters. Their Promise APIs, browser callbacks, protocol-specific coalescing, and screencast ordering stay at this boundary; the manager itself is acquired and disposed by the process scope. |
| `socket-server.ts`                                                                                                                       | Socket.IO boundary. It converts final domain Effects with `TreeportService.runEffect` and translates failures to socket disconnect/protocol behavior.                                                                         |
| `terminal-host-client.ts`, `terminal-host-server.ts`, `terminal-host-sessions.ts`, `terminal-host-entry.ts`, `terminal-host-protocol.ts` | Separate terminal-host process and IPC/PTY boundary. Request framing, callback-driven PTY parsing, and Promise IPC remain local to the port; startup and shutdown are explicit process boundaries.                            |
| `config.ts`, `domain.ts`, `events.ts`, `index.ts`, `loopback.ts`, `web-panel-csp.ts`, `request-security.ts`                              | Pure configuration, domain data/error definitions, synchronous event dispatch, exports, and security transformations.                                                                                                         |
| `database-schema.ts`, `database.ts`, `terminal-bell-state-store.ts`                                                                      | Drizzle/SQLite persistence port and schema/migration code. Domain workflows call it from Effects; database compatibility stays here.                                                                                          |
| `gh.ts`, `git.ts`, `network-listeners.ts`, `preflight.ts`                                                                                | GitHub, Git, operating-system process inspection, and prerequisite ports backed by commands/filesystem Promises.                                                                                                              |
| `jsonc.ts`, `repository-terminal-presets.ts`, `setup.ts`, `shell-integration.ts`, `tree-context.ts`, `zed.ts`                            | Pure parsing/path logic plus filesystem-backed configuration loaders used as infrastructure operations by Effect workflows.                                                                                                   |
| `launcher.ts`                                                                                                                            | Child-process launcher executable and process exit boundary.                                                                                                                                                                  |
| `web-panel-vite-runtime.ts`                                                                                                              | Vite/npm/filesystem infrastructure resource; its lifetime is acquired and released by the application layer.                                                                                                                  |
| `daemon-ownership.ts`, `update-startup.ts`                                                                                               | Process startup ownership and update handoff ports, acquired by the process resource scope.                                                                                                                                   |
| `terminal.ts`                                                                                                                            | Terminal port types and pure launch-shape construction.                                                                                                                                                                       |
| `test-access.ts`                                                                                                                         | Test-only assertion utility; it is not production wiring.                                                                                                                                                                     |

Mixed files retain Promise calls only at explicit edges:

- `app.ts`, `socket-server.ts`, `index.ts`, `terminal-attachments.ts`, and `terminal-metadata.ts` are HTTP, WebSocket, process, and terminal adapter boundaries.
- `application-update.ts` exposes Promise operations to HTTP but owns polling as a scheduled Effect daemon.
- `core/command.ts` is the child-process infrastructure boundary; its Promise entry is consumed by Promise-based Git/npm adapters while `runEffect` owns interruption-safe child lifecycle semantics.
- `core/service.ts` contains the sole ManagedRuntime interpreter used by application boundaries.
- `package-system.ts`, `panel-definition-service.ts`, `project-registration-service.ts`, `tree-file-service.ts`, and the worktree services wrap npm, Vite, filesystem, Git, terminal-host, and database Promise operations inside their surrounding domain Effects.

## Prompt-to-artifact completion checklist

| Requirement                                                                                                   | Evidence                                                                                                                                                                                                                                                                                                                      | Status   |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Recorded migration map before/through slices                                                                  | This document's Effect-native, boundary, concurrency, and file-audit sections                                                                                                                                                                                                                                                 | complete |
| Effect-returning domain workflows with typed expected failures                                                | Services under `core/services/{project,worktree,terminal,panel,package,tree-file}`; `DomainError` remains in their Effect error channels                                                                                                                                                                                      | complete |
| Context tags, Layers, and one composition owner                                                               | `domain-services.ts`, `ports.ts`, `application-runtime.ts`, and `TreeportService`                                                                                                                                                                                                                                             | complete |
| Scoped queues, refs, fibers, schedules, and finalizers                                                        | Mutation coordinators, `MutationLocks`, `TerminalState`, `ProjectFolderIdentities`, `ApplicationFibers`, `ApplicationDaemons`, scheduled update polling, and process `Scope`                                                                                                                                                  | complete |
| Effects execute only at application boundaries                                                                | Final production search limits runtime execution to process entry (`index.ts`), child-process command port (`core/command.ts`), and the sole ManagedRuntime interpreter; adapters use `TreeportService.runEffect`                                                                                                             | complete |
| Remove Promise mutation/lock bridges, nested domain runtime execution, callback dependency graphs, and façade | Repository search has no `PromiseMutationQueue` or `PromiseMutationLocks`; top-level Promise domain methods were removed from `TreeportService`; domain services contain no `runPromise`                                                                                                                                      | complete |
| Preserve HTTP/WebSocket/CLI/database/recovery/terminal/security behavior                                      | Existing API, socket, terminal, lifecycle, package, folder, observation, worktree, packaged CLI, and desktop suites                                                                                                                                                                                                           | complete |
| Creation/removal/recovery/concurrency/shutdown coverage                                                       | `service-worktree.integration.test.ts` covers durable creation, removal, recovery, FIFO coordination, and drain; `service-lifecycle.integration.test.ts` covers cross-domain coordination; `terminal-host-lifecycle.integration.test.ts` covers normal/crashed restart; coordinator and daemon tests cover scope interruption | complete |
| Relevant tests and typechecks                                                                                 | Node and workspace typechecks; targeted unit/integration tests; full unit and integration suites                                                                                                                                                                                                                              | complete |
| `pnpm ci:local`                                                                                               | Full local PR gate, including knip, formatting, lint, workspace typechecks, 291 unit tests, 75 integration tests, 2 desktop tests, package smoke tests, and docs build                                                                                                                                                        | passed   |
| Final diff and boundary audit                                                                                 | This file audit plus final `rg`, `git diff --check`, and generated-output review                                                                                                                                                                                                                                              | complete |

## Intentional final boundaries

The final audit can retain Promise code only for these reasons:

- A third-party adapter exposes only a Promise API.
- An application boundary must return a Promise to its framework.
- A process or child-process boundary requires callbacks or events.
- A transformation is pure and synchronous, so it does not need Effect.

The final audit must name each retained file and its reason.

## Verification record

- `pnpm test:unit`: 53 files and 291 tests passed.
- `pnpm test:integration`: 6 files and 75 tests passed.
- `pnpm typecheck`: all 11 workspace build/typecheck tasks passed.
- Targeted HTTP/WebSocket/terminal suite: 6 files and 56 tests passed before the final full gate.
- Targeted core integration suite: 5 files and 73 tests passed before the final full gate.
- `pnpm ci:local`: passed in full, including desktop, package-install/update smoke, and documentation checks.
- `pnpm knip`, `oxfmt --check`, `oxlint`, `git diff --check`, the production runtime-execution search, and the transitional adapter search all passed their final audit.
- Generated build output and unrelated frontend files are absent from the source diff.
