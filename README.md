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

## Run it

[Fork Treeport](https://github.com/noice-tech/treeport/fork) and run the server yourself; there are no npm installations or prebuilt downloads.

```sh
gh repo fork noice-tech/treeport --clone && cd treeport
pnpm install --frozen-lockfile && pnpm cli:install && pnpm start
```

To update, run `pnpm sync`.

See [Run Treeport](https://treeport.app/getting-started/installation/) for prerequisites, the CLI, updates, and desktop builds. [Service supervision](https://treeport.app/features/service-supervision/) covers optional pm2 setup. For another device, configure [private remote access](https://treeport.app/features/remote-access/); do not expose Treeport directly to the public internet.

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
