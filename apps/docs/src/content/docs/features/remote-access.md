---
title: Remote access
description: Open Treeport privately from other devices through Tailscale Serve.
---

Use [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) to access Treeport from another computer or phone.

## Enable remote access

Install Tailscale on the host and connecting device. Sign in to the same tailnet, then run this command on the host:

```sh
tailscale serve --bg http://127.0.0.1:8733
```

Open the printed HTTPS URL from a permitted, user-owned Tailscale device. To enable the desktop app's **Open on phone** shortcut, set `TREEPORT_REMOTE_URL` to that URL when starting the server.

In the macOS app, select the computer name, then **Connect to another computer…**. Enter the same URL.

Tailscale controls access. Treeport does not require a separate login.

:::caution
Anyone with access can control terminals and trees. Allow only trusted users.

Keep the backend on loopback. Do not use Tailscale Funnel or expose Treeport directly to the public internet.
:::

## See who is connected

Treeport shows other people in the workspace. Select the people button to see their focused app or background status.

## Manage access

- `tailscale serve status` checks the private endpoint.
- `tailscale serve --https=443 off` removes that HTTPS route.

You manage Tailscale directly. Use the port configured for your server if it differs from 8733.

Use [Service supervision](/features/service-supervision/) to start the backend automatically.
