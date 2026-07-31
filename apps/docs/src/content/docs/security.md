---
title: Security
description: Run Treeport only on a local or trusted private network.
---

Treeport provides arbitrary terminal access and currently has **no authentication**. Anyone who can reach the service can read terminal output, send terminal input, create processes, and operate on registered worktrees.

## Safe default

Start the daemon with its loopback default:

```sh
treeport up
```

This listens at `127.0.0.1:8733` and limits access to the local machine.

## Remote access

For browser or phone access, use [private remote access through Tailscale Serve](/features/remote-access/). It keeps Treeport bound to loopback and relies on your tailnet access policy.

:::danger
Do not port-forward Treeport from your router, bind it to a public interface, publish it through Tailscale Funnel, or use an unauthenticated public tunnel or reverse proxy. Running Treeport on a VPS is safe only when the daemon stays on loopback and a trusted private layer such as Tailscale Serve controls access.
:::

The desktop app applies the same boundary: HTTP is accepted only for loopback computers, while remote computers require HTTPS with a certificate trusted by the operating system. It does not offer a certificate-warning bypass and does not expose its saved computer list to remote Treeport web content.

For advanced direct private-network binding, prefer a specific Tailscale address over every interface:

```sh
treeport up --host "$(tailscale ip -4)"
```

## Operational guidance

- Register only repositories you are comfortable controlling through Treeport.
- Treat terminal output and scrollback as sensitive; it may contain source code or command output.
- Do not put secrets in terminal names, command arguments, or URLs.
- Keep Git, tmux, Node.js, Treeport, and your private-network software updated.
- Stop the daemon when remote access is no longer needed.

`TREEPORT_API_URL` tells launched terminals and the CLI how to reach the daemon. It does not add authentication or encryption. Tailscale Serve is the recommended remote-access path because the daemon remains loopback-only.
