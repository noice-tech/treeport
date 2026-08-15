---
title: Install Treeport
description: Install and run Treeport with curl or npm.
---

The Treeport backend supports macOS and Linux. It requires Node.js 24 or newer, npm, Git, and tmux 3.2 or newer. The desktop client supports macOS 12 Monterey or newer on both Apple Silicon and Intel Macs.

## Install the macOS desktop app

Download the DMG from the [latest GitHub Release](https://github.com/noice-tech/treeport/releases/latest), open it, and drag **Treeport** into Applications. The universal app is signed with a Developer ID certificate and notarized by Apple.

The desktop client connects to a Treeport backend; it does not contain one. Install and start the backend on this Mac using curl or npm below, or connect the app to a private HTTPS backend on another computer.

The desktop client checks for stable updates automatically. After an update downloads, Treeport asks before restarting the desktop client to install it. Desktop updates never upgrade or restart the selected local or remote backend.

## Install the backend with curl

The recommended installer checks your existing Node.js installation and installs the Treeport npm package into a Treeport-managed directory:

```sh
curl -fsSL https://treeport.app/install.sh | sh
```

The installer requires Node.js 24 or newer and npm on `PATH`; it never installs Node.js or a package manager. If tmux is unavailable, it can use a recognized package manager already on the system after asking for confirmation. Supported package managers include Homebrew and MacPorts on macOS and APT, DNF, YUM, pacman, Zypper, and apk on Linux. You can instead install tmux 3.2 or newer yourself before rerunning the installer. Install Git with your preferred package manager if it is unavailable.

Add `~/.local/bin` to `PATH` if requested, then open a Git repository:

```sh
cd /path/to/repository
treeport .
```

Treeport starts its backend in the background if necessary, registers the repository and its worktrees, and opens the current worktree in the macOS desktop app or default browser. Use `treeport start` when you want to start only the backend; it prints its local URL, `http://127.0.0.1:8733`.

Rerun the same curl command to install a newer version. The installer preserves whether the local daemon was running. If macOS service mode needs an administrator action during an upgrade, complete the printed action and rerun the installer before you remove old package files.

## Install the backend with npm

To install directly through npm:

```sh
npm install --global @treeport/treeport
cd /path/to/repository
treeport .
```

For upgrades, stop Treeport while npm replaces package files:

```sh
treeport stop
npm install --global @treeport/treeport@latest
treeport start
```

## Connect the desktop app

On first launch, the desktop app tries **This computer** at `http://127.0.0.1:8733`. If Treeport is already running, your projects open without a setup flow. Otherwise, open a repository from a terminal to start the backend and focus its worktree:

```sh
treeport /path/to/repository
```

You can instead choose **Connect to another computer…** and enter a private HTTPS Treeport URL. The last computer you deliberately select is restored on later launches. See [Remote access](/features/remote-access/) for the recommended Tailscale Serve setup.

## Check the installation

```sh
treeport status
treeport doctor
treeport version
```

`treeport stop` stops the daemon but preserves persistent tmux sessions. A later `treeport start` reconnects them.

## Start Treeport after reboot

Normal installation does not register an OS service. To opt in to startup after reboot and restart after an unexpected exit, run:

```sh
treeport service enable
```

On macOS, Treeport prepares a LaunchDaemon and prints one administrator command. The LaunchDaemon starts before GUI login but runs the backend as your user, not as root. On Linux, Treeport installs a systemd user unit. If user lingering is off, it prints the `loginctl enable-linger` administrator command that is required for startup without login.

Check the result with:

```sh
treeport service status
treeport doctor
```

See [Service supervision](/features/service-supervision/) for start, stop, log, recovery, upgrade, and removal behavior.

## Uninstall

A curl-managed installation can be removed while preserving application data:

```sh
curl -fsSL https://treeport.app/uninstall.sh | sh
```

To terminate every terminal and remove application data as well:

```sh
curl -fsSL https://treeport.app/uninstall.sh | TREEPORT_PURGE=1 sh
```

For npm installations, disable service supervision before npm removes the CLI:

```sh
treeport service disable
npm uninstall --global @treeport/treeport
```

If service mode was never enabled, `treeport service disable` is safe and reports that it is disabled. npm uninstall preserves application data by default. npm cannot run a reliable package uninstall hook, so do not omit the explicit disable step.

:::caution
Treeport provides terminal access and does not include authentication. Keep it on loopback unless you deliberately configure a trusted private-network address. Never expose it directly to the public internet.
:::
