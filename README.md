# Treeport

> **Early alpha**
>
> **Local/trusted-network use only; no authentication yet.** Do not expose Treeport directly to the internet. See the [security guide](apps/docs/src/content/docs/security.md).
>
> Treeport was built quickly because I needed the tool myself. Some parts were scaffolded in the fastest way that worked, so please don’t laugh at the code too hard. I’ll clean up the mess as the core workflow stabilizes.

**Use Git worktrees as your development task system.**

Treeport turns every Git worktree into a persistent workspace. Run coding agents, shells, development servers, test watchers, and normal TUIs, then reconnect to the same sessions from the desktop app, browser, or phone.

Treeport works with worktrees created by Git, editors, agents, scripts, and other tools. Git remains the source of truth; Treeport provides persistent terminals, navigation, and conservative cleanup around it.

## Quick start

Requirements: Node.js 22+, pnpm 11, Git, and tmux 3.2+. `gh` is optional.

```sh
pnpm install
pnpm build
pnpm --global add ./packages/cli
pnpm start:local
```

Open <http://127.0.0.1:4780> and register a repository:

```sh
treeport project add ~/Projects/example
```

## Documentation

Documentation lives in [`apps/docs`](apps/docs). Start the documentation site locally with:

```sh
pnpm dev:docs
```

See [Install Treeport](apps/docs/src/content/docs/getting-started/installation.md) for setup and [Your first workspace](apps/docs/src/content/docs/getting-started/first-workspace.md) to get started.

## Development

```sh
pnpm dev
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```
