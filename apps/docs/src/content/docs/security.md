---
title: Security
description: Understand the local, remote, repository, and package security boundaries.
---

Treeport gives full terminal access.

An authorized user can read terminal output, send input, create processes, and change registered trees.

Direct access is limited to loopback. It uses the local operating-system user as the security boundary.

Supported remote access uses Tailscale Serve identity with tailnet ACLs and grants.

Treeport requires the Tailscale user identity on remote HTTP and Socket.IO requests. It does not create a separate login or session.

## Use the safe default

Start the daemon with the loopback default:

```sh
treeport start
```

Treeport listens at `127.0.0.1:8733`. Only clients on the local computer can connect directly.

## Configure remote access safely

For remote browser, desktop, phone, or CLI access, use [Tailscale Serve](/features/remote-access/).

The daemon stays on loopback. Tailscale Serve authenticates the user.

Treeport rejects a remote request that does not contain the Tailscale identity.

:::danger
Do not configure router port forwarding, a LAN listener, Tailscale Funnel, an arbitrary tunnel, or an arbitrary reverse proxy.
:::

A private network does not authenticate a user by itself.

On a virtual private server, keep the daemon on loopback. Use Tailscale Serve as the only private connection point.

Service mode does not change the network boundary. The backend continues to listen only on loopback.

On macOS, normal service mode uses a per-user LaunchAgent and does not require administrator access.

Advanced headless mode uses a system LaunchDaemon. An administrator must approve changes to its root-owned definition.

Both macOS modes run Treeport as the user who enabled the service.

On Linux, Treeport uses the systemd manager for that user. The backend never runs as the root user.

The desktop client permits HTTP only for loopback computers. A remote computer requires HTTPS with an operating-system-trusted certificate.

The client does not permit a certificate-warning exception. It does not give saved computer information to remote Treeport web content.

Tailscale controls login, device authentication, key expiration, access removal, and access policy.

Keep the access policy narrow. A tagged device does not supply a user identity and cannot use Treeport remote access.

## Review repository configuration

When you register a project, Treeport can read these files:

- package settings from the project root;
- native terminal presets from each registered tree;
- compatible `.zed/tasks.json` tasks from a repository main tree.

Review packages, `.treeport/terminal-presets.json`, and `.zed/tasks.json` commands before you use them.

Treeport does not run manual repository presets during registration or when you open a repository.

A native preset or compatible Zed task starts only after you select it.

Native presets use one executable and a literal argument array.

A Zed command with shell syntax runs through the configured shell. Treat this command as executable repository configuration.

Automatic Zed `create_worktree` hooks use the separate [tree setup rules](/features/worktree-setup-hooks/#zed-compatibility).

## Review packages and web panels

Treeport packages cannot load daemon modules or install server hooks. Treeport disables lifecycle scripts for all managed npm operations.

Package terminal presets use explicit selection, one executable, and literal arguments.

When you open a web panel, Treeport uses a fixed Vite profile to transform its files.

Treeport does not load package Vite configuration, executable Babel configuration, executable PostCSS configuration, plug-ins, or build scripts.

Treeport serves installed panel output only from its fixed build cache. Source and asset routes reject path traversal and escaping symbolic links.

Panel JavaScript runs after you open the panel. It stays in the Treeport iframe runtime.

These limits reduce automatic package execution. However, selected commands and open panels still operate on a trusted registered tree.

Review the panel source, runtime dependencies, and package manifest.

### High-trust panel permission

A hosted panel can request the `same-origin` permission. This permission makes the iframe boundary weaker.

Panel code can potentially:

- read or change the Treeport page;
- use Treeport browser storage;
- call same-origin routes;
- make direct HTTP or HTTPS requests;
- remove its sandbox attribute.

Approve and open this panel only when you trust its source and runtime dependencies.

A panel without this permission keeps an opaque origin.

Treeport shows the panel source and permissions before the first open.

A grant applies to the exact package source, scope, panel definition, and permission set.

Treeport requests approval again when the permission set changes. Removing the package revokes its grants.

### Browser boundaries

Browser does not use a web-panel package permission.

In the desktop app, Browser runs as the desktop operating-system user.

It can reach local and internet sites available from the desktop computer.

In a web client, the isolated browser runs as the daemon operating-system user.

It can reach local and internet sites available from the daemon computer.

Each Browser session uses separate temporary browser data.

Treeport does not use, import, or attach to a personal browser profile.

Treeport authorizes each daemon browser action for the owning Browser and tree.

Treeport does not expose direct daemon browser-control or debugging access.

The server accepts only absolute HTTP or HTTPS addresses without credentials.

Closing Browser deletes its temporary browser data.

Close requires confirmation only when the site uses `beforeunload`.

## Follow these operating rules

- Register only folders and repositories that you permit Treeport to control.
- Treat terminal output and history as sensitive information.
- Do not put secrets in terminal names, command arguments, or URLs.
- Keep Git, tmux, Node.js, Treeport, and Tailscale updated.
- Stop the daemon when you do not need remote access.
- Disable service mode when Treeport must not start after a reboot.

`TREEPORT_API_URL` tells managed terminals and the CLI how to connect to the daemon.

The URL does not add authentication or encryption.

For remote use, set it only to the private HTTPS URL from `treeport remote enable`.
