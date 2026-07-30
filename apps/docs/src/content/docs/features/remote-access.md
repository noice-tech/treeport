---
title: Remote access
description: Open Treeport privately from other devices in your Tailscale network.
---

Treeport can expose its local web UI through [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve). This keeps the daemon bound to loopback while Tailscale provides private HTTPS access within your tailnet.

:::caution
Treeport has no application authentication. Anyone permitted by your Tailscale access policy can control its terminals and worktrees. Do not use Tailscale Funnel or any public proxy with Treeport.
:::

## Enable remote access

Install Tailscale, sign in to your tailnet, and connect this machine first:

```sh
tailscale up
```

Then enable Treeport's endpoint:

```sh
treeport remote enable
```

This starts the loopback daemon if necessary and prints a URL like:

```text
https://laptop.tailnet.ts.net:8733
```

Open that URL from a device allowed by your tailnet policy. Local use is unchanged: browsers on the host can continue using `http://127.0.0.1:8733`.

A VPS is supported when Treeport listens only on its loopback interface and Tailscale Serve provides the private HTTPS endpoint. The fact that the VPS itself has a public address does not make the Treeport service public.

## Connect the desktop app

The desktop app starts with **This computer** at `http://127.0.0.1:8733`. Click the computer name in its title bar, choose **Connect to another computer…**, and enter the HTTPS URL printed by `treeport remote enable`.

## Ports and other Serve apps

Treeport uses HTTPS port `8733` by default. A dedicated port prevents it from replacing another application's shared HTTPS root route. If that port is occupied, choose a different one:

```sh
treeport remote enable --port 8734
```

Treeport refuses to overwrite an endpoint already using the selected port.

## Persistence and status

Tailscale Serve keeps its configuration independently of the Treeport CLI process, and Treeport saves the selected port and expected loopback target. Once enabled, ordinary `treeport up` restarts make Treeport available through the existing remote URL; running `remote enable` again is unnecessary.

Check the configuration at any time:

```sh
treeport remote status
```

If the route was removed or changed outside Treeport, status reports it as unavailable. Re-enable it only after confirming the port is still appropriate.

## Disable remote access

```sh
treeport remote disable
```

Treeport removes only the root Serve route it created. If someone changed that route, Treeport leaves it intact and only removes its own saved preference.

## Troubleshooting

- If Tailscale is not installed, Treeport links to the Tailscale download page and asks you to run `tailscale up`.
- If Tailscale is disconnected, reconnect it with `tailscale up`.
- Access is governed by your tailnet's ACLs and grants. Update them in the Tailscale admin console when another person or device cannot open the URL.
