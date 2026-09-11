---
title: Remote access
description: Open Treeport privately from other devices through Tailscale Serve.
---

Use [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) to access Treeport from another computer or phone.

## Enable remote access

Install Tailscale on the host and connecting device. Sign in to the same tailnet, then run this command on the host:

```sh
treeport remote enable
```

Open the printed HTTPS URL from a permitted, user-owned Tailscale device.

In the macOS app, select the computer name, then **Connect to another computer…**. Enter the same URL.

Tailscale controls access. Treeport does not require a separate login.

:::caution
Anyone with access can control terminals and trees. Allow only trusted users.

Keep the backend on loopback. Do not use Tailscale Funnel or expose Treeport directly to the public internet.
:::

## See who is connected

Treeport shows other people in the workspace. Select the people button to see their focused panel or background status.

## Manage access

- `treeport remote status` checks the private endpoint.
- `treeport remote disable` removes Treeport's remote access route.

Use [Service supervision](/features/service-supervision/) to start the backend automatically.
