# Treeport

**Persistent terminals for Git worktrees.**

Give each task an isolated Git worktree. Keep its agents, terminals, servers, and development tools active in one place.

## Features

- 🌳 **One task, one tree.** Keep each branch, agent, server, and test watcher in an isolated Git worktree.
- 🤖 **Pi support.** Pi is the only supported coding agent integration for now.
- ♾️ **Persistent terminal sessions.** Disconnect without stopping processes. Reconnect later with the same terminal history and state.
- 🔔 **Attention without constant watching.** See terminal titles, progress, exit states, and notifications when a task needs you.
- 🖥️ **Your terminal tools still work.** Run Pi, shells, servers, and other TUIs with their normal interfaces.
- 🧩 **More than terminal tabs.** Start reusable presets, open development servers beside terminals, and build custom web panels for each tree.
- 📱 **Access from another device.** Reconnect from the macOS app, a browser, or a phone through private Tailscale access.
- 🔧 **Git stays in control.** Treeport finds worktrees made by Git, editors, agents, and scripts instead of replacing them.

> [!NOTE]
> Treeport's core is under active development. It is already usable for daily development work, but some interfaces can change.

## Quick start

Treeport supports macOS and Linux. It requires Node.js 24+, npm, and Git.

```sh
npm install --global @treeport/treeport
treeport /path/to/project
```

See [Install Treeport](https://treeport.app/getting-started/installation/) for the macOS app and updates.

For another device, use [private remote access](https://treeport.app/features/remote-access/). Do not expose Treeport directly to the public internet.

## Documentation

- [Install Treeport](https://treeport.app/getting-started/installation/)
- [Understand projects, trees, and terminals](https://treeport.app/concepts/projects-worktrees-terminals/)
- [Configure persistent service mode](https://treeport.app/features/service-supervision/)
- [Connect through Tailscale](https://treeport.app/features/remote-access/)
- [Coding agents](https://treeport.app/building-apps/coding-agents/)

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
