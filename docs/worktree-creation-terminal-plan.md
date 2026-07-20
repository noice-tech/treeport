# Immediate Worktree Creation and Setup Terminal Plan

## Objective

Make worktree creation feel immediate in the web UI and make setup execution observable:

1. Close the **Create worktree** dialog as soon as the user submits it.
2. Immediately show a pending worktree row containing the typed worktree name and a spinner.
3. Automatically create and select a terminal after the Git checkout is ready.
4. Run compatible `create_worktree` setup tasks in that terminal so their output is visible in tmux/xterm scrollback.

This plan supersedes the creation-dialog and pre-terminal hook sequencing described in `docs/worktree-terminal-ux-plan.md`.

## Product decisions

- wtr owns the worktree lifecycle and terminal behavior.
- Zed is only a compatibility source for setup task definitions. Its UI lifecycle, task presentation, reveal behavior, and internal architecture do not define wtr behavior.
- Setup execution uses a generic internal `WorktreeSetupTask` model. A Zed compatibility adapter translates matching `.zed/tasks.json` entries into that model. Future client adapters can target the same model.
- The pending sidebar row visibly contains the exact name typed by the user and a spinner. It must not use a generic visible label such as `Creating`.
- Accessible text may announce `Creating worktree <name>` without replacing the visible name.
- Once the server returns, the pending label is replaced by the canonical server name if normalization changed it, such as `new topic` becoming `new-topic`.
- The pending row is local UI state in this delivery. Persisted create operations and reload-safe progress are deferred.
- One automatically created terminal owns the complete launch pipeline:
  1. run setup tasks sequentially;
  2. stop on the first failure;
  3. after success, start the requested command or the configured login shell.
- A setup failure does not delete a valid worktree.
- On setup failure, the final requested command does not start. The terminal exits non-zero and remains available through tmux dead-pane retention and scrollback.
- For this delivery, the Zed adapter continues reading the main checkout's `.zed/tasks.json`. Global Zed tasks and Zed-specific `reveal`, `hide`, and `save` behavior remain out of scope.
- Web worktree creation requests an initial terminal named `Terminal`. Other API callers retain control over whether they request an initial terminal and which argv it eventually runs.

## Current behavior and gaps

### Web

- `ActionModal` owns a generic mutation and closes only in `onSuccess`, so the dialog remains open for Git creation and all setup work.
- The sidebar renders only `ProjectRecord.worktrees`; there is no pending creation overlay.
- `apiClient.createWorktree` does not send the already-supported `initialTerminal` field.
- The create success handler does not cache or select the returned terminal.

Primary files:

- `apps/web/src/app.tsx`
- `apps/web/src/api.ts`
- `apps/web/e2e/app.spec.ts`

### Core and server

The current service order is:

```text
create Git checkout
→ import worktree
→ execute and await create_worktree tasks with captured output
→ publish worktree.created
→ optionally create initial terminal
→ return HTTP response
```

Consequences:

- Setup commands can keep the create request and dialog pending for up to 30 minutes per task.
- Output is buffered by `CommandRunner` rather than written to a terminal PTY.
- The initial terminal starts only after setup and is skipped on setup failure, so users cannot inspect setup execution in the terminal UI.

Primary files:

- `packages/core/src/service.ts`
- `packages/core/src/zed.ts`
- `packages/core/src/tmux.ts`
- `packages/core/src/launcher.ts`
- `apps/server/src/app.ts`

## Target lifecycle

```text
User submits form
│
├─ Web captures typed name and resolved destination
├─ Web adds local pending row: [spinner] <typed name>
├─ Web closes dialog immediately
└─ Web starts create mutation

Server creates worktree
│
├─ validate name/path/base
├─ resolve base commit
├─ create detached Git checkout
├─ import and persist real worktree
├─ publish worktree.created
├─ resolve compatible setup definitions into generic setup steps
├─ create terminal and tmux launch spec
├─ publish terminal.created
└─ return worktree + terminal without waiting for setup completion

Terminal launch pipeline
│
├─ run setup step 1 in the pane PTY
├─ run remaining steps sequentially
├─ on failure: print failure, skip final command, exit non-zero
└─ on success: start requested argv or login shell in the same pane

Web reconciles response
│
├─ upsert real worktree and terminal into the query cache
├─ select the returned terminal
├─ remove the pending row
├─ attach the terminal WebSocket
└─ invalidate projects for final reconciliation
```

