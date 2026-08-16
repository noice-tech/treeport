# Treeport

> **Local/trusted-network use only; no authentication yet.** Do not expose Treeport directly to the internet. See the [security guide](apps/docs/src/content/docs/security.md).
>
> Treeport was built quickly because I needed the tool myself. Some parts were scaffolded in the fastest way that worked, so please don’t laugh at the code too hard. I’ll clean up the mess as the core workflow stabilizes.

**Use Trees as your development task system.**

A Tree is Treeport's persistent workspace for a Git worktree. Run coding agents, shells, development servers, test watchers, and normal TUIs. Then, reconnect from the desktop app, browser, or phone.

Treeport finds Git worktrees that Git, editors, agents, scripts, and other tools create. It shows each worktree as a Tree. Git remains the source of truth.

## Quick start

Requirements: macOS or Linux, Node.js 24+, npm, Git, and tmux 3.2+.

```sh
curl -fsSL https://treeport.app/install.sh | sh
cd /path/to/repository
treeport .
```

The installer uses your existing Node.js installation. You can alternatively install the same package directly with npm:

```sh
npm install --global @treeport/treeport
cd /path/to/repository
treeport .
```

Treeport starts its local backend if needed, registers the repository and its Trees, and opens the current Tree in the desktop app or browser. Run `treeport start` to start only the backend and print its local URL, `http://127.0.0.1:8733`. Use `treeport service enable` when a host must start Treeport after reboot.

## Documentation

Read the documentation at [treeport.app](https://treeport.app).

## Development

Contributor requirements: Node.js 24+, pnpm 11, Git, and tmux 3.2+.

`pnpm dev` starts the daemon, web UI, and Electron app together using available per-Tree ports. It binds both development services to loopback by default.

```sh
pnpm install
pnpm dev
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

For private tailnet testing, run `tailscale up` and then `pnpm dev:tailscale`. The development stack stays on loopback for local browser and Electron use, while a temporary Tailscale Serve route provides remote access. Tailscale Funnel and direct LAN listeners are not supported. See the [contributor development guide](apps/docs/src/content/docs/building-apps/contributing.md) for the security model.

## Releases

Start a release from a clean, up-to-date `main` branch:

```sh
pnpm release:prepare X.Y.Z
```

Preparation updates the npm package, desktop client, and curl installer together, runs the complete checks, commits, tags, and atomically pushes `main` and `vX.Y.Z`. The tag starts the desktop release workflow. CI builds a signed and notarized universal macOS app, attaches its DMG and updater ZIP to one draft GitHub Release, verifies them, and publishes that same release.

After the workflow succeeds, publish the npm package from the maintainer's authenticated machine:

```sh
npm login
pnpm release:publish X.Y.Z
```

Publication verifies the tag, the single published GitHub Release, and both desktop assets before publishing `@treeport/treeport` with npm tag `latest`. Do not create the GitHub Release manually.
