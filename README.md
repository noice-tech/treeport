# TaskTTY

`tasktty` is a worktree-first terminal driver. It registers Git repositories, discovers their main and linked worktrees, and runs any number of persistent terminals in an application-owned tmux server dedicated to each worktree. The web UI attaches normal terminal clients to Pi, shells, and dev servers; it does not replace or modify their TUIs.

V1 is intentionally narrow: no editor, file browser, diff/review UI, Git commit UI, chat renderer, task board, cloud relay, or general-purpose tmux workspace management.

## Requirements

- Node.js 22 or newer (developed and tested on Node 24)
- `git`
- `tmux` 3.2 or newer
- `gh` (optional, for GitHub PR status; authenticate with `gh auth login`)
- Pi only if you want to launch `pi`

The daemon never installs system dependencies. Startup failures report missing required commands.

## Install and run

```sh
pnpm install
pnpm build
pnpm --global add ./packages/cli # makes `tasktty` available on PATH
pnpm start
```

`pnpm start` listens on `0.0.0.0:4780`. Authentication is temporarily disabled, so only use this listener on a trusted private network. Open <http://127.0.0.1:4780> locally or `http://<machine-lan-ip>:4780` from another private-network device. Production serves the built React application and API from one Node process.

For loopback-only startup:

```sh
pnpm start:local
```

Development runs Hono, Vite, a watch-built workspace CLI, and the Electron companion together through Turborepo:

```sh
pnpm dev
```

Use `pnpm dev:desktop` when the daemon is already running and you only want the web and Electron processes.

The root workspace links `tasktty` into `node_modules/.bin`. The development daemon inherits that path and passes it to managed terminals, so the same generic TaskTTY skill can use the CLI while TaskTTY itself is under development. Pi sessions in this repository load the canonical skill directly from `skills/tasktty` through `.pi/settings.json`; there is no separate development version of the skill.

Other development commands:

```sh
pnpm test                  # unit and API tests
pnpm test:integration      # deterministic adapter/service integration
pnpm test:integration:real # disposable real Git/tmux/node-pty suite
pnpm test:web              # Playwright browser desktop/mobile tests
pnpm test:desktop          # Electron window, security, and menu integration
pnpm typecheck
pnpm lint
pnpm build
```

Turbo caches package builds and runs workspace dependencies in graph order. Playwright needs `pnpm exec playwright install chromium` once.

### Electron desktop companion

The Electron app is a thin companion for the existing loopback TaskTTY daemon. `pnpm dev` starts the development daemon, web app, and Electron window together. It does not bundle or own the daemon; for an already-running built daemon, launch only the web and desktop development processes with:

```sh
pnpm build
pnpm start:local
# In another terminal:
pnpm dev:desktop
```

Electron Forge's Vite + TypeScript plugin builds and watches only the Electron main and preload entries. React remains in its own renderer context, served by the existing web workspace at `http://127.0.0.1:5173`; Electron loads that URL without bundling the web app. API and Socket.IO behavior therefore stay shared with the browser, without a build-before-dev step. **New Terminal** (`Cmd+T` on macOS, `Ctrl+T` elsewhere) creates a Shell in the selected worktree. **Close Terminal** (`Cmd+W` or `Ctrl+W`) uses the same destructive confirmation and adjacent-tab selection as the tab close button; it does not close the desktop window.

`TASKTTY_DESKTOP_URL` may override the development URL, but the companion accepts loopback HTTP origins only. The workspace pins Forge 7.11.2 and overrides its transitive `@electron/rebuild` with 4.2.0 because pnpm 11 rejects the older rebuild release’s exotic Git dependency. Electron Forge packaging still requires a hoisted pnpm layout; packaging, native daemon dependencies, signing, notarization, and distribution are intentionally outside this companion MVP.

## First use

Open a repository:

```sh
tasktty project add ~/Projects/example
```

The CLI command name remains `project add` for compatibility, but it opens a project in the active workspace. Running it for a closed project's path reopens the same durable registration.

Create a worktree and Pi terminal in one operation:

```sh
tasktty spawn \
  --project ~/Projects/example \
  --worktree-name investigate-cache \
  --name researcher \
  -- pi
```

Create another terminal from anywhere inside that worktree:

```sh
tasktty terminal create \
  --worktree . \
  --name dev \
  -- pnpm dev
```

Inspect the exact TaskTTY context injected into a managed terminal:

```sh
tasktty context
```

