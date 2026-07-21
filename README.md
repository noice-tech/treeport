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

`pnpm start` listens on `0.0.0.0:4780`. If `TASKTTY_AUTH_TOKEN` is unset, it generates a strong token and prints it; enter that token in the browser login screen. Open <http://127.0.0.1:4780> locally or `http://<machine-lan-ip>:4780` from another private-network device. Production serves the built React application and API from one Node process.

For loopback-only startup without authentication:

```sh
pnpm start:local
```

Development runs Hono and Vite together through Turborepo:

```sh
pnpm dev
```

Other development commands:

```sh
pnpm test                  # unit and API tests
pnpm test:integration      # deterministic adapter/service integration
pnpm test:integration:real # disposable real Git/tmux/node-pty suite
pnpm test:web              # Playwright desktop/mobile tests
pnpm typecheck
pnpm lint
pnpm build
```

Turbo caches package builds and runs workspace dependencies in graph order. Playwright needs `pnpm exec playwright install chromium` once.

## First use

Register a repository:

```sh
tasktty project add ~/Projects/example
```

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

The web UI provides the same project, worktree, terminal, and removal operations. Submitting a new worktree closes the dialog immediately and shows its typed name with a spinner while Git creates it. The web flow then selects one retained terminal that streams compatible setup output before starting its login shell. Command input is always an argv array. Shell syntax has no special meaning unless an explicit shell is launched, for example `-- /bin/zsh -lc 'one && two'`.

## CLI

All machine-relevant commands support `--json`. The CLI calls the daemon API and does not duplicate lifecycle logic.

```text
tasktty project add <path>
tasktty project list
tasktty worktree list [--project <id-or-path>]
tasktty worktree create --project <id-or-path> --name <name> [--from-current]
tasktty worktree remove <id-or-path-or-dot> [--force]

tasktty terminal list [--worktree <id-or-path>]
tasktty terminal create --worktree <id-or-path-or-dot> --name <name> [-- <command> args...]
tasktty terminal delete <terminal-id>

tasktty spawn --project <id-or-path-or-dot> --worktree-name <name> --name <name> [--from-current] [-- <command> args...]
```

Each terminal receives `TASKTTY_API_URL`, `TASKTTY_PROJECT_ID`, `TASKTTY_WORKTREE_ID`, and `TASKTTY_TERMINAL_ID`. A Pi process can therefore call `tasktty` to create a child worktree/terminal or remove its own worktree. Removal is persisted as a daemon-owned operation and returns an operation ID before the daemon terminates the requesting tmux server. CLI exit codes are stable: `0` success, `1` unexpected failure, `2` usage, `3` daemon unreachable, `4` authentication, and `5` API/domain refusal.

## Runtime model

For worktree `wt_…`, tasktty generates a socket name such as `tasktty-wt-a8f…`. Every terminal gets its own generated tmux session such as `tasktty-term-2c1…`:

```text
worktree SQLite ID
└── dedicated tmux server/socket
    ├── one session for Pi
    ├── one session for pnpm dev
    └── one session for a shell
```

Identifiers never come from branch names or paths. `packages/core/src/launcher.ts` reads an application-owned JSON launch spec and uses Node `spawn(..., { shell: false })`, preserving spaces, quotes, Unicode, semicolons, and dollar signs literally.

The generated tmux configuration is stored in the tasktty runtime directory. It does not read or modify `~/.tmux.conf`. It disables the status bar, uses `tmux-256color`, enables extended keys, selects CSI-u key encoding on tmux 3.5+, retains dead panes and scrollback, and never restarts exited commands. Wheel scrolling still uses tmux's persistent history, but tasktty hides tmux's copy-mode indicator and styling; typing immediately returns to the live terminal without dropping the first key. SQLite stores project/worktree bindings and operation history. tmux owns terminal inventory, configured names, commands, and live or exited status.

Production terminal rendering deliberately uses normal `attach-session` clients: control mode does not provide a byte-offset replay or enough private terminal state to restore application-cursor, bracketed-paste, mouse/focus, extended-key negotiation, and alternate-screen state exactly after reconnect. For each running terminal, a daemon-lifetime read-only, `ignore-size` control-mode sidecar observes title and OSC `9;4` progress metadata that normal tmux clients filter, without affecting rendering or pane dimensions. The daemon also polls tmux title/status as a fallback and publishes metadata snapshots and changes over SSE, so navigation stays current before a terminal is selected. `apps/server/src/tmux-control.ts` byte-decodes this output; tests cover flow-control events, OSC sequences, raw modified-key sequences, resizing, and session survival against real tmux. Control-mode rendering remains experimental and would require a persistent terminal model before replacing the normal attachment path.

## Browser and phone handoff

Opening a terminal creates a temporary `node-pty` process attached to its existing tmux session. Closing the browser kills only that tmux client; the command continues. Reopening on desktop or phone attaches to the same session and never relaunches Pi.

Multiple clients can view a terminal. One client holds the input/resize lease. Select **Take control** on another client to transfer it without replacing the tmux session. The controlling client drives tmux’s `window-size latest` sizing. A reconnecting browser keeps its lease for a short grace period using a tab-scoped client identity. A brief resize when clients with very different dimensions hand off is an inherent tmux limitation; viewers may also see letterboxing until they take control.

Terminal sockets use a versioned hello/ready protocol with application heartbeats and output acknowledgements. The server pauses an attachment PTY when the browser falls behind, while the persistent tmux session continues independently. The browser retains at most three selected/recent xterm sessions and reuses them when switching tabs.

