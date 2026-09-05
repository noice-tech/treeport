# Issue 166: update and restart coordination

## Result

[Issue 166](https://github.com/noice-tech/treeport/issues/166) is partly implemented. Keep it open.

Reviewed commit: `774ce8647f51ab6ff9e20c4b247db9723d2fbc26`.

The existing implementation covers most normal update operations. The remaining work concerns failure safety, recovery guidance, and release validation.

This document is an implementation plan. It does not change the supported user contract.

## Implementation progress

The following work is implemented in this worktree:

- Missing, invalid, or mismatched startup reports no longer authorize rollback after startup might have begun.
- Repeated daemon attempts preserve advanced and uncertain migration evidence.
- Lifecycle checks recognize an initializing daemon through its ownership lock, before it listens.
- Service shutdown completes before rollback evidence is read or an older binary is activated.
- Snapshot creation reaches the startup report before migrations can fail. The daemon also records the path in its log.
- Human CLI output and backend update status preserve recovery details, log paths, and snapshot paths.
- Desktop update errors have a visible control and native recovery guidance.
- Desktop E2E coverage checks error guidance, compatibility, and the absence of remote backend update requests.
- The package gate upgrades the pinned published `0.5.0` artifact to the candidate with pending migrations and preserved catalog data.
- The package gate verifies snapshot contents, repeat startup, downgrade refusal, and explicit snapshot restoration.
- The release workflow checks public updater discovery for both supported Mac architectures after publication.
- Public documentation covers distribution ownership, interrupted updates, faulty releases, and deliberate snapshot restoration.

The historical test exposed the existing tmux cutover. A live `0.5.0` update cannot preserve terminal identifiers across that runtime change.

The documented historical upgrade therefore terminates old terminals, updates the stopped backend, and starts the candidate. The existing synthetic test still verifies live terminal-host preservation.

Validation completed:

- `pnpm ci:local`: passed, including 310 unit tests, 76 integration tests, 2 desktop workflows, package tests, and documentation checks.
- Public updater discovery for published `0.6.1`: passed for `darwin-arm64` and `darwin-x64`.

Remaining work before issue closure:

- Install a signed desktop update through the native updater on an isolated macOS release runner. Current desktop E2E tests do not install artifacts.
- Add packaged fault-injection coverage for interrupted activation and failed service restart on isolated operating-system service runners.

The review and implementation sequence below record the original findings at the reviewed commit.

## Existing ownership and execution

- The macOS desktop application contains a client, not a backend.
- `apps/desktop/src/main.ts` uses `update-electron-app` and Electron's native `autoUpdater`.
- The updater checks `update.electronjs.org` for stable GitHub Releases. The title-bar action calls `quitAndInstall()`.
- Desktop startup reconnects to the saved computer and checks its version before application API requests.
- A desktop update does not stop or update either a local or remote backend.
- The local backend update control calls `/api/update`. `application-update.ts` starts the existing CLI as a detached process.
- `cli/update.ts` verifies installation and daemon ownership, stages the npm release, and checks its assets before stopping the daemon.
- The CLI activates the package through its stable entrypoint. It restarts only a previously running daemon through the same lifecycle.
- `server/index.ts` opens the database before service initialization and listening.
- `core/database.ts` checks migration history, creates snapshots, and applies migrations. Update clients do not open the database.

Relevant completed work includes desktop distribution (#211), desktop update controls (#285), CLI updates (#320), and browser updates (#322).

## Acceptance review

| Issue requirement                                                                   | Status                               | Evidence and remaining work                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Detect and install a published Electron update, then return to a local session      | Partial                              | Native updater integration exists. The release smoke test only starts one application against a mock backend. It disables updates through the E2E setting.                                                       |
| Coordinate local daemon shutdown and restart without client-owned migrations        | Implemented normal path              | `cli/update.ts` and `server/index.ts` provide this boundary. Failure safety needs the changes below. Desktop installation itself does not own a daemon.                                                          |
| Do not update or restart remote backends from Electron                              | Implemented path; limited validation | Desktop installation only replaces the client. `backendUpdateEnabled()` suppresses remote desktop backend updates. The CLI also refuses remote targets. Add a desktop workflow assertion for no update requests. |
| Document and test npm upgrades and daemon restarts                                  | Partial                              | Installation and service documentation describe `treeport update`. The package smoke test verifies restart and terminal preservation, but uses a fabricated previous version.                                    |
| Prevent serving after migration or compatibility failure; provide recovery guidance | Partial                              | Database startup fails before listening. Desktop compatibility guidance exists. Missing reports, repeated startup, and lost diagnostic details need correction.                                                  |
| Upgrade a real older package with pending migrations and preserved catalog data     | Missing                              | `scripts/smoke-package.mjs` repacks the current artifact with an older version number. Both artifacts have the same code and migrations.                                                                         |
| Document interrupted updates and failed or withdrawn releases                       | Partial                              | Durable CLI recovery exists. Public documentation lacks a complete recovery procedure for these cases.                                                                                                           |
| Refuse unsupported schema downgrades and explain snapshots                          | Partial                              | Database checks and tests reject newer migration history. Public rollback and snapshot restoration procedures are missing.                                                                                       |

Paths in the table are under `apps/treeport`, unless another application is named.

## Concrete gaps

### 1. Missing startup evidence can permit rollback

`runLocalUpdate()` initially records `migrationState: 'not_started'`.

Its failure handler replaces that value only when a matching startup report exists. An absent or invalid report can therefore permit rollback after restart begins.

Interrupted-update recovery also treats a missing report as safe. Missing evidence must not prove that the database remained unchanged.

### 2. Repeated startup can replace migration evidence

`createUpdateStartupReporter()` creates a new report for each matching pending operation. It does not preserve an earlier report.

A service retry before readiness can replace `advanced` with `not_started`, then report `unchanged` for an already migrated database.

Rollback safety must describe the complete update operation, not only the latest daemon attempt.

### 3. Recovery details do not reach all users

- `databaseOpened()` supplies snapshot paths only after `openDatabase()` succeeds. A migration failure can leave an existing snapshot unreported.
- The normal CLI error renderer prints only `cliError.message`. Structured recovery instructions and paths appear only in JSON output.
- `application-update.ts` reads the CLI message and recovery instruction, but discards log and snapshot paths.
- The desktop updater handles `update-downloaded`, but exposes no updater error state.
- An unavailable local backend receives generic start guidance. A failed migration needs a recovery route that also works without a serving backend.

## Implementation sequence

### 1. Correct the shared rollback decision

Primary files: `apps/treeport/src/cli/update.ts` and `apps/treeport/src/server/update-startup.ts`.

- Record an uncertain migration state durably before starting the new daemon.
- Permit rollback only when the operation proves that migration did not advance.
- Treat missing, invalid, or mismatched evidence after a possible startup as unsafe.
- Preserve advanced or uncertain evidence across daemon attempts for the same operation.
- Preserve snapshot paths across those attempts.
- Apply the same rule to immediate failure and interrupted-update recovery.
- Verify and stop the owned replacement daemon before activating an older package, where rollback is safe.
- Preserve intentionally stopped services, terminal processes, and administrator boundaries.

Extend existing startup reporting tests with repeated daemon attempts. Exercise missing reports and interruption through the package workflow.

Success: no failure path starts an older daemon when migration history might have advanced.

### 2. Complete recovery reporting

Primary files: database startup, startup reporting, CLI error output, and `application-update.ts`.

- Record completed snapshot creation before migration execution can fail.
- Keep database inspection and migration evidence inside daemon startup.
- Include the failure cause, log location, snapshot locations, and next safe action in human CLI output.
- Preserve these details through the existing backend update status response.
- Keep the structured CLI error contract intact.
- Provide recovery documentation from the desktop's unavailable state. Do not add desktop database access or a second daemon manager.
- Surface native updater failures with retry or manual-install guidance through the existing desktop shell.

Extend existing workflow tests. Assert the recovery information users can read, not only stored report fields.

Success: recovery remains possible when the updated backend cannot serve `/api/update`.

### 3. Validate real packaged backend upgrades

Primary files: `apps/treeport/scripts/smoke-package.mjs` and the existing release validation commands.

- Add a real historical-package scenario beside the current synthetic package smoke test.
- Pin a published stable package and its integrity. Select a version whose migration history precedes the candidate package.
- Do not edit the historical artifact's version or migrations.
- Install it in temporary npm, data, runtime, and home directories. Remove inherited `TREEPORT_*` values.
- Create a repository, worktree, and catalog data through that version's supported CLI or API.
- Upgrade to the candidate tarball through the supported update path.
- For versions before self-update support, exercise the documented manual npm installation and restart path.
- Verify pending migrations actually ran, catalog identifiers survived, and a readable pre-migration snapshot exists.
- Verify the candidate serves successfully. Verify a second startup does not create another migration snapshot.
- Attempt the older binary against the upgraded database. Verify refusal, no serving endpoint, and preserved data.
- Add isolated failure cases for migration failure, interrupted activation, and failed restart.
- Cover running and stopped standalone daemons and services without changing the developer's installed service.

Reuse current package-test setup and subprocess controls. Keep deliberate corruption limited to disposable failure fixtures.

Wire the real upgrade scenario into the release gate before publication. Keep its selected historical baseline explicit.

Success: release evidence proves an actual schema transition between different packaged releases, not only package replacement.

### 4. Validate desktop installation and reconnection

Primary files: `apps/desktop/scripts/smoke-release.mjs`, desktop E2E coverage, and `.github/workflows/desktop-release.yml`.

- Keep `update-electron-app`, the native updater, and the existing GitHub publication path.
- Check that updater feed responses resolve the published universal ZIP for supported Mac architectures.
- Exercise a signed older application updating to the signed candidate on an isolated macOS runner.
- Use the native updater for installation. Do not substitute the E2E action that only clears `updateReady`.
- Verify the relaunched version and saved workspace against a compatible real local backend.
- Verify the desktop installation leaves the backend process unchanged.
- Exercise remote selection and compatibility failure through the existing desktop workflow.
- Assert no backend update requests during remote selection or desktop installation.

Use a controlled native update feed for the prepublication installation test if required. Check the public feed after publication separately.

Success: artifact checks, native installation, and public feed discovery each have explicit evidence.

### 5. Complete user recovery documentation

Update the existing installation, CLI reference, and service supervision pages. Add one recovery page only if these procedures need a shared destination.

Document:

- Desktop-only installation versus npm backend updates.
- The exact manual upgrade and restart sequence for versions without self-update support.
- Interrupted downloads, interrupted activation, and failed restart.
- Log locations and the purpose, location, and retention of pre-migration snapshots.
- Repair with the same or a newer compatible release after migration might have started.
- Explicit snapshot restoration, including service shutdown, preservation of the failed database and WAL files, and possible catalog data loss.
- Desktop reinstallation and backend recovery after a withdrawn or faulty release.
- Refusal of unsupported binary downgrades. Never prescribe automatic snapshot restoration.

Verify every recovery command against an isolated packaged installation before publication.

## Validation performed for this review

Built the existing shared workspace dependencies, then ran:

```sh
pnpm exec vitest run \
  apps/treeport/src/cli/update.test.ts \
  apps/treeport/src/server/update-startup.test.ts \
  apps/treeport/src/server/application-update.test.ts \
  apps/treeport/src/server/core/database.test.ts \
  apps/treeport/src/web/features/updates/update-control.test.ts
```

Result: 5 files and 17 tests passed.

The first attempt could not resolve unbuilt shared package exports. The dependency build resolved that setup failure.

This review did not run signed desktop installation, package smoke tests, or the complete local gate. No running Treeport instance was changed.

## Scope limits

Do not add a second updater, a general update framework, new dependencies, or desktop-owned database migration.

Do not combine desktop installation with backend installation. That would change the current distribution contract and requires a separate product decision.

Retain the existing npm self-update choice. Replacing it with mandatory manual package management would remove implemented behavior without closing the remaining gaps.
