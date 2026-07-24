# TaskTTY

**Turn Git worktrees into task workspaces.**

TaskTTY gives every worktree its own persistent terminals for agents, shells, and development servers. Open them in the Electron app or a browser, switch between tasks instantly, and pick up from any connected client without restarting anything.

It works with the Git worktrees you already have. No migration, custom task format, or replacement terminal UI required.

## Highlights

- **Worktrees are tasks** — each Git worktree becomes a focused workspace with its own terminals.
- **Desktop and browser** — use the Electron app, a desktop browser, or the responsive web UI on another device.
- **Fully synchronized terminals** — terminals live in tmux and persist across navigation, reloads, disconnects, and clients. Multiple viewers share one canonical terminal size, with control handed off automatically when you interact.
- **Fast keyboard navigation** — create worktrees and terminals, close terminals, switch projects, and jump between terminal tabs with shortcuts.
- **Terminal-aware notifications** — titles, OSC `9;4` progress, and unread BEL activity surface across worktrees and terminal tabs, even when a terminal is not open.
- **Built for agents** — the included Agent Skill and CLI let agents inspect their context, create persistent terminals and worktrees, wait for terminal activity, and spawn child tasks you can immediately open.
- **Bring your existing setup** — TaskTTY discovers main and linked Git worktrees and leaves their branches, paths, and terminal TUIs alone.

TaskTTY is intentionally not an editor, Git client, or chat renderer. It is the workspace around your terminals.

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
