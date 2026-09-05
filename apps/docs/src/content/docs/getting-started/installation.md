---
title: Install Treeport
description: Install the Treeport backend and macOS desktop client.
---

The Treeport backend supports macOS and Linux.

Install these required tools before you install Treeport:

- Node.js 24 or a newer version
- npm
- Git

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

If installation fails, see [Recover after an update](/getting-started/update-recovery/).

The desktop client checks the selected backend version before it loads Treeport.

If the backend needs an update, run `treeport update` on that computer. Then, select **Retry**.

If the desktop client needs an update, install the update and restart the client.

## Install the backend

Install Treeport globally:

```sh
npm install --global @treeport/treeport
```

Open a folder or Git repository:

```sh
cd /path/to/project
treeport .
```

Treeport starts the backend when necessary.

For a repository, Treeport registers the repository and finds its trees.

For an ordinary folder, Treeport creates one folder tree.

In a managed terminal, it opens the selected tree in the current Treeport client.

From another terminal, it opens the macOS desktop client or the default browser.

To start only the backend, run:

```sh
treeport start
```

This command prints the local URL. The default URL is `http://127.0.0.1:8733`.

### Update the backend

Treeport checks for stable backend updates approximately every ten minutes.

When an update is available, a Download control appears before the notification bell. Select the control. Then, select **Update Treeport**.

Treeport verifies the release before it stops the daemon. The detached terminal host preserves running terminals while Treeport restarts the same daemon lifecycle.

The page reconnects after the restart. It then opens the same workspace with the new web assets.

The macOS desktop client shows this backend control when it uses a local backend. It does not show the control for a remote backend.

You can also update the backend with this command:

```sh
treeport update
```

Use this command for automation or recovery. An enabled service stays enabled. An intentionally stopped daemon or service stays stopped.

Your user must have write access to the global npm prefix. Treeport never uses `sudo` for an update.

If the prefix is not writable, install Node and npm under your user account. Then, install Treeport globally again.

Installations without self-update support need one manual npm update.

Old tmux-backed releases also need a one-time terminal shutdown before the upgrade.

See [Recover after an update](/getting-started/update-recovery/) for the commands, failure recovery, and snapshot restoration.

## Connect the desktop client

At first start, the desktop client tries **This computer** at `http://127.0.0.1:8733`.

If Treeport is active, the desktop client opens your projects.

If Treeport is not active, open a folder or repository from a terminal:

```sh
treeport /path/to/project
```

This command starts the backend and opens the selected tree.

To use another computer, select **Connect to another computer…**. Enter a private HTTPS Treeport URL.

The desktop client saves the last computer that you selected. See [Remote access](/features/remote-access/) for the supported Tailscale Serve configuration.

## Check the installation

Run these checks:

```sh
treeport status
treeport doctor
treeport version
```

The command `treeport stop` stops the API daemon but keeps hosted terminal sessions. A later `treeport start` adopts the same terminal host and connects them again.

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
