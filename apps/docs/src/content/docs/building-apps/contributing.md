---
title: Contributor development
summary: Run Treeport locally, or share a development stack privately through Tailscale.
---

## Local development

`pnpm dev` is the normal contributor command. The Treeport app binds to `127.0.0.1`; nothing is reachable from the LAN or tailnet.

```sh
pnpm dev
```

The development driver starts at port `8733`, chooses the next unused port for concurrent worktrees, and prints the local app URL. The same listener serves the web UI, API, terminal WebSockets, and Vite hot reload.

## Private remote development

To open the development stack from another device, install Tailscale, connect the development machine, then run:

```sh
tailscale up
pnpm dev:tailscale
```

This command keeps the Treeport app and Electron development renderer on loopback, just like ordinary local development. It adds a temporary Tailscale Serve route in front of the app and prints both URLs: use the local URL on the development machine and the HTTPS Tailscale URL from another device. The route is removed when the development command stops, and a later run cleans up routes retained after an interrupted development process.

It fails before starting if Tailscale is missing, disconnected, or does not report a MagicDNS name, with the next step in the error. It never uses Tailscale Funnel or another public tunnel.

Tailscale encrypts the network path and supplies the remote user identity that Treeport requires. Give tailnet access only to people who may control terminals and worktrees. Do not expose this URL through Funnel, a public proxy, or a direct network listener.

This contributor-only mode is independent of `treeport remote enable`. Both use Tailscale Serve, but the production workflow retains its saved route while development chooses an unused port and owns only its temporary route.
