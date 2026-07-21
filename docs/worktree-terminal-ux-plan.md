# Zed-Compatible Worktree and Terminal UX Plan

## Objective

Make term-manager usable alongside Zed by adopting Zed's worktree identity and filesystem conventions, simplifying worktree removal, fixing terminal scrolling, and using one source of truth for terminal titles.

This plan preserves SQLite, TanStack Query, tmux, and the resumable terminal-session architecture. Existing worktrees are imported in place and are never moved.

## Confirmed product decisions

- New worktrees use Zed's detached worktree model and directory layout.
- Honor project-local `.zed/settings.json` `git.worktree_directory`, defaulting to `../worktrees`.
- Run project `.zed/tasks.json` tasks whose hooks include `create_worktree`.
- Replace Finish and Discard with one **Remove worktree** action.
- Clean removal uses an ordinary confirmation.
- Dirty/untracked worktrees and detached commits at risk of becoming unreachable use a destructive warning dialog, but do not require typing the worktree name.
- Removing a worktree never deletes an attached Git branch.
- Remove the old Finish, Discard, bulk-cleanup, and diagnostics surfaces from web, API, and CLI now; do not retain compatibility aliases.
- Move **New worktree** to the final row of each expanded project's worktree list.
- Runtime terminal titles remain volatile client/runtime state; SQLite retains the configured terminal name as a fallback.

## What detached means

A detached worktree has `HEAD` pointing directly at a commit rather than at a local branch. This is normal for current Zed-created worktrees. The worktree's human-facing name is independent of its Git branch, and a branch may be created or selected later.

The UI must therefore stop treating `"(detached)"` as a worktree name or as an error state.

## Observed local layout

Zed's default single-repository layout is:

```text
~/Projects/<repo>                                      # main checkout
~/Projects/worktrees/<repo>/<worktree-name>/<repo>     # linked checkout
```

For a path such as:

```text
~/Projects/worktrees/remotion-main/element-og-images/remotion-main
```

`element-og-images` is the worktree name and the final `remotion-main` directory is the Git checkout root and terminal working directory.

Expected imported names from the inspected repositories:

### `remotion-main`

- `element-live-strap`
- `element-og-images`
- `kimi-plugin`
- `repo-cloning-issue`

### `banger.show`

- `test` — legacy non-Zed layout
- `perf-optimization-round`
- `pi-release-notes`
- `react-19`
- `shader-benchmarks`
- `typescript-7`

## 1. Correct the worktree model

Represent worktree identity separately from Git state:

```ts
interface WorktreeRecord {
  id: string
  projectId: string
  name: string
  path: string
  head: string
  branch: string | null
  detached: boolean
  locked: boolean
  kind: 'main' | 'linked'
  // existing runtime/status fields
}
```

### Git discovery

Extend `git worktree list --porcelain` parsing to retain:

- canonical path
- HEAD SHA
- nullable branch
- detached state
- locked state and optional lock reason
- bare/prunable state

Do not encode detached HEAD as the string `"(detached)"`.

### Zed-compatible name inference

Use the same path-based rule as Zed:

1. Main checkout: display `main worktree`.
2. For a linked checkout, compare its basename with the main checkout basename.
3. If they differ, use the linked checkout basename.
4. If they are equal, use the linked checkout's parent basename.

Examples:

```text
main:   /Projects/remotion-main
linked: /Projects/worktrees/remotion-main/kimi-plugin/remotion-main
name:   kimi-plugin

main:   /Projects/banger.show
linked: /Projects/banger.show__worktrees/test
name:   test
```

Canonical path and generated ID remain identity. Name and branch must not be used as keys.

### Persistence

Add append-only SQLite migrations for nullable branch and HEAD/lock metadata. Do not edit migration 1. Existing linked worktrees must be refreshed from Git after migration. Derived display names do not need to trigger filesystem moves.

## 2. Replace git-gtr creation with native Git

The current `git gtr new <branch>` flow couples directory names to branches and cannot create Zed's nested detached layout. Replace creation and removal with argv-safe methods on `GitAdapter`.

Create using:

```bash
git worktree add --detach -- <target-path> <resolved-base>
```

### Creation request

Replace the branch-oriented request with:

```ts
{
  name: string;
  base: "default" | "current";
  sourceWorktreeId?: string;
  initialTerminal?: { name: string; argv?: string[] };
}
```

