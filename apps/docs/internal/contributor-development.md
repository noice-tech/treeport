---
title: Contributor development
summary: Run Treeport locally or share a development system through Tailscale.
---

## Start local development

Run the standard contributor command:

```sh
pnpm dev
```

The development application binds to `127.0.0.1`. It is not available from the LAN or tailnet.

The first development driver uses port `8733`. A concurrent worktree uses the next available port.

The driver prints the local application URL.

One listener supplies the web interface, API, terminal WebSockets, and Vite hot reload.

## Start private remote development

Install Tailscale and connect the development computer:

```sh
tailscale up
```

Start private remote development:

```sh
pnpm dev:tailscale
```

This command keeps the Treeport application and Electron development renderer on loopback.

It adds a temporary Tailscale Serve route and prints a local URL and private HTTPS URL.

Use the local URL on the development computer. Use the Tailscale URL from another permitted device.

When the development command stops, it removes the route.

A later start removes a retained route after an interrupted development process.

The command stops before application start when Tailscale is missing or disconnected.

It also stops when Tailscale does not report a MagicDNS name. The error gives the next action.

The command does not use Tailscale Funnel or a public tunnel.

Tailscale encrypts the connection and supplies the user identity that Treeport requires.

Give tailnet access only to users who can control the terminals and worktrees.

Do not expose the URL through Funnel, a public proxy, or a direct network listener.

This contributor function is separate from `treeport remote enable`.

Both functions use Tailscale Serve. Production keeps a saved route, but development selects and owns a temporary route.
