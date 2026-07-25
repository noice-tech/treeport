# TaskTTY

**Use Git worktrees as your development task system.**

TaskTTY turns every Git worktree into a persistent workspace for a piece of work. Each worktree can run any number of terminals—coding agents, shells, development servers, test watchers, and normal TUIs—and you can reopen the same sessions from the desktop app, browser, or phone without restarting them.

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

TaskTTY is built around a deliberately opinionated idea:

> **A worktree is a piece of work.**

A worktree already contains the concrete state of a development task:

* an isolated checkout;
* a known starting revision;
* local changes and commits;
* an optional branch and pull request;
* running agents and development processes;
* a natural point at which the work can be finished or discarded.

TaskTTY does not add a parallel task database that can drift away from Git. Git remains authoritative. When a worktree exists, the work still exists.

## Works with the tools you already use

TaskTTY discovers the main checkout and every linked worktree reported by Git, including worktrees created outside TaskTTY.

Create or open a worktree using:

* TaskTTY;
* Zed;
* the Git CLI;
* an agent or script;
* another compatible worktree tool.

TaskTTY sees the same worktree and can attach persistent terminals to it. There is no import ceremony and no separate TaskTTY-only workspace hierarchy.

## Real terminals with application-style navigation

TaskTTY runs normal terminal applications rather than replacing them with a provider-specific chat interface.

The desktop companion provides familiar tabbed-application behavior:

* `Cmd+T` / `Ctrl+T` creates a terminal;
* `Cmd+W` / `Ctrl+W` closes one using TaskTTY's normal safety checks;
* mouse and keyboard navigation work outside a nested terminal multiplexer UI.

The browser and responsive PWA expose the same worktrees and terminal sessions. Closing a browser or switching devices only detaches the current client; the underlying process continues running.

Applications can optionally publish titles, attention, and progress through standard terminal protocols. See [Terminal signals and progressive enhancement](docs/terminal-signals.md).

## What TaskTTY owns

TaskTTY owns:

* discovery and durable identity of Git repositories and worktrees;
* persistent terminals associated with each worktree;
* browser, mobile, and desktop navigation;
* terminal attention and runtime metadata;
* agent- and script-friendly CLI and HTTP APIs;
* conservative worktree cleanup.

Git owns:

* worktree inventory;
* branches and commits;
* staged, unstaged, untracked, and conflicted state;
* the actual checkout contents.

## What TaskTTY is not

TaskTTY is intentionally not:

* an editor or file browser;
* a Git commit or diff UI;
* an issue tracker or task board;
* a normalized coding-agent chat renderer;
* a cloud-agent platform;
* a general-purpose terminal multiplexer.

Use your existing editor, Git tools, and coding agents. TaskTTY provides the persistent worktree and terminal layer around them.

## Design principles

### Worktrees are first-class

TaskTTY does not treat Git worktrees as an invisible implementation detail. Their paths, branches, revisions, dirty state, and pull requests remain visible because they are useful development context.

Human-friendly titles and reminders may be layered onto worktrees, but they do not replace their Git identity.

### External state is normal

TaskTTY assumes repositories and worktrees may be changed by other tools. It continuously reconciles its view with Git instead of requiring exclusive ownership.

### Terminal applications stay terminal applications

Pi, Claude Code, Codex, shells, development servers, and arbitrary TUIs run normally. TaskTTY attaches to them; it does not reinterpret their interfaces or constrain their capabilities.

### Cleanup must be safer than creation

Creating a worktree should be cheap. Removing one must account for dirty files, conflicted state, detached commits, active terminals, filesystem identity, and changes that occurred after confirmation.

TaskTTY prefers refusing an ambiguous cleanup over deleting the wrong directory.

## Product decisions

TaskTTY is intentionally opinionated. See:

- [Product principles](docs/product-principles.md)
- [Terminal signals and progressive enhancement](docs/terminal-signals.md)
- [Decision 0001: Worktrees are the unit of work](docs/decisions/0001-worktrees-are-the-unit-of-work.md)

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
tasktty project add ~/Projects/example
```

TaskTTY will discover its existing worktrees. You can also create a worktree and start a terminal in one command:

```sh
tasktty spawn \
  --project ~/Projects/example \
  --worktree-name investigate-cache \
  --name agent \
  -- pi
```

Or create another persistent terminal inside the current worktree:

```sh
tasktty terminal create --worktree . --name dev -- pnpm dev
```

## Desktop app

Run the server, web app, and Electron companion together during development:

```sh
pnpm dev
```

Useful shortcuts include:

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| New worktree | `⌘N` | `Ctrl+N` |
| New terminal | `⌘T` | `Ctrl+T` |
| Close terminal | `⌘W` | `Ctrl+W` |
| Switch project | `⌘⇧P` | `Ctrl+Shift+P` |
| Terminal 1–9 | `⌘1`–`⌘9` | — |

The Electron app and browser use the same TaskTTY server and terminal sessions.

## Agent Skill

TaskTTY includes a portable [Agent Skills](https://agentskills.io/)-compatible skill at [`skills/tasktty/SKILL.md`](skills/tasktty/SKILL.md). It teaches agents how to safely work with TaskTTY-managed terminals and worktrees.

Install it for a project:

```sh
mkdir -p .agents/skills
cp -R /path/to/tasktty/skills/tasktty .agents/skills/tasktty
```

Or install it for your user:

```sh
mkdir -p ~/.agents/skills
cp -R /path/to/tasktty/skills/tasktty ~/.agents/skills/tasktty
```

From a managed terminal, agents can use `tasktty context` to discover where they are, `tasktty terminal create` to start observable background work, and `tasktty spawn` to create a new worktree and terminal as a child task.

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

TaskTTY provides arbitrary terminal access and currently has no authentication. The daemon defaults to loopback; keep it local or expose it only through a trusted private network such as Tailscale. Do not publish it directly to the internet.