The web form contains:

- **Worktree name**
- **Start from**: project default branch or currently selected worktree
- resolved destination preview

There is no branch-name field. `fromCurrent` chooses a base commit; it does not create or select a branch named after the worktree.

### Name validation

- trim whitespace
- replace spaces with hyphens
- reject empty names, `.` and `..`
- reject `/`, `\\`, control characters, and traversal
- cap length
- reject an existing inferred name or target path, including case-insensitive collisions on case-insensitive filesystems

### Base resolution

- Default: fetch/resolve the remote default branch and pin its commit SHA before creation.
- Current: resolve the selected source worktree's `HEAD` SHA before creation.
- Pass the resolved SHA to `git worktree add --detach` so concurrent branch movement cannot change the checkout unexpectedly.

## 3. Implement Zed path resolution

Read project-local JSONC from:

```text
<main-worktree>/.zed/settings.json
```

Support `git.worktree_directory`, with `../worktrees` as the default.

Follow Zed's restrictions:

- setting must be relative
- it must not be empty or exactly `..`
- resolved directory must remain inside the main checkout or beneath its parent
- when the resolved root is outside the checkout, append the repository directory name to create a repository-scoped base

Then construct:

```text
<repository-scoped-base>/<worktree-name>/<repository-directory-name>
```

For the default:

```text
/Projects/remotion-main + ../worktrees
→ /Projects/worktrees/remotion-main
→ /Projects/worktrees/remotion-main/<name>/remotion-main
```

Add a direct JSONC parser dependency rather than implementing comment stripping manually.

## 4. Run Zed create-worktree hooks

After Git successfully creates the checkout, read the main checkout's `.zed/tasks.json` and select tasks containing:

```json
"hooks": ["create_worktree"]
```

Support this initial task subset:

- `command`
- `args`
- `cwd`
- `env`
- `hooks`

Provide:

```text
ZED_WORKTREE_ROOT=<new linked checkout root>
ZED_MAIN_GIT_WORKTREE=<main checkout root>
```

Expand these variables in command, arguments, cwd, and env. Execute hook tasks sequentially so setup ordering is deterministic. Preserve shell behavior for commands containing pipelines or `&&`.

Fields such as `reveal`, `hide`, and `save` are UI concerns and may be ignored.

Hook failures must:

- leave the successfully created worktree registered and visible
- return a bounded, user-readable setup error
- avoid silently deleting source code or the checkout
- prevent an automatic initial terminal from starting until setup has completed

Project-local hooks are in scope. Global Zed task configuration is not required in this pass.

## 5. Introduce one removal engine

Replace Finish and Discard with:

```text
GET  /api/worktrees/:worktreeId/remove-preview
POST /api/worktrees/:worktreeId/remove
```

The preview includes:

- worktree name and path
- nullable branch and short HEAD SHA
- detached/locked state
- dirty, staged, unstaged, untracked, and conflict counts
- whether detached HEAD is reachable from any branch, tag, or remote ref
- every terminal that will be terminated
- whether force is required

### Safety rules

- Main checkout: always refuse.
- Locked worktree: refuse; do not unlock automatically.
- Clean attached worktree: remove immediately after an eligible, warning-free signed preview.
- Clean unmerged attached branch: allow; preserve the branch.
- Dirty, untracked, or conflicted worktree: destructive warning, then `--force`.
- Detached HEAD reachable from a ref: treat like a clean worktree.
- Detached HEAD not reachable from a branch, tag, or remote ref, or with unknown reachability: warn that commits may become unreachable.
- Never delete an attached branch as part of worktree removal.

The destructive confirmation should clearly list changes/commits that may be lost. It does not require typing the worktree name.

### Execution

1. Acquire the project/worktree mutation lock.
2. Recompute preview immediately before execution.
3. Reject if the confirmation no longer matches the current destructive state.
4. Persist a pending remove operation and mark the worktree as cleaning/removing.
5. Block new terminal creation and Git mutation for the worktree.
6. Kill the worktree's entire tmux server, terminating all terminals.
7. Run:

   ```bash
   git worktree remove [--force] -- <canonical-path>
   ```

