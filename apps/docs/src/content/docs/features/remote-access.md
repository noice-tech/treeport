---
title: Remote access
description: Open Treeport privately from other devices through Tailscale Serve.
---

Treeport supports remote access through [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve). The daemon stays on loopback. Serve provides private HTTPS, authenticates each remote user, and adds that user's Tailscale identity to HTTP and Socket.IO requests. Treeport rejects remote requests without this identity.

Your tailnet ACLs and grants decide who can use the endpoint. Every permitted user can control Treeport terminals and worktrees.

:::caution
Do not use Tailscale Funnel, a public proxy, an arbitrary reverse proxy, or a direct LAN listener with Treeport. A tagged Tailscale device does not provide a user identity header and cannot use Treeport remote access.
:::

## Enable remote access

Install Tailscale, sign in to your tailnet, and connect this machine:

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

Open that URL from a user-owned device allowed by your tailnet policy. Tailscale supplies the user identity on each request. Treeport does not show a separate login or create a second session.

Local use is unchanged. Browsers and commands on the host continue to use `http://127.0.0.1:8733`.

A VPS is supported when Treeport listens only on loopback and Tailscale Serve provides the private HTTPS endpoint. The VPS public address must not provide a direct route to Treeport.

## Connect the desktop app

The desktop app starts with **This computer** at `http://127.0.0.1:8733`. Click the computer name in its title bar, choose **Connect to another computer…**, and enter the HTTPS URL printed by `treeport remote enable`.

The app uses the Mac's existing Tailscale connection. There is no separate Treeport credential prompt. The app requires an operating-system-trusted HTTPS certificate and does not offer an insecure certificate bypass.

## Connect the CLI

A CLI on another permitted tailnet device can use the same Serve URL:

```sh
TREEPORT_API_URL=https://laptop.tailnet.ts.net:8733 \
  treeport project list
```

Tailscale Serve authenticates the request. The CLI does not create or store a Treeport credential. Keep daemon lifecycle commands such as `start`, `stop`, `service`, and `remote` on the computer that runs Treeport.

## Ports and other Serve apps

Treeport uses HTTPS port `8733` by default. A dedicated port prevents Treeport from replacing another application's shared HTTPS root route. If that port is occupied, choose a different one:

```sh
treeport remote enable --port 8734
```

Treeport refuses to overwrite an endpoint already using the selected port.

## Persistence and status

Tailscale Serve keeps its configuration independently of the Treeport CLI process. Treeport saves the selected port and expected loopback target. Once enabled, ordinary `treeport start` operations make Treeport available through the existing remote URL.

For recovery after a host reboot, explicitly enable [service supervision](/features/service-supervision/). Treeport does not rewrite the Serve route when launchd or systemd restarts the loopback daemon. The same private URL becomes available when the local daemon is healthy again.

Check the configuration at any time:

```sh
treeport remote status
```

If the route was removed or changed outside Treeport, status reports it as unavailable. Re-enable it only after you confirm that the port is still appropriate.

## Disable remote access

```sh
treeport remote disable
```

Treeport removes only the root Serve route that it created. If someone changed that route, Treeport leaves it intact and removes only its saved preference.

## Why Tailscale?

Treeport currently supports remote access only through Tailscale Serve. This narrow scope lets Treeport keep the daemon on loopback and use a clear, reviewed security boundary.

We know this creates a dependency on Tailscale. We would like to support other secure private-network and authenticated-proxy designs in the future. Proposals and contributions are welcome in [issue #274](https://github.com/noice-tech/treeport/issues/274).

Do not work around this limitation by exposing Treeport directly to a LAN or the public internet. Treeport provides full terminal access. Any future alternative must authenticate HTTP, Socket.IO, desktop, and CLI traffic and must fail closed.

## Troubleshooting

- If Tailscale is not installed, Treeport links to the Tailscale download page and asks you to run `tailscale up`.
- If Tailscale is disconnected, reconnect it with `tailscale up`.
- If Treeport returns `401`, confirm that you used the Serve URL from a user-owned Tailscale device. Tagged devices do not provide the required user identity.
- Access is governed by your tailnet's ACLs and grants. Update them in the Tailscale admin console when another user or device cannot open the URL.
- If an old non-loopback listener preference prevents startup, run `treeport start --host 127.0.0.1`, then use `treeport remote enable`.
