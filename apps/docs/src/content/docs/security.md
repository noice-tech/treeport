---
title: Security
description: Run Treeport only on a local or trusted private network.
---

Treeport provides arbitrary terminal access and currently has **no authentication**. Anyone who can reach the service can read terminal output, send terminal input, create processes, and operate on registered worktrees.

## Safe default

Run the daemon on loopback:

```sh
pnpm start:local
```

This listens at `127.0.0.1:4780` and limits access to the local machine.

## Remote access

If you need browser or phone access, expose Treeport only through a trusted private network such as Tailscale. Bind deliberately and ensure untrusted devices cannot reach the port.

```sh
TREEPORT_HOST=0.0.0.0 pnpm start
```

:::danger
Do not port-forward Treeport from your router, place it on a public host, or publish it through an unauthenticated public tunnel or reverse proxy.
:::

## Operational guidance

- Register only repositories you are comfortable controlling through Treeport.
- Treat terminal output and scrollback as sensitive; it may contain source code or command output.
- Do not put secrets in terminal names, command arguments, or URLs.
- Keep Git, tmux, Node.js, Treeport, and your private-network software updated.
- Stop the daemon when remote access is no longer needed.

`TREEPORT_API_URL` tells launched terminals and the CLI how to reach the daemon. It does not add authentication or encryption.
