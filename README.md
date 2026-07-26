# Treeport

**Use Git worktrees as your development task system.**

Treeport turns every Git worktree into a persistent workspace for a piece of work. Each worktree can run any number of terminals—coding agents, shells, development servers, test watchers, and normal TUIs—and you can reopen the same sessions from the desktop app, browser, or phone without restarting them.

```text
Repository
├── main worktree
│   ├── shell
│   └── dev server
├── investigate-terminal-resize
│   ├── Pi
│   ├── test watcher
│   └── shell
└── improve-mobile-layout
    ├── Claude Code
    └── dev server
```

## The bet

Treeport is built around a deliberately opinionated idea:

> **A worktree is a piece of work.**

A worktree already contains the concrete state of a development task:

- an isolated checkout;
- a known starting revision;
- local changes and commits;
- an optional branch and pull request;
- running agents and development processes;
- a natural point at which the work can be finished or discarded.

Treeport does not add a parallel task database that can drift away from Git. Git remains authoritative. When a worktree exists, the work still exists.

## Works with the tools you already use

Treeport discovers the main checkout and every linked worktree reported by Git, including worktrees created outside Treeport.

Create or open a worktree using:

- Treeport;
- Zed;
- the Git CLI;
- an agent or script;
- another compatible worktree tool.

Treeport sees the same worktree and can attach persistent terminals to it. There is no import ceremony and no separate Treeport-only workspace hierarchy.

## Real terminals with application-style navigation

Treeport runs normal terminal applications rather than replacing them with a provider-specific chat interface.

The desktop companion provides familiar tabbed-application behavior:

- `Cmd+T` / `Ctrl+T` creates a terminal;
- `Cmd+W` / `Ctrl+W` closes one using Treeport's normal safety checks;
- mouse and keyboard navigation work outside a nested terminal multiplexer UI.

The browser and responsive PWA expose the same worktrees and terminal sessions. Closing a browser or switching devices only detaches the current client; the underlying process continues running.

Applications can optionally publish titles, attention, and progress through standard terminal protocols. See [Terminal signals and progressive enhancement](docs/terminal-signals.md).

## What Treeport owns

Treeport owns:

- discovery and durable identity of Git repositories and worktrees;
- persistent terminals associated with each worktree;
- browser, mobile, and desktop navigation;
- terminal attention and runtime metadata;
- agent- and script-friendly CLI and HTTP APIs;
- conservative worktree cleanup.

Git owns:

- worktree inventory;
- branches and commits;
- staged, unstaged, untracked, and conflicted state;
- the actual checkout contents.

## What Treeport is not

Treeport is intentionally not:

- an editor or file browser;
- a Git commit or diff UI;
- an issue tracker or task board;
- a normalized coding-agent chat renderer;
- a cloud-agent platform;
- a general-purpose terminal multiplexer.

Use your existing editor, Git tools, and coding agents. Treeport provides the persistent worktree and terminal layer around them.

## Design principles

### Worktrees are first-class

Treeport does not treat Git worktrees as an invisible implementation detail. Their paths, branches, revisions, dirty state, and pull requests remain visible because they are useful development context.

Human-friendly titles and reminders may be layered onto worktrees, but they do not replace their Git identity.

### External state is normal

Treeport assumes repositories and worktrees may be changed by other tools. It continuously reconciles its view with Git instead of requiring exclusive ownership.

### Terminal applications stay terminal applications

Pi, Claude Code, Codex, shells, development servers, and arbitrary TUIs run normally. Treeport attaches to them; it does not reinterpret their interfaces or constrain their capabilities.

### Cleanup must be safer than creation

Creating a worktree should be cheap. Removing one must account for dirty files, conflicted state, detached commits, active terminals, filesystem identity, and changes that occurred after confirmation.

Treeport prefers refusing an ambiguous cleanup over deleting the wrong directory.

## Product decisions