8. Mark the worktree removed only after Git no longer reports it and the exact checkout root is absent.
9. On interrupted removal, atomically quarantine and reverify the exact previously authorized checkout root, then recursively clean it only when its recorded filesystem identity, Git administrative key, stale `.git` marker, and wrapper provenance still match.
10. Remove only an empty term-manager-created wrapper directory; never recursively delete inferred parent directories for imported worktrees.
11. Reconcile browser terminal sessions and metadata.

If Git removal fails after tmux shutdown, or an interrupted checkout cannot be verified safely, mark `cleanup_failed` and explicitly report that terminals were already terminated. The sidebar keeps the row visible with preparing, removing, or failed status and blocks duplicate removal while work is pending.

### Remove old surfaces

Delete the old product/API/CLI surfaces rather than retaining aliases:

- finish preview/action
- discard preview/action
- project clean-merged preview/action
- diagnostics action/endpoint/CLI command
- associated request schemas and web client methods

Historical SQLite operation kinds may remain readable for migration compatibility, but new operations use `remove` only.

## 6. Simplify the sidebar and dialogs

### Project row

Remove project-level action icons. The header only expands/collapses the project and shows its name.

### Worktree list

- Render inferred `worktree.name` as the primary label.
- Do not render `"(detached)"` as a name.
- Keep branch, detached state, short SHA, and path in tooltip/secondary details.
- Give every linked worktree one trash action: **Remove worktree**.
- Render **New worktree** as the last list item inside each expanded project, including empty projects.
- Ensure keyboard order matches visual order.

### Sidebar footer

Keep **Add project**. Remove Diagnostics.

### Removal dialog

Use one dialog:

- title: `Remove worktree`
- list terminals that will stop
- show path, branch/detached state, dirty facts, and unreachable commits
- clean button: `Remove worktree`
- destructive button: `Remove anyway`

## 7. Fix terminal scrolling

The generated tmux config currently contains:

```tmux
set -g mouse off
```

Because tmux attachments use the alternate screen, xterm has no ordinary browser-buffer scrollback and converts wheel input into arrow keys. Enable tmux mouse handling:

```tmux
set -g mouse on
```

This allows wheel/trackpad input to reach tmux, whose default bindings enter copy mode and scroll its retained 50,000-line history.

### Existing tmux servers

Rewriting the generated config only affects new servers. Add an idempotent server-configuration method that runs explicit `set-option` commands for every discovered/attached worktree socket. Invoke it during creation, reconciliation, and attachment initialization.

Do not:

- add a second outer scroll container
- intercept wheel events in React
- disable the alternate screen
- make browser scrollback authoritative over tmux history

Viewer-only private scrolling is out of scope because tmux copy mode mutates the shared attached client state. A viewer can take control before scrolling.

## 8. Centralize terminal titles

Define two labels:

- `TerminalRecord.name`: persisted configured fallback
- runtime title: volatile tmux/xterm title

Make `TerminalSessionManager` own one immutable title snapshot:

```ts
ReadonlyMap<terminalId, string | null>
```

Expose a subscription/hook and one resolver:

```ts
runtimeTitle.get(terminal.id) ?? terminal.name
```

Use it for:

- desktop sidebar terminal rows
- mobile terminal selector
- terminal tabs
- pane and ARIA labels
- close-terminal confirmation

Remove `TerminalView`'s component-local `terminalTitles` map.

### Title lifecycle

- Deduplicate unchanged values.
- Accept title updates from the active xterm title parser and authoritative server title messages into the same store.
- Retain the last runtime title when an xterm session is evicted from the three-session LRU, as long as metadata still contains that terminal.
- Clear title state when `TerminalSessionManager.reconcile` sees that the terminal was deleted.
- Allow the server to transmit a cleared/null title so stale titles can disappear.
- Do not persist runtime titles to SQLite.

## 9. Schema, API, and CLI changes

### Shared

- update `WorktreeRecord`
- replace branch-oriented creation schema
- add remove preview/request/result schemas
- add `remove` operation kind while preserving historical rows as needed
- remove public finish/discard/cleanup/diagnostics schemas that no longer have routes

### Core

- extend porcelain parser
- add Zed name/path helpers
- add JSONC settings/task loader
- add native Git create/remove/reachability methods
- remove `GtrAdapter` from service dependencies and startup wiring
- replace cleanup state machine with the remove engine
- enable/reapply tmux mouse support

### Server

- replace old cleanup routes with remove preview/action
- remove diagnostics and project cleanup endpoints
- update create/spawn request handling
- preserve SSE invalidation for create/remove completion/failure

