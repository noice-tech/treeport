# Treeport

**Persistent terminals for Git worktrees.**

Treeport's core is under active development. Treeport is already usable for daily development work, but some interfaces can change.

Treeport gives each Git worktree a persistent workspace called a tree. Your terminals continue to run when you disconnect.

Reconnect from the macOS app, a browser, or a phone. Use your existing agents, shells, editors, and development tools without changing their interfaces.

Treeport finds worktrees that Git, editors, agents, and scripts create. Git remains the source of truth.

## Quick start

Treeport supports macOS and Linux. It requires Node.js 24+, npm, Git, and tmux 3.2+.

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

## Why Treeport

- **Persistent terminals:** Processes continue when all clients disconnect.
- **Worktree-first navigation:** Each tree keeps its terminals and tools together.
- **Normal terminal interfaces:** Run Pi, Claude Code, Codex, shells, servers, and other TUIs.
- **Multiple clients:** Reconnect from the macOS app or a supported browser.
- **Tool-independent discovery:** Use worktrees created by Git, editors, agents, or scripts.

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

Contributor requirements are Node.js 24+, pnpm 11, Git, and tmux 3.2+.

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
