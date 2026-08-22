---
title: Install Treeport
description: Install the Treeport backend and macOS desktop client.
---

The Treeport backend supports macOS and Linux.

Install these required tools before you install Treeport:

- Node.js 24 or a newer version
- npm
- Git
- tmux 3.2 or a newer version

Treeport does not install these tools.

The desktop client supports macOS 12 Monterey or a newer version. It supports Apple Silicon and Intel Macs.

## Install the macOS desktop client

1. Download the DMG from the [latest GitHub Release](https://github.com/noice-tech/treeport/releases/latest).
2. Open the DMG.
3. Drag **Treeport** to the Applications folder.

The universal application has an Apple Developer ID signature and Apple notarization.

The desktop client connects to a separate Treeport backend. It does not contain the backend.

Install the backend on this Mac with npm. Alternatively, connect to a private HTTPS backend on another computer.

The desktop client checks for stable updates automatically. After it downloads an update, it shows **Update & restart** in the title bar.

Select this control to restart the client and install the update.

A desktop update does not upgrade or restart the selected backend.

## Install the backend

Install Treeport globally:

```sh
npm install --global @treeport/treeport
```

Open a Git repository:

```sh
cd /path/to/repository
treeport .
```

Treeport starts the backend when necessary. It registers the repository and finds its trees.

It then opens the current tree in the macOS desktop client or the default browser.

To start only the backend, run:

```sh
treeport start
```

This command prints the local URL. The default URL is `http://127.0.0.1:8733`.

### Update the backend

Update Treeport with one command:

```sh
treeport update
```

Treeport downloads and verifies the latest stable npm release before it stops anything. If the daemon was running, Treeport preserves its tmux terminals, activates the update, and restarts the same lifecycle. An enabled service stays enabled. An intentionally stopped daemon or service stays stopped.

The global npm prefix must be writable by your user. Treeport never uses `sudo` for an update. If the prefix is not writable, install Node and npm under your user account, reinstall Treeport globally, and retry.

Installations older than the first release that supports this command need one final manual npm update.

## Connect the desktop client

At first start, the desktop client tries **This computer** at `http://127.0.0.1:8733`.

If Treeport is active, the desktop client opens your projects. If Treeport is not active, open a repository from a terminal:

```sh
treeport /path/to/repository
```

This command starts the backend and opens its tree.

To use another computer, select **Connect to another computer…**. Enter a private HTTPS Treeport URL.

The desktop client saves the last computer that you selected. See [Remote access](/features/remote-access/) for the supported Tailscale Serve configuration.

## Check the installation

Run these checks:

```sh
treeport status
treeport doctor
treeport version
```

The command `treeport stop` stops the daemon but keeps persistent tmux sessions. A later `treeport start` connects them again.

## Start Treeport automatically

A normal installation does not register an operating-system service.

On macOS, enable startup after login:

```sh
treeport service enable
```

This command installs a per-user LaunchAgent without `sudo` or an administrator request.

Service mode also restarts Treeport after an unexpected exit.

For startup before login on macOS, select advanced headless mode explicitly:

```sh
treeport service enable --headless
```

Advanced headless mode uses a system LaunchDaemon and requires administrator approval.

On Linux, Treeport installs a systemd user unit.

If user lingering is off, Treeport prints the necessary `loginctl enable-linger` administrator command. This setting permits startup without login.

Check service mode:

```sh
treeport service status
treeport doctor
```

See [Service supervision](/features/service-supervision/) for service behavior, logs, updates, recovery, and removal.

## Remove Treeport

Disable service mode before you remove the CLI:

```sh
treeport service disable
npm uninstall --global @treeport/treeport
rm -rf "$(npm prefix --global)/lib/treeport"
```

The final command removes only the Treeport-owned update versions. Run it after npm removes the global command.

If service mode was not enabled, `treeport service disable` is safe. It reports that the service is disabled.

An npm removal keeps application data by default.

npm cannot run a reliable package removal hook. Thus, always use the explicit service disable command.

:::caution
Treeport gives terminal access and does not have an application login. Keep it on loopback unless you configure supported private remote access.
:::

Do not expose Treeport directly to the public internet.
