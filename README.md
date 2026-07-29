# Treeport

> **Local/trusted-network use only; no authentication yet.** Do not expose Treeport directly to the internet. See the [security guide](apps/docs/src/content/docs/security.md).
>
> Treeport was built quickly because I needed the tool myself. Some parts were scaffolded in the fastest way that worked, so please don’t laugh at the code too hard. I’ll clean up the mess as the core workflow stabilizes.

**Use Git worktrees as your development task system.**

Treeport turns every Git worktree into a persistent workspace. Run coding agents, shells, development servers, test watchers, and normal TUIs, then reconnect to the same sessions from the desktop app, browser, or phone.

Treeport works with worktrees created by Git, editors, agents, scripts, and other tools. Git remains the source of truth; Treeport provides persistent terminals, navigation, and conservative cleanup around it.

## Quick start

Requirements: macOS, Git, and tmux 3.2+.

```sh
curl -fsSL https://treeport.app/install.sh | sh
treeport up
```

The installer provides a private Node.js runtime. If Node.js 24+ is already installed, npm can install the same package:

```sh
npm install --global @treeport/treeport
treeport up
```

Treeport prints its local URL, `http://127.0.0.1:8733`. Run `treeport open` to open it.

## Documentation

Read the documentation at [treeport.app](https://treeport.app).

## Development

Contributor requirements: Node.js 24+, pnpm 11, Git, and tmux 3.2+.

`pnpm dev` starts the daemon, web UI, and Electron app together using available per-worktree ports.

```sh
pnpm install
pnpm dev
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

## Releases

Releases are prepared and published from a maintainer's machine. From a clean, up-to-date `main` branch:

```sh
pnpm release:prepare X.Y.Z
gh release create vX.Y.Z --verify-tag --title vX.Y.Z --generate-notes
npm login
pnpm release:publish X.Y.Z
```

Preparation updates the npm package and curl installer together, runs the complete checks, commits, tags, and pushes. Publication verifies the tag and published GitHub Release before publishing `@treeport/treeport` with npm tag `latest`.
