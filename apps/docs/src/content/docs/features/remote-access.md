---
title: Remote access
description: Open Treeport privately from other devices through Tailscale Serve.
---

Treeport supports remote access through [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).

The daemon stays on loopback. Tailscale Serve supplies private HTTPS and authenticates each remote user.

Serve adds the Tailscale user identity to HTTP and Socket.IO requests. Treeport rejects remote requests that do not have this identity.

Your tailnet ACLs and grants control access. Each permitted user can control Treeport terminals and Trees.

:::caution
Do not use Tailscale Funnel, a public proxy, an arbitrary reverse proxy, or a direct network listener.
:::

A tagged Tailscale device does not supply a user identity. Thus, a tagged device cannot use Treeport remote access.

## Enable remote access

1. Install Tailscale.
2. Sign in to your tailnet.
3. Connect this computer:

```sh
tailscale up
```

Enable the Treeport endpoint:

```sh
treeport remote enable
```

This command starts the loopback daemon when necessary. It prints a URL similar to this URL:

```text
https://laptop.tailnet.ts.net:8733
```

Open this URL from a user-owned device that your tailnet policy permits.

Tailscale supplies the user identity on each request. Treeport does not show a separate login or create a second session.

Local access does not change. Browsers and commands on the host continue to use `http://127.0.0.1:8733`.

You can install Treeport on a virtual private server. Keep the daemon on loopback, and use Tailscale Serve for private HTTPS.

Do not make Treeport available through the public address of the server.

## Connect the desktop client

The desktop client starts with **This computer** at `http://127.0.0.1:8733`.

1. Select the computer name in the title bar.
2. Select **Connect to another computer…**.
3. Enter the HTTPS URL from `treeport remote enable`.

The desktop client uses the current Tailscale connection on the Mac. It does not request separate Treeport credentials.

The client requires an HTTPS certificate that the operating system trusts. It does not permit an insecure certificate exception.

## Connect the CLI

On another permitted tailnet device, set `TREEPORT_API_URL` to the Serve URL:

```sh
TREEPORT_API_URL=https://laptop.tailnet.ts.net:8733 \
  treeport project list
```

Tailscale Serve authenticates the request. The CLI does not create or save a Treeport credential.

Run lifecycle commands on the computer that runs Treeport. These commands include `start`, `stop`, `service`, and `remote`.

## Select a different port

Treeport uses HTTPS port `8733` by default. This dedicated port prevents a conflict with another Serve application at its root route.

If the port is in use, select a different port:

```sh
treeport remote enable --port 8734
```

Treeport does not replace an endpoint that already uses the selected port.

## Check persistence and status

Tailscale Serve keeps its configuration separately from the Treeport CLI process.

Treeport saves the selected port and loopback target. After setup, `treeport start` makes Treeport available at the saved remote URL.

For recovery after a reboot, enable [service supervision](/features/service-supervision/).

Treeport does not change the Serve route when launchd or systemd restarts the daemon.

When the daemon is healthy again, the same private URL becomes available.

Check remote access:

```sh
treeport remote status
```

If another process changed or removed the route, the status command reports that it is not available.

Confirm that the port is correct before you enable the route again.

## Disable remote access

Run:

```sh
treeport remote disable
```

Treeport removes only the root Serve route that it created.

If another process changed that route, Treeport keeps the route and removes only its saved preference.

## Supported remote access boundary

Treeport currently supports only Tailscale Serve for remote access.

This limit keeps the daemon on loopback and supplies one reviewed authentication boundary.

Support for other authenticated private-network systems can be proposed in [issue #274](https://github.com/noice-tech/treeport/issues/274).

Do not work around this limit with a LAN listener or public internet access.

Treeport gives full terminal access. A future alternative must authenticate HTTP, Socket.IO, desktop, and CLI traffic.

It must also stop access when authentication fails.

## Correct common problems

- If Tailscale is not installed, install it and run `tailscale up`.
- If Tailscale is disconnected, run `tailscale up`.
- If Treeport returns `401`, use the Serve URL from a user-owned Tailscale device.
- If another user cannot connect, review the tailnet ACLs and grants in the Tailscale administration console.
- If an old listener preference prevents startup, run `treeport start --host 127.0.0.1`.
- After you repair the listener, run `treeport remote enable`.