## Internal setup model

Do not expose Zed-specific task types to tmux or the launcher. Introduce a generic resolved model in core:

```ts
interface WorktreeSetupTask {
  label: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}
```

The Zed compatibility adapter is responsible for:

- reading JSONC from the main checkout's `.zed/tasks.json`;
- selecting entries whose `hooks` contain `create_worktree`;
- supporting the current subset: `label`, `command`, `args`, `cwd`, `env`, and `hooks`;
- expanding `ZED_WORKTREE_ROOT` and `ZED_MAIN_GIT_WORKTREE`;
- converting commands requiring shell syntax into explicit `[configuredShell, "-lc", script]` argv;
- returning ordered `WorktreeSetupTask[]`;
- preserving current sequential, fail-fast, and 30-minute timeout semantics.

Future compatibility adapters can translate their configuration into the same generic model without changing tmux, the launcher, the web UI, or the worktree service lifecycle.

## Implementation tasks

### 1. Move web creation ownership out of the dialog

**Files**

- `apps/web/src/app.tsx`
- `apps/web/src/api.ts`

**Changes**

- Add a web-only `PendingWorktreeCreation` type containing:
  - client-generated ID;
  - project ID;
  - exact typed name;
  - previewed canonical name and destination path;
  - base and optional source worktree ID.
- Add pending creation state and an App-level worktree creation mutation.
- Give `ActionModal` a dedicated create callback instead of using its generic mutation for worktree creation.
- Require `WorktreeForm` to submit with its current successful destination preview.
- During submission, in the same event turn:
  1. append the pending item;
  2. close the modal;
  3. start the mutation.
- Keep registration and removal actions on the existing modal-owned mutation.
- Send `initialTerminal: { name: "Terminal" }` from the web create request.
- Do not send a browser-generated shell command; the server remains responsible for the configured default shell.

**Acceptance criteria**

- The dialog disappears immediately after clicking **Create worktree**.
- The behavior does not depend on the create request resolving.
- Errors are shown through the global error surface after the dialog has closed.
- The request body remains schema-valid and argv-safe.

### 2. Render and reconcile named pending rows

**File**

- `apps/web/src/app.tsx`

**Changes**

- Render pending items in the owning project's worktree list immediately before **New worktree**.
- The visible row must contain:
  - a spinner;
  - the exact typed worktree name.
- Do not visibly replace the name with `Creating`, `Loading`, or similar generic text.
- Give the row accessible status text such as `Creating worktree <name>`.
- Keep the row non-interactive until a real `WorktreeRecord` exists.
- Render pending items from local overlay state rather than injecting fake `WorktreeRecord` values into React Query data.
- Suppress a pending row when fetched project data already contains its canonical destination path, preventing duplicate rows if SSE wins the race with the mutation response.
- Disable or guard additional creation for the same project while its current request is pending, matching the service's existing project mutation lock.

**Success ordering**

1. Cancel any in-flight projects refetch.
2. Synchronously upsert the returned worktree, including its terminal, into the projects query cache.
3. Select the returned terminal and persist its ID.
4. Remove the pending item.
5. Invalidate projects for final reconciliation.

Cache insertion must happen before terminal selection so selection reconciliation does not clear an ID that is not yet present in query data.

**Failure ordering**

1. Remove only the failed pending item.
2. Keep the dialog closed.
3. Show the global error message.
4. Never remove a real worktree returned by the server because terminal setup failed.

**Acceptance criteria**

- The typed name and spinner paint while the POST remains unresolved.
- SSE and background refetches cannot erase the pending indicator.
- The pending and real rows never appear simultaneously for the same destination.
- A successful create automatically selects and attaches the returned terminal.

### 3. Add a generic compatibility boundary for setup definitions

**Files**

- `packages/core/src/zed.ts`
- `packages/core/src/zed.test.ts`

**Changes**

- Refactor the current parser into two layers:
  1. Zed-compatible task loading and validation;
  2. generic resolution to `WorktreeSetupTask[]`.
- Keep Zed-specific variable names inside the compatibility adapter.
- Keep the generic setup task and launcher interfaces free of Zed-specific naming.
- Reuse the same resolver for terminal-backed and any remaining headless/captured execution path so task semantics cannot drift.
- Preserve exact argv rather than constructing a shell-composed pipeline.
- Preserve task order and stop after the first failure.

