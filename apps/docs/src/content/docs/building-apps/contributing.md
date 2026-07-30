---
title: Contributor development
summary: Run Treeport locally, or share a development stack privately through Tailscale.
---

## Local development

`pnpm dev` is the normal contributor command. Both Vite and the Treeport API bind to `127.0.0.1`; nothing is reachable from the LAN or tailnet.

```sh
pnpm dev
```

The development driver chooses unused per-worktree ports and prints the local web URL. The Vite server proxies `/api`, including the Socket.IO WebSocket upgrade, to the loopback API so browser terminals, live project updates, and hot reload work from the one web URL.

## Private remote development

To open the development stack from another device, install Tailscale, connect the development machine, then run:

```sh
tailscale up
pnpm dev:tailscale
```

This command keeps Vite, the API, and the Electron app on loopback, just like ordinary local development. It adds a temporary Tailscale Serve route in front of Vite and prints both URLs: use the local URL on the development machine and the HTTPS Tailscale URL from another device. The route is removed when the development command stops.

It fails before starting if Tailscale is missing, disconnected, or does not report a MagicDNS name, with the next step in the error. It never uses Tailscale Funnel or another public tunnel.

Tailscale encrypts the network path, but Treeport currently has no application authentication. Give tailnet access only to people who may control terminals and worktrees. Do not expose this URL through a public proxy.

This contributor-only mode is independent of `treeport remote enable`. Both use Tailscale Serve, but the production workflow retains its saved route while development chooses an unused port and owns only its temporary route.

## Intentional LAN testing

`pnpm dev:lan` remains available for testing from a trusted local network. It is deliberately separate from `pnpm dev` because it binds Vite to every interface and exposes an unauthenticated app. The API still stays loopback-only behind Vite's proxy. Prefer Tailscale mode whenever remote testing is possible.
