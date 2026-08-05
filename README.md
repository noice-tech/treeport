# Treeport

> **Local/trusted-network use only; no authentication yet.** Do not expose Treeport directly to the internet. See the [security guide](apps/docs/src/content/docs/security.md).
>
> Treeport was built quickly because I needed the tool myself. Some parts were scaffolded in the fastest way that worked, so please don’t laugh at the code too hard. I’ll clean up the mess as the core workflow stabilizes.

**Use Git worktrees as your development task system.**

Treeport turns every Git worktree into a persistent workspace. Run coding agents, shells, development servers, test watchers, and normal TUIs, then reconnect to the same sessions from the desktop app, browser, or phone.

Treeport works with worktrees created by Git, editors, agents, scripts, and other tools. Git remains the source of truth; Treeport provides persistent terminals, navigation, and conservative cleanup around it.

## Quick start

Requirements: macOS or Linux, Node.js 24+, npm, Git, and tmux 3.2+.

```sh
curl -fsSL https://treeport.app/install.sh | sh
treeport up
```

The installer uses your existing Node.js installation. You can alternatively install the same package directly with npm:

```sh
npm install --global @treeport/treeport
treeport up
```

Treeport prints its local URL, `http://127.0.0.1:8733`, when it starts.

## Documentation

Read the documentation at [treeport.app](https://treeport.app).

## Development

Contributor requirements: Node.js 24+, pnpm 11, Git, and tmux 3.2+.

`pnpm dev` starts the daemon, web UI, and Electron app together using available per-worktree ports. It binds both development services to loopback by default.

```sh
pnpm install
pnpm dev
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

For private tailnet testing, run `tailscale up` and then `pnpm dev:tailscale`. The development stack stays on loopback for local browser and Electron use, while a temporary Tailscale Serve route provides remote access. Tailscale Funnel is never used. `pnpm dev:lan` is an explicit, unauthenticated trusted-LAN escape hatch. See the [contributor development guide](apps/docs/src/content/docs/building-apps/contributing.md) for the security model.

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