**Acceptance criteria**

- Direct executable tasks retain exact executable and argument boundaries.
- Commands containing pipelines or shell operators use an explicit configured shell.
- Unicode, spaces, quotes, semicolons, and dollar signs survive resolution safely.
- `cwd`, custom environment, and compatibility variables resolve correctly.
- No launcher or tmux API depends on Zed-specific task types.

### 4. Extend the terminal launch spec with setup steps

**Files**

- `packages/core/src/tmux.ts`
- `packages/core/src/tmux.test.ts`

**Changes**

- Extend the internal JSON launch spec with optional ordered `setupTasks` while preserving the existing final `argv`, `cwd`, and environment.
- Serialize the setup task list into the existing per-terminal mode-`0600` launch-spec file.
- Continue launching tmux with only Node, the application launcher path, and the spec path.
- Never pass task contents as `tmux new-session` arguments.
- Preserve:
  - `history-limit 50000`;
  - `remain-on-exit on`;
  - mouse/copy-mode scrolling;
  - dead-pane retention;
  - launch-spec cleanup when the terminal is deleted.

**Acceptance criteria**

- Setup and final argv round-trip through JSON without shell joining.
- Hostile input is absent from tmux command arguments.
- Existing terminal creation without setup tasks behaves identically.

### 5. Run setup and the final command in one PTY

**Files**

- `packages/core/src/launcher.ts`
- `packages/core/src/launcher.test.ts` (new)

**Changes**

- Refactor launcher orchestration into an importable, testable function.
- For each setup task:
  - print a concise start marker containing its label;
  - spawn with `shell: false` and inherited stdio;
  - use the task's cwd and merged environment;
  - enforce its timeout;
  - wait before starting the next task;
  - print a concise completion or failure marker.
- Forward termination signals to the currently running child.
- On spawn error, timeout, signal, or non-zero exit:
  - stop the pipeline;
  - do not run later setup tasks;
  - do not start the final command;
  - exit non-zero.
- After every setup task succeeds, spawn the original final argv unchanged in the same terminal and retain current signal and exit-code behavior.

**Acceptance criteria**

- Hook stdout and stderr stream incrementally into the terminal rather than being buffered in the HTTP request.
- The final login shell or `/api/spawn` command starts exactly once and only after setup succeeds.
- Failure output remains visible in the retained tmux pane.
- Setup output remains in scrollback after the final command starts.

### 6. Reorder worktree creation and terminal setup

**Files**

- `packages/core/src/service.ts`
- `packages/core/src/service.integration.test.ts`

**Changes**

- Separate valid checkout creation from setup execution.
- Complete Git creation, database import, managed-wrapper persistence, and real worktree lookup before setup dispatch.
- Publish `worktree.created` once the real worktree exists, before runtime setup begins.
- For a request with `initialTerminal`:
  - resolve compatibility definitions into generic setup tasks;
  - create one terminal whose launch spec contains those tasks and the requested/default final argv;
  - return after the tmux session is created and configured;
  - do not await setup process completion.
- Publish `terminal.created` only after terminal persistence and tmux startup succeed.
- Preserve `/api/spawn` argv unchanged as the final command.
- If no explicit argv is supplied, use the configured login shell as the final command.
- A task preparation problem should be represented in the retained setup terminal where practical; it must not trigger removal of a valid checkout.
- Keep requests without an initial terminal compatible with the existing CLI behavior in this delivery. A later product decision may make all creation terminal-backed.

**Response semantics**

Keep the current `201` response shape for compatibility:

```ts
{
  worktree: WorktreeRecord;
  terminal: TerminalRecord | null;
  terminalError: string | null;
  setupError: string | null;
}
```

Runtime setup failures now happen after the response and are represented by terminal output and eventual terminal exit status. A null synchronous `setupError` must not be documented as proof that runtime setup succeeded.

**Acceptance criteria**

- Hook duration no longer delays a terminal-backed create response.
- `worktree.created` precedes `terminal.created`.
- The returned worktree remains present after setup or terminal failure.
- A hook failure prevents the final requested command from starting.

### 7. Preserve HTTP and CLI contracts

**Files**

- `apps/server/src/app.test.ts`
- `packages/cli/src/index.ts` only if user-facing wording requires clarification

