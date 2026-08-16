---
title: Install Treeport
description: Install the Treeport backend and macOS desktop client.
---

The Treeport backend supports macOS and Linux. It requires these tools:

- Node.js 24 or a newer version
- npm
- Git
- tmux 3.2 or a newer version

The desktop client supports macOS 12 Monterey or a newer version. It supports Apple Silicon and Intel Macs.

## Install the macOS desktop client

1. Download the DMG from the [latest GitHub Release](https://github.com/noice-tech/treeport/releases/latest).
2. Open the DMG.
3. Drag **Treeport** to the Applications folder.

The universal application has an Apple Developer ID signature and Apple notarization.

The desktop client connects to a separate Treeport backend. It does not contain the backend.

Install the backend on this Mac with curl or npm. Alternatively, connect to a private HTTPS backend on another computer.

The desktop client checks for stable updates automatically. After it downloads an update, it shows **Update & restart** in the title bar.

Select this control to restart the client and install the update.

A desktop update does not upgrade or restart the selected backend.

## Install the backend with curl

Use the recommended installer:

```sh
curl -fsSL https://treeport.app/install.sh | sh
```

The installer puts the Treeport npm package in a directory that Treeport manages.

The installer checks for Node.js 24 or a newer version and npm on `PATH`. It does not install Node.js or a package manager.

If tmux is not available, the installer can use a recognized package manager. The installer asks for approval before it installs tmux.

The installer supports these package managers:

- Homebrew and MacPorts on macOS
- APT, DNF, YUM, pacman, Zypper, and apk on Linux

You can install tmux 3.2 or a newer version before you run the installer again.

If Git is not available, install it with your package manager.

If the installer asks you, add `~/.local/bin` to `PATH`.

Open a Git repository:

```sh
cd /path/to/repository
treeport .
```

Treeport starts the backend in the background when necessary. It registers the repository and finds its trees.

It then opens the current tree in the macOS desktop client or the default browser.

To start only the backend, run:

```sh
treeport start
```

This command prints the local URL. The default URL is `http://127.0.0.1:8733`.

### Update a curl installation

Run the same curl command to install a newer version. The installer keeps the current daemon state.

On macOS, an update can require an administrator action for service mode.

Complete the action that the installer prints. Then, run the installer again before you remove old package files.

## Install the backend with npm

Install Treeport globally:

```sh
npm install --global @treeport/treeport
```

Open a Git repository:

```sh
cd /path/to/repository
treeport .
```

### Update an npm installation

Stop Treeport before npm replaces package files:

```sh
treeport stop
npm install --global @treeport/treeport@latest
treeport start
```

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

## Start Treeport after a reboot

A normal installation does not register an operating-system service.

To start Treeport after a reboot, enable service mode:

```sh
treeport service enable
```

Service mode also restarts Treeport after an unexpected exit.

On macOS, Treeport prepares a LaunchDaemon and prints one administrator command.

The LaunchDaemon starts before GUI login. It runs the backend as your user, not as the root user.

On Linux, Treeport installs a systemd user unit.

If user lingering is off, Treeport prints the necessary `loginctl enable-linger` administrator command. This setting permits startup without login.

Check service mode:

```sh
treeport service status
treeport doctor
```

See [Service supervision](/features/service-supervision/) for service behavior, logs, updates, recovery, and removal.

## Remove Treeport

To remove a curl installation and keep application data, run:

```sh
curl -fsSL https://treeport.app/uninstall.sh | sh
```

To also terminate all terminals and remove application data, run:

```sh
curl -fsSL https://treeport.app/uninstall.sh | TREEPORT_PURGE=1 sh
```

For an npm installation, disable service mode before you remove the CLI:

```sh
treeport service disable
npm uninstall --global @treeport/treeport
```

If service mode was not enabled, `treeport service disable` is safe. It reports that the service is disabled.

An npm removal keeps application data by default.

npm cannot run a reliable package removal hook. Thus, always use the explicit service disable command.

:::caution
Treeport gives terminal access and does not have an application login. Keep it on loopback unless you configure supported private remote access.
:::

Do not expose Treeport directly to the public internet.