### CLI

- create accepts `--name` and base selection rather than `--branch`
- expose `tasktty worktree remove`
- remove finish/discard/clean/diagnostics commands
- list shows worktree name first, with branch/detached and path as secondary data

### Web

- update API client
- replace modal variants and queries
- simplify sidebar controls
- use shared title store
- add Zed-style creation form and destination preview

### Documentation

Update README examples, prerequisites, API table, worktree layout, detached semantics, hook support, removal safety, and terminal scrolling behavior. Remove git-gtr as a prerequisite.

## 10. Test plan

### Shared and database

- nullable branch and HEAD schemas
- remove request validation
- fresh database migration
- real previous-schema-to-new-schema migration
- historical operation rows remain readable

### Git/core unit tests

- parse attached, detached, locked, prunable, Unicode, and spaced paths
- infer every observed local Zed/legacy name shape
- resolve default and project-local worktree directories
- reject absolute/traversing/invalid settings and names
- exact argv for detached creation and path-based removal
- detect reachable and unreachable detached commits
- never issue branch-deletion commands

### Hook tests

- parse JSONC settings/tasks
- run both local task shapes:
  - shell command with `&&`
  - executable plus args containing Zed variables
- provide correct cwd and environment
- sequential execution
- setup failure leaves worktree registered and reports bounded errors

### Removal service tests

- refuse main and locked worktrees
- remove clean attached worktree while preserving branch
- force-remove dirty/untracked worktree after confirmation
- warn on unreachable detached commit
- kill every terminal through the worktree tmux server
- reject stale confirmation after preflight changes
- record visible partial failure after Git removal failure
- reconcile retained client terminal sessions

### tmux tests

- generated config contains `mouse on`
- existing servers receive explicit mouse configuration
- real tmux copy-mode wheel behavior where practical

### Web unit/E2E

- project header has no clean-merged action
- footer has no diagnostics action
- exactly one Remove action per linked worktree
- New worktree is the final project-list item
- create form sends name/base, not branch
- removal dialog distinguishes clean and destructive cases without typed confirmation
- WebSocket title updates tab, sidebar, mobile selector, and pane label together
- fallback terminal name is used before a runtime title exists
- wheel/trackpad no longer produces arrow-key input and scrolls tmux history

### Full validation

Run:

```text
focused unit tests
pnpm test
pnpm test:integration
pnpm test:integration:real
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm build
Playwright desktop and mobile
```

Also manually verify with registered `~/Projects/remotion-main` and `~/Projects/banger.show` without modifying or moving their existing worktrees.

## Delivery order

1. Worktree model, migration, Git porcelain, and name inference.
2. Zed path/settings resolution and native detached creation.
3. Zed create-worktree hook runner.
4. Single removal engine and old-surface deletion.
5. Sidebar/form/dialog simplification.
6. tmux scrolling fix for new and existing servers.
7. Shared runtime title store and all UI consumers.
8. Integration, E2E, real-repository smoke tests, and documentation.

## Primary risks

- SQLite table rebuilds must preserve existing dirty user metadata and historical operations.
- Zed settings/tasks are JSONC and may contain unsupported task features; unsupported fields must fail clearly or be explicitly ignored.
- Hook commands are trusted project code and may be long-running or destructive; execution and error reporting need clear bounds.
- Killing tmux before Git removal can leave a worktree present with terminals stopped if Git fails.
- Detached commits can become unreachable after removal; reachability must be checked immediately before destructive confirmation.
- Existing tmux servers do not automatically reload changed configuration.
- The repository already has extensive unstaged changes; implementation must preserve unrelated hunks and avoid reset, checkout, or stash.

## Zed references

- Zed Git worktree behavior: <https://github.com/zed-industries/zed/blob/20a3f770/docs/src/git.md>
- Zed worktree creation service: <https://github.com/zed-industries/zed/blob/20a3f770/crates/git_ui/src/worktree_service.rs>
- Zed worktree picker/name display: <https://github.com/zed-industries/zed/blob/20a3f770/crates/git_ui/src/worktree_picker.rs>
- Zed path and Git worktree model: <https://github.com/zed-industries/zed/blob/20a3f770/crates/git/src/repository.rs>
- Zed task hooks and environment: <https://github.com/zed-industries/zed/blob/20a3f770/docs/src/tasks.md>