Treeport is intentionally opinionated. See:

- [Product principles](docs/product-principles.md)
- [Terminal signals and progressive enhancement](docs/terminal-signals.md)
- [Decision 0001: Worktrees are the unit of work](docs/decisions/0001-worktrees-are-the-unit-of-work.md)
- [Decision 0002: The product is named Treeport](docs/decisions/0002-product-is-named-treeport.md)

## Quick start

Requirements: Node.js 22+, Git, and tmux 3.2+. `gh` is optional for pull request status.

```sh
pnpm install
pnpm build
pnpm --global add ./packages/cli
pnpm start:local
```

Open <http://127.0.0.1:4780>, then add a repository:

```sh
treeport project add ~/Projects/example
```

Treeport will discover its existing worktrees. You can also create a worktree and start a terminal in one command:

```sh
treeport spawn \
  --project ~/Projects/example \
  --worktree-name investigate-cache \
  --name agent \
  -- pi
```

Or create another persistent terminal inside the current worktree:

```sh
treeport terminal create --worktree . --name dev -- pnpm dev
```

## Desktop app

Development requires Node.js 24+ because it uses [Portless](https://portless.sh/) to give every Git worktree its own local URL. Run the server, web app, CLI watcher, and Electron companion together:

```sh
pnpm dev
```

The primary checkout is available at `https://treeport.localhost`. When Tailscale is installed and connected, Portless also prints a stable Tailscale URL for access from your tailnet. Linked worktrees use a branch-prefixed local URL such as `https://fix-ui.treeport.localhost`; only the primary checkout claims the stable Tailscale endpoint. Portless may ask to trust its local certificate authority on the first run; `pnpm portless:trust` performs that one-time setup explicitly.

Each checkout keeps development-only database and runtime state under `.treeport-dev/`; `pnpm dev` never reads Treeport's packaged application data. Initialize the primary checkout's development database once during repository setup. Treeport's Zed-compatible `create_worktree` tasks then install dependencies and make a SQLite-safe snapshot of that database for each linked worktree, with new tmux socket names.

Snapshots retain real repository and worktree paths so development can operate on those checkouts, while database, runtime, ports, and terminal servers remain isolated per checkout.

Use `pnpm dev:direct` to bypass Portless and run the previous fixed-port development workflow. It still uses the checkout-local development database and runtime directory.

Useful shortcuts include:

| Action         | macOS     | Windows / Linux |
| -------------- | --------- | --------------- |
| New worktree   | `⌘N`      | `Ctrl+N`        |
| New terminal   | `⌘T`      | `Ctrl+T`        |
| Close terminal | `⌘W`      | `Ctrl+W`        |
| Switch project | `⌘⇧P`     | `Ctrl+Shift+P`  |
| Terminal 1–9   | `⌘1`–`⌘9` | —               |

The Electron app and browser use the same Treeport server and terminal sessions.

## Agent Skill

Treeport includes a portable [Agent Skills](https://agentskills.io/)-compatible skill at [`skills/treeport/SKILL.md`](skills/treeport/SKILL.md). It teaches agents how to safely work with Treeport-managed terminals and worktrees.

Install it for a project:

```sh
mkdir -p .agents/skills
cp -R /path/to/treeport/skills/treeport .agents/skills/treeport
```

Or install it for your user:

```sh
mkdir -p ~/.agents/skills
cp -R /path/to/treeport/skills/treeport ~/.agents/skills/treeport
```

From a managed terminal, agents can use `treeport context` to discover where they are, `treeport terminal create` to start observable background work, and `treeport spawn` to create a new worktree and terminal as a child task.

## Development

```sh
pnpm dev
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

See [`.env.example`](.env.example) for server and runtime configuration.

## Security

Treeport provides arbitrary terminal access and currently has no authentication. The daemon defaults to loopback; keep it local or expose it only through a trusted private network such as Tailscale. Do not publish it directly to the internet.
