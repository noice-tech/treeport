# Treeport

**A place for your agents to work.**

Treeport is a workspace for coding agents, terminals, browser tabs, and custom apps. Run an agent, open the app it's building, and review its changes in the same tree.

Treeport is also what Mitchell Hashimoto calls an [agentic inbox](https://mitchellh.com/writing/program-status-osc7501): "a single view across every running agent showing which are working, which are done, and which are waiting on you."

> [!NOTE]
> Treeport's core is under active development. It is already usable for daily development work, but some interfaces can change.

## Features

- 🌳 **A workspace for each task.** Create a tree for each task. Each tree has its own Git worktree and apps, keeping files and sessions separate while you work on several changes. You can also open existing worktrees or ordinary folders.
- 🤖 **Agents and their tools.** Run an agent and a development server in separate persistent terminals, then open the result in a browser. The Pi integration lets your agent manage terminals, interact with visible browser tabs, and work in separate trees.
- 🌐 **Browsers and custom apps.** Open websites and development servers in browser tabs that you and your agent can use. Add a diff viewer, editor, dashboard, or another project tool as a web app, and install packages to add apps and reusable terminal commands to any project.
- ♾️ **Keep work running.** Agents, development servers, and other terminal programs keep running when you close the client or disconnect. Reconnect from the macOS app or a browser, including from another computer or phone through Tailscale.

## Install

Treeport runs on macOS and Linux. It requires Node.js 24+, npm, and Git.

### Fork it (recommended)

We recommend forking Treeport and changing it however you want. Contributions are welcome.

You'll also need pnpm. [Fork the repository](https://github.com/noice-tech/treeport/fork), then clone your fork and start Treeport:

```sh
git clone https://github.com/YOUR-USERNAME/treeport.git
cd treeport
pnpm install
pnpm dev
```

`pnpm dev` starts the backend, web interface, and Electron app for your checkout. You do not need to install the server or desktop client separately.

For access from other devices, use `pnpm dev:tailscale` instead. Tailscale must be connected with MagicDNS enabled.

### Install from npm

```sh
npm install --global @treeport/treeport
treeport /path/to/project
```

This starts the server and opens your project in the desktop client or browser. Run `treeport update` to update.

### macOS app

The macOS app is a client for a Treeport server on the same Mac or another computer. Download the DMG from the [latest release](https://github.com/noice-tech/treeport/releases/latest).

See [Install Treeport](https://treeport.app/getting-started/installation/) for details. To connect from another device, use [private remote access](https://treeport.app/features/remote-access/). Do not expose Treeport directly to the public internet.

## Documentation

- [Install Treeport](https://treeport.app/getting-started/installation/)
- [Projects, trees, and apps](https://treeport.app/concepts/projects-worktrees-terminals/)
- [Coding agents](https://treeport.app/building-apps/coding-agents/)
- [Browser tabs](https://treeport.app/features/browser-app/)
- [Web apps](https://treeport.app/features/web-apps/)
- [Packages](https://treeport.app/features/packages/)
- [Persistent terminals](https://treeport.app/features/persistent-terminals/)
- [Remote access](https://treeport.app/features/remote-access/)

## Contributing

Run the complete local pull-request check before you submit a change:

```sh
pnpm ci:local
```

## License

Treeport uses the [MIT License](LICENSE).