The web UI provides the same project, worktree, terminal, and removal operations. **Open project** accepts a repository path or reopens a closed registration from **Recent projects**. Submitting a new worktree closes the dialog immediately and shows its typed name with a spinner while Git creates it. The web flow then selects one retained terminal that streams compatible setup output before starting the selected initial command, which defaults to the login shell. Command input is always an argv array. Shell syntax has no special meaning unless an explicit shell is launched, for example `-- /bin/zsh -lc 'one && two'`.

### Terminal presets

The **New terminal** menu always includes **Shell**, which starts the configured login shell without an explicit argv. **Manage presets** adds daemon-persisted choices that are shared by every browser using that TaskTTY server and survive daemon restarts. Enter a preset name and a command such as `diff main --mode split`. TaskTTY splits that input into argv, stores the executable and ordered arguments, and launches them directly. Quotes and backslashes can group or escape values containing spaces, but variables, operators, and other shell syntax are never expanded or executed.

Example values:

- Pi — Name: `Pi`; Command: `pi`
- Hunk — Name: `Hunk`; Command: `npx --yes hunkdiff@0.17.3 diff HEAD --watch`

These are documentation examples, not built-in presets. The new-worktree dialog also lets you choose its initial terminal, defaulting to **Shell**. TaskTTY copies that choice into the worktree-create request as a terminal name and argv, so editing the saved preset does not change an operation already in progress. A preset command runs as the terminal’s foreground program; when it exits—or cannot be started—TaskTTY opens the configured login shell in the same terminal. CLI-created explicit commands retain their existing exit behavior. TaskTTY does not preflight or install preset dependencies.

## Agent Skill