**Changes**

- Test forwarding of `initialTerminal.name` and optional argv through the worktree endpoint.
- Test `/api/spawn` with hostile argv and verify it remains one structured initial-terminal request.
- Preserve `201` and the current response shape.
- Update CLI wording only where it currently implies that response completion means setup completion.

**Acceptance criteria**

- `wtr spawn -- <command> ...` eventually runs that exact argv after successful setup.
- Setup failure prevents the requested command and leaves its terminal log available.
- No command is converted from argv into an interpolated shell string.

### 8. Add browser timing and reconciliation coverage

**File**

- `apps/web/e2e/app.spec.ts`

**Changes**

Extend the existing mock API so create responses can be delayed, released, failed, and reflected in project state.

Add tests for:

- request includes `initialTerminal: { name: "Terminal" }`;
- dialog closes immediately while the request remains unresolved;
- visible pending row contains the typed name and spinner;
- visible pending row does not use generic `Creating` as its label;
- SSE-triggered project fetch does not erase the pending row;
- server worktree visibility before response does not create duplicate rows;
- response replaces the pending item with the canonical worktree name;
- returned terminal is selected and opens a WebSocket attachment;
- mocked setup output is visible in xterm;
- rejected request removes the pending item, leaves the dialog closed, and shows a global alert;
- existing mobile modal/drawer focus behavior remains intact.

### 9. Add real PTY/tmux validation and documentation

**Files**

- `packages/core/src/system.real.test.ts`
- `README.md`

**Real test cases**

- Two setup tasks print ordered markers, followed by a final command marker.
- The attached terminal contains all markers in order.
- A failing first or middle setup task prevents later setup and final-command markers.
- The failed pane remains attachable and contains the failure output.
- The valid Git worktree remains registered after failure.

**Documentation updates**

- Explain the immediate named pending row.
- Explain that setup definitions may currently be imported from compatible `.zed/tasks.json` configuration, while lifecycle and terminal behavior are wtr-defined.
- Explain the one-terminal setup-to-command pipeline.
- Explain that the create response means Git and tmux launch are ready, not that setup has completed.
- Explain retained failure output and fail-fast behavior.

## Deferred work

The following are intentionally not part of this delivery:

- persisted create operations;
- `creating`, `setup_running`, or `setup_failed` database worktree states;
- reload-safe progress indicators;
- setup cancellation or retry APIs;
- logs persisted independently of tmux;
- global Zed task configuration;
- Zed-specific reveal/hide/save semantics;
- compatibility adapters for other clients;
- concurrent setup pipelines for multi-root projects.

A future persisted design should model checkout creation and setup execution as separate milestones rather than overloading the current worktree cleanup status.

## Test plan

Run focused validation first:

```text
pnpm test -- packages/core/src/zed.test.ts
pnpm test -- packages/core/src/tmux.test.ts
pnpm test -- packages/core/src/launcher.test.ts
pnpm test -- apps/server/src/app.test.ts
pnpm test:integration -- packages/core/src/service.integration.test.ts
pnpm test:web --project=chromium apps/web/e2e/app.spec.ts
WTR_REAL_INTEGRATION=1 pnpm test:integration:real -- packages/core/src/system.real.test.ts
```

Then run the full project checks:

```text
pnpm test
pnpm test:integration
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm build
pnpm test:web
```

Final repository checks:

```text
git diff --check
git status --short
```

## Delivery order

1. Generic setup task resolver and compatibility adapter.
2. Launch-spec and launcher pipeline.
3. Service lifecycle reordering and automatic initial terminal.
4. Web request, immediate close, and named pending overlay.
5. Cache reconciliation and terminal auto-selection.
6. Unit and integration tests.
7. Browser timing tests.
8. Real tmux smoke tests and documentation.

## Primary risks

- Runtime setup failures move outside the synchronous response, so existing `setupError` wording can become misleading.
- Shell-joining setup or final argv would violate the project's command safety guarantees.
- A client-local pending item is lost on page reload; persisted operation state is deliberately deferred.
- `worktree.created` may arrive before the terminal exists, requiring path-based pending suppression and cache-before-selection ordering.
- tmux is the only setup log store in this delivery; explicit terminal deletion, server loss, or history truncation removes old output.
- There may be a short delay before a failed setup terminal changes from `running` to `exited`, because status reconciliation is polling-driven.
