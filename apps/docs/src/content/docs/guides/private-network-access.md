---
title: Private-network access
description: Reach Treeport from another trusted device without publishing it to the internet.
---

Treeport's responsive web app makes it useful from another computer or phone, but remote access must stay private because Treeport currently has no authentication.

## Recommended topology

Use a device-to-device private network such as Tailscale:

```text
Trusted phone ─┐
               ├── private encrypted network ── Treeport host:4780
Trusted laptop ┘
```

1. Join the Treeport host and client devices to the same trusted private network.
2. Start Treeport on a reachable interface:

   ```sh
   TREEPORT_HOST=0.0.0.0 pnpm start
   ```

3. Open `http://<private-host-address>:4780` from the trusted client.
4. Use host firewall rules or private-network access controls to restrict which devices can connect.

The `pnpm start` command prints a warning when it binds beyond loopback.

## What not to do

Do not expose port 4780 directly to the public internet. A public DNS name, TLS certificate, or reverse proxy does not by itself provide authentication. An unauthenticated visitor would still receive terminal access.

Return to loopback-only access with:

```sh
pnpm start:local
```

See [Security](/security/) for the full threat model and operational guidance.
