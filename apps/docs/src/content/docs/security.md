---
title: Security
description: Run Treeport only on a local or trusted private network.
---

Treeport provides arbitrary terminal access and currently has **no application authentication**. Anyone who can reach the service can read terminal output, send terminal input, create processes, and operate on registered worktrees. Loopback access relies on the local OS-user boundary; recommended remote access relies on Tailscale identity plus tailnet ACLs and grants.

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

The desktop app applies the same boundary: HTTP is accepted only for loopback computers, while remote computers require HTTPS with a certificate trusted by the operating system. It uses the Mac's existing Tailscale access rather than creating a Treeport login session. It does not offer a certificate-warning bypass and does not expose its saved computer list to remote Treeport web content.

For advanced direct private-network binding, prefer a specific Tailscale address over every interface:

```sh
treeport up --host "$(tailscale ip -4)"
```

## Repository and package boundary

Registering a repository authorizes Treeport to read package settings from its main worktree and terminal presets from each registered worktree. Review declared packages and `.treeport/terminal-presets.json` commands before using them.

Treeport does not execute repository terminal presets during registration or when a repository is opened. A repository preset starts only after you select it in the panel picker. It launches an ordinary terminal with a literal executable and argument array rather than an implicit shell command.

Treeport packages do not execute daemon modules or install server hooks. Managed npm operations always disable lifecycle scripts. Package terminal presets use the same explicit-selection and literal-argument boundary.

Opening a web panel authorizes Treeport's fixed Vite profile to transform its HTML, TypeScript/TSX, CSS, imports, and assets. Treeport does not load package Vite configuration, executable Babel or PostCSS configuration, package plugins, build scripts, or lifecycle scripts. Npm-installed panel output is served only from Treeport's immutable build cache; source and compiled asset routes reject traversal and escaping symbolic links. Panel JavaScript still runs after you open the panel and remains inside Treeport's scoped iframe runtime.

These limits reduce automatic package execution, but selected terminal commands and opened hosted panels still act on a trusted registered worktree. Inspect panel source and its runtime dependencies as well as the package manifest.

A hosted panel can request the `same-origin` permission. This permission weakens the iframe boundary. Panel code can potentially read or change the Treeport page, use Treeport browser storage, call same-origin routes, make direct HTTP or HTTPS requests, and remove its sandbox attribute. Install and open such a panel only when you trust its source and runtime dependencies. Panels without this permission keep an opaque origin.

The Browser package can load an arbitrary HTTP or HTTPS site in a nested iframe. The package relays only the target's client-local title message. The target cannot use context, diff, storage, launch, external URL, shortcut, or workspace navigation methods. Browser iframe restrictions remain in effect, and Treeport does not bypass a target's framing policy.

## Operational guidance

- Register only repositories you are comfortable controlling through Treeport.
- Treat terminal output and scrollback as sensitive; it may contain source code or command output.
- Do not put secrets in terminal names, command arguments, or URLs.
- Keep Git, tmux, Node.js, Treeport, and your private-network software updated.
- Stop the daemon when remote access is no longer needed.

`TREEPORT_API_URL` tells launched terminals and the CLI how to reach the daemon. It does not add authentication or encryption. Tailscale Serve is the recommended remote-access path because the daemon remains loopback-only.
