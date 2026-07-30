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

This command reads the connected machine's Tailscale address and binds **only** Vite to that address. The API remains on loopback and is reachable solely through Vite's API and WebSocket proxy. It prints the tailnet URL to open from another device.

It fails before starting if Tailscale is missing, disconnected, or has no Tailscale address, with the next step (`tailscale up`) in the error. It does not configure Tailscale Serve and never uses Tailscale Funnel or another public tunnel.

Tailscale encrypts the network path, but Treeport currently has no application authentication. Give tailnet access only to people who may control terminals and worktrees. Do not expose this URL through a public proxy.

This contributor-only mode is independent of `treeport remote enable`. That production workflow uses Tailscale Serve to proxy a loopback daemon and retains its own saved settings; starting or stopping `pnpm dev:tailscale` does not alter them.

## Intentional LAN testing

`pnpm dev:lan` remains available for testing from a trusted local network. It is deliberately separate from `pnpm dev` because it binds Vite to every interface and exposes an unauthenticated app. The API still stays loopback-only behind Vite's proxy. Prefer Tailscale mode whenever remote testing is possible.