Reconnect is deliberately reset-and-redraw, not durable replay: a new tmux attachment resets xterm and redraws the current screen, so browser-only scrollback may be lost. Input typed while disconnected is never queued or replayed. Terminal output remains absent from SQLite and application logs.

The responsive PWA has a mobile drawer, full-screen xterm.js view, reconnect behavior, visual BEL feedback, and Esc/Ctrl/Alt/Tab/Enter/arrow accessory keys. Accessory arrows respect terminal application-cursor mode. The application shell can load from its service-worker cache, but terminal sessions are never represented as available offline.

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

Git is authoritative for active worktree inventory and state. Every project snapshot observes `git worktree list --porcelain`; SQLite only binds TaskTTY IDs, tmux sockets, wrapper ownership, and presentation metadata to project-scoped Git administrative worktree identities. External linked-worktree moves preserve those bindings, while confirmed external removals disappear automatically and stop their TaskTTY tmux servers. Renaming the main checkout within its parent is recovered by filesystem identity, repairs Git's linked-worktree pointers, and updates an automatic project name; a custom name is preserved. A move elsewhere remains visible but unavailable until the new path is registered, which recovers the existing project instead of creating a duplicate. If a repository is unavailable, the last-known inventory remains visible but disabled and no destructive reconciliation occurs. Git-reported prunable worktrees likewise remain visible but disabled.

tasktty currently includes a compatibility adapter for project-local `.zed/tasks.json` tasks whose `hooks` contain `create_worktree`; Zed defines the input format, not tasktty's lifecycle. Compatible tasks from the main checkout run sequentially in the automatically created tmux terminal with `ZED_WORKTREE_ROOT` and `ZED_MAIN_GIT_WORKTREE`. Their stdout and stderr stream into the pane. After every task succeeds, the same pane starts the requested command or login shell. On the first failure, later tasks and the final command are skipped and tmux retains the exited pane and its scrollback. A terminal-backed create response means that Git creation and tmux launch completed; setup may still be running.

**Remove worktree** is the only removal action. Preview reports staged, unstaged, and untracked changes, detached-commit reachability, locked state, and every terminal that will stop. Dirty worktrees require destructive confirmation in the UI or `--force` in the CLI. The daemon then blocks mutation, kills the worktree's tmux server, and runs path-addressed `git worktree remove`; it never deletes an attached Git branch. Main and locked worktrees are refused. If Git removal fails after terminals stop, the worktree remains `cleanup_failed` with an explicit retryable error.

Runtime terminal titles and progress are owned by the daemon metadata manager and mirrored into the browser's terminal session manager through SSE, so tabs, panes, the sidebar, and mobile selector update together even for terminals that have not been opened in that browser. The configured name is stored with the tmux session as its fallback; observed title and progress metadata remain volatile.

## API

The versioned JSON surface is under `/api`:

```text
GET  /api/health                     GET/POST /api/auth/session
GET  /api/events (SSE)
GET/POST /api/projects               GET/DELETE /api/projects/:projectId
POST /api/projects/:projectId/refresh
GET/POST /api/projects/:projectId/worktrees
GET  /api/projects/:projectId/worktree-destination
GET  /api/worktrees/:worktreeId
POST /api/worktrees/:worktreeId/terminals
GET  /api/worktrees/:worktreeId/remove-preview
POST /api/worktrees/:worktreeId/remove
POST /api/worktrees/:worktreeId/pr/refresh
GET/PATCH/DELETE /api/terminals/:terminalId
WS   /api/terminals/:terminalId/attach
POST /api/spawn
GET  /api/operations/:operationId
```

Errors use `{ "error": { "code", "message", "details"? } }`. SSE emits project, worktree, terminal, controller, and cleanup changes.

## Configuration and data

Localhost defaults require no environment variables. See `.env.example` for:

- `TASKTTY_HOST`, `TASKTTY_PORT`, `TASKTTY_AUTH_TOKEN`
- `TASKTTY_DATABASE_PATH`, `TASKTTY_DATA_DIR`, `TASKTTY_RUNTIME_DIR`
- `TASKTTY_SHELL`, `TASKTTY_TMUX_PATH`, `TASKTTY_GIT_PATH`, `TASKTTY_GH_PATH`
- `TASKTTY_API_URL`

Default database locations:

- macOS: `~/Library/Application Support/tasktty/tasktty.db`
- Linux/XDG: `${XDG_DATA_HOME:-~/.local/share}/tasktty/tasktty.db`

Schema tables are `projects`, `worktrees`, `operations`, and `schema_migrations`. Worktree rows are TaskTTY metadata bindings rather than the authoritative active inventory. Terminal inventory and metadata live in tmux; terminal output is never written to SQLite or application logs.

## Security assumptions

tasktty is arbitrary terminal access. The daemon itself defaults to `127.0.0.1`; the root `pnpm start` convenience command intentionally selects `0.0.0.0` and always supplies authentication, generating and printing a token when necessary. Use `pnpm start:local` for the loopback-only default. CLI requests use a bearer token from the environment; browsers exchange the token for an HttpOnly, SameSite session cookie so secrets are not put in WebSocket URLs. Repository/worktree paths are canonicalized, API bodies are validated with Zod, and external commands use argument arrays without interpolated shell strings.

This is a single-user, single-daemon local tool. It does not provide internet hosting, multi-user authorization, sandboxing, or a cloud relay. Use a private reverse proxy such as Tailscale Serve rather than exposing the daemon publicly.