TaskTTY ships a portable [Agent Skills](https://agentskills.io/) skill at [`skills/tasktty/SKILL.md`](skills/tasktty/SKILL.md). Installing the skill teaches a compatible agent how to inspect its managed context and safely create persistent terminals and worktrees; it does not install TaskTTY itself or impose a task, planning, approval, prompt, or tool policy.

Copy the complete skill directory to a compatible project or user skill location:

```sh
# Project-local, shared with a repository
mkdir -p .agents/skills
cp -R /path/to/tasktty/skills/tasktty .agents/skills/tasktty

# User-level, available across projects
mkdir -p ~/.agents/skills
cp -R /path/to/tasktty/skills/tasktty ~/.agents/skills/tasktty
```

Pi also discovers `~/.pi/agent/skills/tasktty`. For one invocation from a TaskTTY checkout, load the canonical file directly:

```sh
pi --skill /absolute/path/to/tasktty/skills/tasktty/SKILL.md
```

Restart Pi or use `/reload` after installing or changing the skill. `/skill:tasktty` activates it explicitly. Project-local resources load only after the project is trusted. Review third-party skill instructions before enabling them.

## CLI

Commands print concise text by default. Add `--json` only when a program or extension needs structured output; JSON success responses go to stdout, while JSON errors use the API error envelope on stderr. The CLI calls the daemon API and does not duplicate lifecycle logic.

```text
tasktty context
tasktty project add <path>
tasktty project list
tasktty worktree list [--project <id-or-path>]
tasktty worktree create --project <id-or-path> --name <name> [--from-current]
tasktty worktree remove <id-or-path-or-dot> [--force]

tasktty terminal list [--worktree <id-or-path>]
tasktty terminal create --worktree <id-or-path-or-dot> --name <name> [-- <command> args...]
tasktty terminal inspect <terminal-id-or-dot>
tasktty terminal wait <terminal-id-or-dot> --until <idle|working|bell|exit> [--timeout <duration>]
tasktty terminal delete <terminal-id>

tasktty spawn --project <id-or-path-or-dot> --worktree-name <name> --name <name> [--from-current] [-- <command> args...]
```

Each terminal receives `TASKTTY_API_URL`, `TASKTTY_PROJECT_ID`, `TASKTTY_WORKTREE_ID`, and `TASKTTY_TERMINAL_ID`. `tasktty context` strictly resolves those IDs to the current project, worktree, and terminal; with no IDs it reports that the caller is outside TaskTTY, while partial or inconsistent IDs are refused instead of guessed from paths. A Pi process can therefore call `tasktty` to create a persistent child worktree or terminal that the user can open and continue in the normal Pi TUI. Removal is persisted as a daemon-owned operation and returns an operation ID before the daemon terminates the requesting tmux server.

`terminal inspect` combines refreshed process status with volatile daemon-observed title, OSC `9;4` progress, progress transition timestamps, and the latest real BEL sequence. `terminal wait` consumes the daemon event stream rather than polling. `idle` and `working` are daemon-owned progress states and can match immediately; active progress expires after five minutes without another valid progress frame, while duplicate active frames renew that lease. `bell` waits for a new BEL after subscription, and `exit` waits for the retained tmux pane to exit. Waits have no default deadline; pass a positive duration such as `500ms`, `30s`, `5m`, or `1h`, or cancel with Ctrl+C.

CLI exit codes are stable: `0` success, `1` unexpected failure, `2` usage, `3` daemon unreachable, `4` wait timeout, and `5` API/domain refusal. Ctrl+C during a wait exits `130`. With `--json`, failures are emitted on stderr as `{ "error": { "code", "message", "details"? } }`. A successful `spawn` can still report partial creation through a null `terminal`, `terminalError`, or `setupError`; callers must inspect those fields and must not blindly retry or remove the retained worktree.

## Runtime model

The sidebar is a persistent workspace of open projects. Closing a project terminates every TaskTTY-managed tmux server and process associated with its main and linked worktrees, then removes the project from active snapshots. It does not remove Git worktrees, branches, checkout directories, files, project colors, or TaskTTY's durable bindings. Closed projects remain in **Recent projects** and survive daemon restarts. Reopening preserves project and worktree IDs but does not recreate terminated terminal commands.

If one tmux server cannot be stopped, the close fails and the project remains open; servers already stopped are not restarted. Closed projects are not reconciled in the background, so their stored paths may become stale. Reopening by durable ID still succeeds and normal active observation reports the project as unavailable when appropriate.

For worktree `wt_…`, tasktty generates a socket name such as `tasktty-wt-a8f…`. Every terminal gets its own generated tmux session such as `tasktty-term-2c1…`:

```text
worktree SQLite ID
└── dedicated tmux server/socket
    ├── one session for Pi
    ├── one session for pnpm dev
    └── one session for a shell
```

Identifiers never come from branch names or paths. `packages/core/src/launcher.ts` reads an application-owned JSON launch spec and uses Node `spawn(..., { shell: false })`, preserving spaces, quotes, Unicode, semicolons, and dollar signs literally.

The generated tmux configuration is stored in the tasktty runtime directory. It does not read or modify `~/.tmux.conf`. It disables the status bar, uses `tmux-256color`, enables extended keys, selects CSI-u key encoding on tmux 3.5+, retains dead panes and scrollback, and never restarts exited commands. Wheel scrolling still uses tmux's persistent history, but tasktty hides tmux's copy-mode indicator and styling; typing immediately returns to the live terminal without dropping the first key. SQLite stores project/worktree bindings, terminal presets, and operation history. tmux owns terminal inventory, configured names, commands, and live or exited status.

Production terminal rendering deliberately uses normal `attach-session` clients: control mode does not provide a byte-offset replay or enough private terminal state to restore application-cursor, bracketed-paste, mouse/focus, extended-key negotiation, and alternate-screen state exactly after reconnect. For each running terminal, a daemon-lifetime read-only, `ignore-size` control-mode sidecar observes title, OSC `9;4` progress, and real BEL metadata that normal tmux clients filter, without affecting rendering or pane dimensions. The daemon records progress start/clear timestamps and the latest bell sequence for its lifetime. Every valid active progress frame renews a five-minute inactivity lease; an explicit clear or terminal/observer shutdown clears immediately, and an application that stops refreshing progress is eventually treated as idle. The daemon also polls tmux title/status as a fallback and publishes snapshot-first metadata changes through the Socket.IO `/events` namespace, so navigation and CLI waits stay current before a terminal is selected. Runtime metadata resets with the daemon and terminal applications that do not emit OSC `9;4` cannot distinguish “idle” from “no progress protocol support.” `apps/server/src/tmux-control.ts` byte-decodes this output; tests cover flow-control events, OSC sequences, raw modified-key sequences, resizing, and session survival against real tmux. Control-mode rendering remains experimental and would require a persistent terminal model before replacing the normal attachment path.

## Browser and phone handoff

Opening a terminal creates a temporary `node-pty` process attached to its existing tmux session. Closing the browser kills only that tmux client; the command continues. Reopening on desktop or phone attaches to the same session and never relaunches Pi.

Multiple clients can view a terminal. One client holds the input/resize lease. Interacting with another client’s terminal viewport—by clicking, tapping, typing, pasting, dropping a file, or using an accessory key—automatically transfers the lease without replacing the tmux session. Merely opening a terminal, switching tabs, reconnecting, or receiving programmatic focus does not take control. TaskTTY keeps every attachment on one revisioned canonical cell grid: the controller proposes viewport dimensions, the daemon updates all viewer PTYs before explicitly resizing the tmux window, and read-only viewers scale or letterbox that same logical grid instead of independently reflowing it. A reconnecting browser keeps its lease for a short grace period using a tab-scoped client identity. Client-private tmux modes such as copy mode remain independent.

Terminal viewers use independent WebSocket-only Socket.IO connections and an application-level ready/reset handshake. Engine.IO owns connection heartbeat and reconnect mechanics, while TaskTTY retains fresh stream epochs, controller generations, and explicit output-consumption acknowledgements. The server pauses only a lagging viewer’s attachment PTY when xterm falls behind, while the persistent tmux session and other viewers continue independently. The browser retains at most three selected/recent xterm sessions and reuses them when switching tabs.

Dropping a file on the terminal or pasting a clipboard file/image uploads a private copy (up to 50 MiB) into TaskTTY’s runtime directory and pastes its daemon-local path through xterm’s bracketed-paste handling. This gives terminal applications such as Pi a readable path without writing into the Git worktree. Uploads older than 24 hours are pruned, and the directory retains at most 512 MiB of its newest files.

Reconnect is deliberately reset-and-redraw, not durable replay: a new tmux attachment resets xterm and redraws the current screen, so browser-only scrollback may be lost. Input typed while disconnected is never queued or replayed. Terminal output remains absent from SQLite and application logs.

The responsive PWA has a mobile drawer, full-screen xterm.js view, reconnect behavior, visual BEL feedback, and Esc/Ctrl/Alt/Tab/Shift+Tab/Enter/arrow accessory keys. Accessory arrows respect terminal application-cursor mode. The application shell can load from its service-worker cache, but terminal sessions are never represented as available offline.

For private phone access without opening a LAN listener, use `pnpm start:local` and publish it through Tailscale Serve:

```sh
tailscale serve --bg http://127.0.0.1:4780
```

Use your tailnet HTTPS URL on the phone. Tailscale configuration is not managed by tasktty.

## Zed worktrees and removal

Existing Git worktrees are imported in place. Their display name is inferred from the checkout path rather than from the branch. For Zed's default layout:

```text
~/Projects/example
~/Projects/worktrees/example/<worktree-name>/example
```

the middle directory is the worktree name. The main checkout is shown as `main worktree`. Legacy layouts continue to work and are never moved.

New worktrees are detached at a resolved commit. The default base is the fetched remote default branch; `--from-current` uses the selected/current worktree's `HEAD`. Project-local `.zed/settings.json` `git.worktree_directory` is honored, with `../worktrees` as the default.

Git is authoritative for active worktree inventory and state. Every open-project snapshot observes `git worktree list --porcelain`; closed registrations remain SQLite-only until reopened. SQLite only binds TaskTTY IDs, tmux sockets, wrapper ownership, and presentation metadata to project-scoped Git administrative worktree identities. External linked-worktree moves preserve those bindings, while confirmed external removals disappear automatically and stop their TaskTTY tmux servers. Renaming the main checkout within its parent is recovered by filesystem identity, repairs Git's linked-worktree pointers, and updates an automatic project name; a custom name is preserved. A move elsewhere remains visible but unavailable until the new path is registered, which recovers the existing project instead of creating a duplicate. If a repository is unavailable, the last-known inventory remains visible but disabled and no destructive reconciliation occurs. Git-reported prunable worktrees likewise remain visible but disabled.

tasktty currently includes a compatibility adapter for project-local `.zed/tasks.json` tasks whose `hooks` contain `create_worktree`; Zed defines the input format, not tasktty's lifecycle. Compatible tasks from the main checkout run sequentially in the automatically created tmux terminal with `ZED_WORKTREE_ROOT` and `ZED_MAIN_GIT_WORKTREE`. Their stdout and stderr stream into the pane. After every task succeeds, the same pane starts the requested command or login shell. On the first failure, later tasks and the final command are skipped and tmux retains the exited pane and its scrollback. A terminal-backed create response means that Git creation and tmux launch completed; setup may still be running.

**Remove worktree** is the only removal action. The web UI submits an eligible, warning-free preview immediately; staged, unstaged, untracked, conflicted, or at-risk detached worktrees still require destructive confirmation. Preview also reports locked state and every terminal that will stop. The daemon then blocks mutation, marks the sidebar row as removing, kills the worktree's tmux server, and runs path-addressed `git worktree remove`; it never deletes an attached Git branch. Main and locked worktrees are refused. Completed removal means that Git no longer reports the worktree and the exact checkout root is absent. Interrupted removal may clean only the exact previously authorized checkout when its recorded filesystem identity, Git administrative key, stale `.git` marker, and wrapper provenance still match. TaskTTY atomically quarantines and reverifies that root before recursive cleanup. Wrapper cleanup remains empty-directory-only; unverifiable legacy or replaced paths stay `cleanup_failed` for inspection and appear with manual-cleanup guidance instead of an unsafe retry.

Runtime terminal titles and progress are owned by the daemon metadata manager and mirrored into the browser's terminal session manager through ordered Socket.IO snapshots and product events, so tabs, panes, the sidebar, and mobile selector update together even for terminals that have not been opened in that browser. Browser-local OSC parsing and terminal-viewer progress events are not progress state sources, so delayed terminal output cannot restore a newer daemon clear. The configured name is stored with the tmux session as its fallback; observed title and progress metadata remain volatile.

## API

The versioned JSON surface is under `/api`:

```text
GET  /api/health
GET/POST /api/terminal-presets      PATCH/DELETE /api/terminal-presets/:presetId
GET/POST /api/projects               GET/PATCH/DELETE /api/projects/:projectId
GET  /api/projects/recent
POST /api/projects/:projectId/open
POST /api/projects/:projectId/close
POST /api/projects/:projectId/refresh
GET/POST /api/projects/:projectId/worktrees
GET  /api/projects/:projectId/worktree-destination
GET  /api/worktrees/:worktreeId
POST /api/worktrees/:worktreeId/terminals
GET  /api/worktrees/:worktreeId/remove-preview
POST /api/worktrees/:worktreeId/remove
POST /api/worktrees/:worktreeId/pr/refresh
GET/PATCH/DELETE /api/terminals/:terminalId
POST /api/terminals/:terminalId/bell/acknowledge
POST /api/spawn
GET  /api/operations/:operationId
```

`GET /api/projects` returns open projects only. `POST /api/projects` opens or reopens by path, while the ID-based open endpoint also works for an unavailable stored path. Close is non-destructive workspace removal; `DELETE /api/projects/:projectId` remains destructive unregister and retains its linked-worktree restriction.

Errors use `{ "error": { "code", "message", "details"? } }`. Real-time traffic uses WebSocket-only Socket.IO at `/api/socket.io/`: `/events` emits an authoritative runtime-metadata snapshot before ordered product events, and `/terminals` owns one independent connection and tmux attachment per viewer. BEL attention is daemon-owned for the daemon lifetime: snapshots include each terminal's latest BEL and unread state, and viewing a terminal acknowledges the exact observed sequence for every connected browser. Connection-state recovery and per-message compression are disabled, so every terminal reconnect establishes a fresh stream epoch, resets xterm, and relies on tmux redraw rather than output replay.

## Configuration and data

Localhost defaults require no environment variables. See `.env.example` for:

- `TASKTTY_HOST`, `TASKTTY_PORT`
- `TASKTTY_DATABASE_PATH`, `TASKTTY_DATA_DIR`, `TASKTTY_RUNTIME_DIR`
- `TASKTTY_SHELL`, `TASKTTY_TMUX_PATH`, `TASKTTY_GIT_PATH`, `TASKTTY_GH_PATH`
- `TASKTTY_API_URL`

Default database locations:

- macOS: `~/Library/Application Support/tasktty/tasktty.db`
- Linux/XDG: `${XDG_DATA_HOME:-~/.local/share}/tasktty/tasktty.db`

Schema tables are `projects`, `worktrees`, `operations`, `terminal_presets`, and `schema_migrations`. Worktree rows are TaskTTY metadata bindings rather than the authoritative active inventory. Terminal presets are daemon-global user configuration stored as executable and ordered argument data. Terminal inventory and metadata live in tmux; terminal output is never written to SQLite or application logs.

## Security assumptions

tasktty is arbitrary terminal access. Authentication is temporarily disabled. The daemon itself defaults to `127.0.0.1`, but the root `pnpm start` convenience command selects `0.0.0.0`; use it only on a trusted private network, or use `pnpm start:local` to keep the listener loopback-only. Repository/worktree paths are canonicalized, API bodies are validated with Zod, and external commands use argument arrays without interpolated shell strings.

This is a single-user, single-daemon local tool. It does not provide internet hosting, authentication, multi-user authorization, sandboxing, or a cloud relay. Socket.IO upgrades reject a supplied browser Origin unless it matches the effective request host (including a reverse proxy’s forwarded host); originless local CLI connections remain supported. Use a private reverse proxy such as Tailscale Serve rather than exposing the daemon publicly.
