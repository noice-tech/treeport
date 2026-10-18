---
title: Install Treeport
description: Install Treeport and open your first project.
---

Treeport has a server and a client. The server runs on the machine that holds your projects and keeps your terminals and agents running. You connect to it with the macOS app or a web browser, on the same machine or another device.

Closing the client does not stop the server or its terminal processes.

## Server

Install the server on the machine where you want your projects and agents to run. It requires macOS or Linux, Node.js 24+, npm, and Git.

### Fork it

We recommend forking [Treeport](https://github.com/noice-tech/treeport) and changing it however you want. Contributions are welcome.

You'll also need pnpm. Fork the repository on GitHub, then:

1. Clone your fork:

   ```sh
   git clone https://github.com/YOUR-USERNAME/treeport.git
   ```

2. Enter the directory, install dependencies, and start Treeport:

   ```sh
   cd treeport
   pnpm install
   pnpm dev
   ```

   For access from other devices, use `pnpm dev:tailscale` instead of `pnpm dev`. Tailscale must be connected with MagicDNS enabled.

3. Start working. Modify Treeport to suit your workflow.

`pnpm dev` starts both the server and clients for your checkout: the backend, web interface, and Electron app. You do not need to install the server or desktop client separately.

### Install from npm

```sh
npm install --global @treeport/treeport
treeport /path/to/project
```

This starts the server and opens your project in the desktop client or browser.

To start the server automatically, enable [service supervision](/features/service-supervision/).

## Client

Choose the macOS app or a web browser. Both connect to the Treeport server; the macOS app does not include the server.

### Web browser

The server includes the web interface, so you do not need to install a separate browser client. Run `treeport /path/to/project` on the server machine to open your project.

To connect from another computer or phone, set up [remote access](/features/remote-access/) on the server and open the printed HTTPS URL in your browser.

### macOS app

Download the DMG from the [latest release](https://github.com/noice-tech/treeport/releases/latest).
Drag **Treeport** to Applications, then open it.

Requires macOS 12+ on Apple Silicon or Intel. Connect to a server on the same Mac, or use [remote access](/features/remote-access/) to connect to another computer.

## Start working

1. Open or create a tree for your task.
2. Use **New app** to open a terminal and start your [coding agent](/building-apps/coding-agents/).
3. Open another terminal for a development server, then add a [Browser](/features/browser-app/) app to check the result.
4. Add [custom web apps](/features/web-apps/) from your project or installed packages.

See [Projects, trees, and apps](/concepts/projects-worktrees-terminals/) for how the workspace fits together.

## Updates

For an npm installation, run `treeport update` on the server machine. The macOS client offers its own updates.

If an update fails, reinstall the latest release.
