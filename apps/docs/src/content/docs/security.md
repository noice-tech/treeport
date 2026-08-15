---
title: Security
description: Understand Treeport's local and Tailscale security boundaries.
---

Treeport provides arbitrary terminal access. Anyone authorized to use the service can read terminal output, send terminal input, create processes, and operate on registered worktrees.

Direct access is restricted to loopback and relies on the local OS-user boundary. Supported remote access relies on Tailscale Serve identity plus tailnet ACLs and grants. Treeport requires the proxy-provided Tailscale user identity on remote HTTP and Socket.IO requests, but it does not create a second application login or session.

## Safe default

Start the daemon with its loopback default:

```sh
treeport start
```

This listens at `127.0.0.1:8733` and limits access to the local machine.

## Remote access

For browser, desktop, phone, or remote CLI access, use [private remote access through Tailscale Serve](/features/remote-access/). The daemon stays on loopback. Serve authenticates the Tailscale user, and Treeport rejects remote requests that do not contain that identity.

:::danger
Do not port-forward Treeport from your router, bind it to a LAN or Tailscale address, publish it through Tailscale Funnel, or use an arbitrary tunnel or reverse proxy. A private network alone does not authenticate a user. Running Treeport on a VPS is safe only when the daemon stays on loopback and Tailscale Serve is the private ingress.
:::

Opt-in [service supervision](/features/service-supervision/) does not change this network boundary. The backend still listens only on loopback. On macOS, the administrator installs a system LaunchDaemon definition, but launchd runs Treeport as the user who enabled it. On Linux, Treeport uses that user's systemd manager. Treeport never runs the backend as root.

The desktop app applies the same boundary: HTTP is accepted only for loopback computers, while remote computers require HTTPS with a certificate trusted by the operating system. It uses the Mac's existing Tailscale access rather than creating a Treeport login session. It does not offer a certificate-warning bypass and does not expose its saved computer list to remote Treeport web content.

Tailscale owns user login, device authentication, key expiration, revocation, and access policy. Keep policy narrow. A tagged device does not supply a user identity and cannot use Treeport remote access.

## Repository and package boundary

Registering a repository authorizes Treeport to read package settings and compatible `.zed/tasks.json` tasks from its main worktree, plus native terminal presets from each registered worktree. Review declared packages, `.treeport/terminal-presets.json`, and `.zed/tasks.json` commands before using them.

Treeport does not execute manual repository terminal presets during registration or when a repository is opened. A native preset or compatible Zed task starts only after you select it in the panel picker. Native presets launch an ordinary terminal with a literal executable and argument array. A Zed `command` containing shell syntax intentionally runs through Treeport's configured shell, so treat it as executable repository configuration. Automatic Zed `create_worktree` hooks remain separately governed by the [worktree setup rules](/features/worktree-setup-hooks/#zed-compatibility).

Treeport packages do not execute daemon modules or install server hooks. Managed npm operations always disable lifecycle scripts. Package terminal presets use the same explicit-selection and literal-argument boundary.

Opening a web panel authorizes Treeport's fixed Vite profile to transform its HTML, TypeScript/TSX, CSS, imports, and assets. Treeport does not load package Vite configuration, executable Babel or PostCSS configuration, package plugins, build scripts, or lifecycle scripts. Npm-installed panel output is served only from Treeport's immutable build cache; source and compiled asset routes reject traversal and escaping symbolic links. Panel JavaScript still runs after you open the panel and remains inside Treeport's scoped iframe runtime.

These limits reduce automatic package execution, but selected terminal commands and opened hosted panels still act on a trusted registered worktree. Inspect panel source and its runtime dependencies as well as the package manifest.

A hosted panel can request the `same-origin` permission. This permission weakens the iframe boundary. Panel code can potentially read or change the Treeport page, use Treeport browser storage, call same-origin routes, make direct HTTP or HTTPS requests, and remove its sandbox attribute. Install and open such a panel only when you trust its source and runtime dependencies. Panels without this permission keep an opaque origin.

:::caution[TODO: confirm panel permissions]
Treeport does not yet ask for confirmation before it loads a panel that declares permissions. Treeport must require explicit confirmation once, show the panel and its permissions, and ask again if the permissions change. This work is tracked in [issue #259](https://github.com/noice-tech/treeport/issues/259).
:::

The Browser package can load an arbitrary HTTP or HTTPS site in a nested iframe. The package relays the target's client-local title message and, when the target includes the panel SDK, stores reported URL changes for navigation restoration. The target cannot use context, diff, storage, shortcuts, or workspace navigation methods. Browser iframe restrictions remain in effect, and Treeport does not bypass a target's framing policy.

## Operational guidance

- Register only repositories you are comfortable controlling through Treeport.
- Treat terminal output and scrollback as sensitive; it may contain source code or command output.
- Do not put secrets in terminal names, command arguments, or URLs.
- Keep Git, tmux, Node.js, Treeport, and your private-network software updated.
- Stop the daemon when remote access is no longer needed. Disable service supervision when it must not return after reboot.

`TREEPORT_API_URL` tells launched terminals and the CLI how to reach the daemon. The URL does not add authentication or encryption. For remote use, set it only to the private HTTPS URL created by `treeport remote enable`; Tailscale Serve authenticates that request while the daemon remains loopback-only.
