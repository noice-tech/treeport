---
title: Service supervision
description: Start Treeport after reboot and restart it after an unexpected exit.
---

Treeport normally starts a local background daemon when you open a folder or run `treeport start`. You can explicitly register the backend with the operating system when the host must recover without a user login:

```sh
treeport service enable
```

Service mode is optional. Installing or starting Treeport does not enable it.

The supervised backend still runs as your user and listens only on loopback. It keeps the same data, projects, worktrees, tmux terminals, listener, and Tailscale Serve route as normal background mode.

## macOS

Treeport uses a system LaunchDaemon so it can start before a GUI login. Run `treeport service enable` as the user who owns the Treeport data. Do not run it as root.

Treeport prepares the definition and prints one command for an administrator, similar to:

```sh
sudo /absolute/path/to/treeport service apply --request /absolute/path/to/request.json
```

An administrator can run this command from another account. The command installs the system definition, but the definition tells launchd to run Treeport as the original user. Treeport does not run the backend as root.

macOS also requires a printed administrator command when `treeport start`, `treeport stop`, or `treeport service disable` changes the system LaunchDaemon. Requests expire. If one expires, run the original Treeport command again.

## Linux

Treeport uses a systemd user service. It enables and starts `treeport.service` through your user manager.

A user service needs lingering to start after reboot without a login. If lingering is off, `treeport service enable` starts the service for the current session and prints this administrator action:

```sh
sudo loginctl enable-linger <user>
```

Run `treeport service status` after the administrator completes it. Treeport does not install a system unit. `treeport service disable` does not turn lingering off because other user services can depend on that setting.

A Linux system without a usable systemd user manager is not supported for service mode.

## Start and stop

While service mode is installed, normal lifecycle commands use the OS manager:

```sh
treeport start
treeport stop
```

`treeport stop` prevents an immediate automatic restart but keeps startup after reboot registered. `treeport start` starts it again. If the host reboots while Treeport is stopped, the OS starts it during that boot.

Normal stop and service disable preserve Treeport-owned tmux sessions. Use the explicit destructive option only when you want to terminate every session:

```sh
treeport stop --terminate-terminals --force
```

## Status, health, and logs

```sh
treeport service status
treeport status
treeport doctor
treeport logs
```

Service status distinguishes these conditions:

- disabled;
- waiting for an administrator action;
- healthy;
- intentionally stopped;
- starting;
- unhealthy;
- stale configuration or installation path.

`treeport service status` exits with status 1 when an administrator action or repair is required. Add `--json` for structured output. An intentionally stopped service is valid and exits successfully.

On macOS, `treeport logs` reads Treeport's daemon log. On Linux, it reads the systemd user journal for `treeport.service`.

Run `treeport service enable` again when status reports a stale definition, changed environment, or moved npm installation.

## Unexpected exits and terminal persistence

launchd and systemd restart Treeport after an unexpected daemon exit. The existing Treeport ownership lock still permits only one daemon for a data directory.

The OS manager stops only the daemon process. Treeport's tmux servers remain independent, so terminals survive a daemon restart and reconnect when the replacement is healthy.

## Remote access after reboot

Service supervision restores only the loopback Treeport daemon. It does not create or change remote access.

If you already ran `treeport remote enable`, Tailscale Serve keeps that route independently. After reboot, the same private URL becomes available when the supervised loopback daemon is healthy. See [Remote access](/features/remote-access/).

## Upgrade and uninstall

For npm upgrades:

```sh
treeport stop
npm install --global @treeport/treeport@latest
treeport start
```

If your npm prefix or Node installation changes, run `treeport service enable` again to refresh the stable CLI path and service environment.

Disable service mode before npm removes Treeport:

```sh
treeport service disable
npm uninstall --global @treeport/treeport
```

npm does not provide a reliable uninstall hook. If you remove the package first, the persistent service runner fails closed and writes a recovery message instead of starting a partial daemon. Reinstall Treeport, then run `treeport service enable` to repair it or `treeport service disable` to remove supervision.

The curl uninstaller checks service mode. On macOS it stops before package removal and tells you to complete the administrator action, then rerun the uninstaller.
