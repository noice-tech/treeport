# Treeport

**Persistent terminals for Git worktrees.**

Give each task an isolated Git worktree. Keep its agents, terminals, servers, and development tools active in one place.

## Features

- 🌳 **One task, one tree.** Keep each branch, agent, server, and test watcher in an isolated Git worktree.
- 🤖 **Parallel coding agents.** The bundled skill lets agents create child trees and terminals while you monitor their work or take control.
- ♾️ **Persistent terminal sessions.** Disconnect without stopping processes. Reconnect later with the same terminal history and state.
- 🔔 **Attention without constant watching.** See terminal titles, progress, exit states, and notifications when a task needs you.
- 🖥️ **Your terminal tools still work.** Run Pi, Claude Code, Codex, shells, servers, and other TUIs with their normal interfaces.
- 🧩 **More than terminal tabs.** Start reusable presets, open development servers beside terminals, and build custom web panels for each tree.
- 📱 **Access from another device.** Reconnect from the macOS app, a browser, or a phone through private Tailscale access.
- 🔧 **Git stays in control.** Treeport finds worktrees made by Git, editors, agents, and scripts instead of replacing them.

> [!NOTE]
> Treeport's core is under active development. It is already usable for daily development work, but some interfaces can change.

## Quick start

Treeport supports macOS and Linux. It requires Node.js 24+, npm, and Git.

```sh
npm install --global @treeport/treeport
treeport start
```

`treeport start` starts the local backend and prints its URL. The default URL is `http://127.0.0.1:8733`.

Open the URL. Then, select **Open project** and choose a Git repository.

To start Treeport automatically after login or reboot, enable its operating-system service:

```sh
treeport service enable
```

See the [installation guide](https://treeport.app/getting-started/installation/) for the macOS app, updates, and service options.

## Security

> [!IMPORTANT]
> Treeport gives users full terminal access. Keep the backend on loopback unless you configure [supported private remote access](https://treeport.app/features/remote-access/).
>
> Do not expose Treeport directly to the public internet. Read the [security guide](https://treeport.app/security/).

## Documentation

- [Install Treeport](https://treeport.app/getting-started/installation/)
- [Understand projects, trees, and terminals](https://treeport.app/concepts/projects-worktrees-terminals/)
- [Configure persistent service mode](https://treeport.app/features/service-supervision/)
- [Connect through Tailscale](https://treeport.app/features/remote-access/)
- [Use the CLI](https://treeport.app/reference/cli/)

## Development

Contributor requirements are Node.js 24+, pnpm 11, and Git.

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts the daemon, web interface, and Electron app with separate ports for this tree.

Run the complete local pull-request check before you submit a change:

```sh
pnpm ci:local
```

## License

Treeport uses the [MIT License](LICENSE).
