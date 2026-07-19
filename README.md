# wtr

`wtr` is a worktree-first terminal driver. It registers Git repositories, discovers their main and linked worktrees, and runs any number of persistent terminals in an application-owned tmux server dedicated to each worktree. The web UI attaches normal terminal clients to Pi, shells, and dev servers; it does not replace or modify their TUIs.

V1 is intentionally narrow: no editor, file browser, diff/review UI, Git commit UI, chat renderer, task board, cloud relay, or general-purpose tmux workspace management.

## Requirements

- Node.js 22 or newer (developed and tested on Node 24)
- `git`
- `tmux` 3.2 or newer
- [CodeRabbit Git Worktree Runner](https://github.com/coderabbitai/git-worktree-runner), `git gtr`
- `gh` (optional, for GitHub PR status; authenticate with `gh auth login`)
- Pi only if you want to launch `pi`

The daemon never installs system dependencies. Check them with:

```sh
wtr diagnostics
# or GET /api/diagnostics
```

## Install and run

```sh
pnpm install
pnpm build
pnpm --global add ./packages/cli # makes `wtr` available on PATH
pnpm start
```

`pnpm start` listens on `0.0.0.0:4780`. If `WTR_AUTH_TOKEN` is unset, it generates a strong token and prints it; enter that token in the browser login screen. Open <http://127.0.0.1:4780> locally or `http://<machine-lan-ip>:4780` from another private-network device. Production serves the built React application and API from one Node process.

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
pnpm test:integration:real # disposable real Git/gtr/tmux/node-pty suite
pnpm test:web              # Playwright desktop/mobile tests
pnpm typecheck
pnpm lint
pnpm build
```

Turbo caches package builds and runs workspace dependencies in graph order. Playwright needs `pnpm exec playwright install chromium` once.

## First use

Register a repository:

```sh
wtr project add ~/Projects/example
```

Create a worktree and Pi terminal in one operation:

```sh
wtr spawn \
  --project ~/Projects/example \
  --branch investigate-cache \
  --name researcher \
  -- pi
```

Create another terminal from anywhere inside that worktree:

```sh
wtr terminal create \
  --worktree . \
  --name dev \
  -- pnpm dev
```

The web UI provides the same project, worktree, terminal, finish, discard, and bulk-cleanup operations. Command input is always an argv array. Shell syntax has no special meaning unless an explicit shell is launched, for example `-- /bin/zsh -lc 'one && two'`.

## CLI

All machine-relevant commands support `--json`. The CLI calls the daemon API and does not duplicate lifecycle logic.

```text
wtr project add <path>
wtr project list
wtr project clean <id-or-path> [--preview]

wtr worktree list [--project <id-or-path>]
wtr worktree create --project <id-or-path> --branch <branch> [--from-current]
wtr worktree finish <id-or-path-or-dot>
wtr worktree discard <id-or-path-or-dot> --confirm <branch>

wtr terminal list [--worktree <id-or-path>]
wtr terminal create --worktree <id-or-path-or-dot> --name <name> [-- <command> args...]
wtr terminal delete <terminal-id>

wtr spawn --project <id-or-path-or-dot> --branch <branch> --name <name> [-- <command> args...]
wtr diagnostics
```

Each terminal receives `WTR_API_URL`, `WTR_PROJECT_ID`, `WTR_WORKTREE_ID`, and `WTR_TERMINAL_ID`. A Pi process can therefore call `wtr` to create a child worktree/terminal or clean its own worktree. Cleanup is persisted as a daemon-owned operation and returns an operation ID before the daemon terminates the requesting tmux server. CLI exit codes are stable: `0` success, `1` unexpected failure, `2` usage, `3` daemon unreachable, `4` authentication, and `5` API/domain refusal.

## Runtime model

For worktree `wt_…`, wtr generates a socket name such as `wtr-wt-a8f…`. Every terminal gets its own generated tmux session such as `wtr-term-2c1…`:

```text
worktree SQLite ID
└── dedicated tmux server/socket
    ├── one session for Pi
    ├── one session for pnpm dev
    └── one session for a shell
```

Identifiers never come from branch names or paths. `packages/core/src/launcher.ts` reads an application-owned JSON launch spec and uses Node `spawn(..., { shell: false })`, preserving spaces, quotes, Unicode, semicolons, and dollar signs literally.

The generated tmux configuration is stored in the wtr runtime directory. It does not read or modify `~/.tmux.conf`. It disables the status bar, uses `tmux-256color`, retains dead panes and scrollback, and never restarts exited commands. SQLite stores status and intended mappings; tmux remains the runtime source of truth.

## Browser and phone handoff

Opening a terminal creates a temporary `node-pty` process attached to its existing tmux session. Closing the browser kills only that tmux client; the command continues. Reopening on desktop or phone attaches to the same session and never relaunches Pi.

Multiple clients can view a terminal. One client holds the input/resize lease. Select **Take control** on another client to transfer it without replacing the tmux session. The controlling client drives tmux’s `window-size latest` sizing. A brief resize when clients with very different dimensions hand off is an inherent tmux limitation; viewers may also see letterboxing until they take control.

The responsive PWA has a mobile drawer, full-screen xterm.js view, reconnect behavior, and Esc/Ctrl/Alt/Tab/Enter/arrow accessory keys. The application shell can load from its service-worker cache, but terminal sessions are never represented as available offline.

For private phone access without opening a LAN listener, use `pnpm start:local` and publish it through Tailscale Serve:

```sh
tailscale serve --bg http://127.0.0.1:4780
```

Use your tailnet HTTPS URL on the phone. Tailscale configuration is not managed by wtr.

## PR status and cleanup

Linked worktrees show `open`, `merged`, `closed`, `no_pr`, or `unknown`. Status comes from structured `gh pr list --json` output and is cached briefly. If `gh` is unavailable or unauthenticated, the UI shows `unknown`; it never invents a PR result.

**Finish** is safe and refuses the main checkout, staged changes, unstaged changes, untracked files, or an unconfirmed merge. A merge is confirmed by either a merged GitHub PR or Git ancestry after fetching `origin/<default-branch>`. On acceptance the daemon:

1. marks the worktree `cleaning` and blocks new terminals;
2. kills the entire worktree tmux server;
3. removes the worktree with `git gtr rm --yes --delete-branch`;
4. marks metadata removed only after gtr succeeds.

If gtr fails after terminals stop, the worktree remains as `cleanup_failed` with the error and can be retried.

**Discard** permits dirty/unmerged removal but requires the exact branch name. It kills the whole tmux server and uses the installed gtr force-removal option. It is never allowed for the main checkout.

**Clean merged worktrees** previews every linked worktree and runs the same safe finish logic per eligible branch. Dirty worktrees are never force-removed in bulk. Although the adapter detects `git gtr clean --merged --dry-run`, V1 deliberately uses per-worktree `git gtr rm` because gtr preview text is not a stable machine-readable contract.

## API

The versioned JSON surface is under `/api`:

```text
GET  /api/health                     GET/POST /api/auth/session
GET  /api/diagnostics                GET      /api/events (SSE)
GET/POST /api/projects               GET/DELETE /api/projects/:projectId
POST /api/projects/:projectId/refresh
GET/POST /api/projects/:projectId/worktrees
GET  /api/worktrees/:worktreeId
POST /api/worktrees/:worktreeId/terminals
GET  /api/worktrees/:worktreeId/finish-preview
GET  /api/worktrees/:worktreeId/discard-preview
POST /api/worktrees/:worktreeId/finish
POST /api/worktrees/:worktreeId/discard
POST /api/worktrees/:worktreeId/pr/refresh
GET/PATCH/DELETE /api/terminals/:terminalId
WS   /api/terminals/:terminalId/attach
POST /api/spawn
GET  /api/projects/:projectId/cleanup-preview
POST /api/projects/:projectId/cleanup
GET  /api/operations/:operationId
```

Errors use `{ "error": { "code", "message", "details"? } }`. SSE emits project, worktree, terminal, controller, and cleanup changes.

## Configuration and data

Localhost defaults require no environment variables. See `.env.example` for:

- `WTR_HOST`, `WTR_PORT`, `WTR_AUTH_TOKEN`
- `WTR_DATABASE_PATH`, `WTR_DATA_DIR`, `WTR_RUNTIME_DIR`
- `WTR_SHELL`, `WTR_TMUX_PATH`, `WTR_GIT_PATH`, `WTR_GH_PATH`
- `WTR_API_URL`

Default database locations:

- macOS: `~/Library/Application Support/wtr/wtr.db`
- Linux/XDG: `${XDG_DATA_HOME:-~/.local/share}/wtr/wtr.db`

Schema tables are `projects`, `worktrees`, `terminals`, `operations`, and `schema_migrations`. Terminal output is never written to SQLite or application logs.

## Security assumptions

wtr is arbitrary terminal access. The daemon itself defaults to `127.0.0.1`; the root `pnpm start` convenience command intentionally selects `0.0.0.0` and always supplies authentication, generating and printing a token when necessary. Use `pnpm start:local` for the loopback-only default. CLI requests use a bearer token from the environment; browsers exchange the token for an HttpOnly, SameSite session cookie so secrets are not put in WebSocket URLs. Repository/worktree paths are canonicalized, API bodies are validated with Zod, and external commands use argument arrays without interpolated shell strings.

This is a single-user, single-daemon local tool. It does not provide internet hosting, multi-user authorization, sandboxing, or a cloud relay. Use a private reverse proxy such as Tailscale Serve rather than exposing the daemon publicly.
