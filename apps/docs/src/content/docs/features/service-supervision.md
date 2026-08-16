---
title: Service supervision
description: Start Treeport after a reboot and restart it after an unexpected exit.
---

Treeport usually starts a background daemon when you open a folder or run `treeport start`.

Enable service mode when the host must recover without a user login:

```sh
treeport service enable
```

Service mode is optional. A normal installation or start does not enable it.

The supervised backend runs as your user and listens only on loopback.

It uses the same data, projects, Trees, terminals, listener, and Tailscale Serve route as the standard background daemon.

## macOS

Treeport uses a system LaunchDaemon to start before GUI login.

Run `treeport service enable` as the user who owns the Treeport data. Do not run this command as the root user.

Treeport prepares the service definition and prints one administrator command. For a curl installation, the command has this form:

```sh
sudo '/absolute/path/to/treeport' service apply --request '/absolute/path/to/request.json'
```

An npm installation can include the absolute Node.js runtime and package CLI entry point.

An administrator can run the printed command from another account. The command does not depend on the administrator account's `PATH`.

The command uses the Node.js runtime and Treeport installation that the Treeport owner selected.

The administrator installs the system definition. The definition instructs launchd to run Treeport as the original user.

The backend does not run as the root user.

Treeport can also print an administrator command after `treeport start`, `treeport stop`, or `treeport service disable`.

This occurs when the command must change the system LaunchDaemon. Administrator requests expire.

If a request expires, run the original Treeport command again.

## Linux

Treeport uses a systemd user service. It enables and starts `treeport.service` through your user manager.

User lingering is necessary for startup after a reboot without login.

If lingering is off, `treeport service enable` starts Treeport for the current session. It also prints this administrator command:

```sh
sudo loginctl enable-linger <user>
```

After the administrator runs the command, check the service:

```sh
treeport service status
```

Treeport does not install a system unit.

The command `treeport service disable` does not turn lingering off. Other user services can require this setting.

Service mode does not support a Linux system without a usable systemd user manager.

## Start and stop the service

When service mode is installed, use the standard lifecycle commands:

```sh
treeport start
treeport stop
```

These commands use the operating-system service manager.

The stop command prevents an immediate automatic restart. It keeps startup after a reboot enabled.

The start command starts the service again. If the host reboots while Treeport is stopped, the operating system starts it.

A normal stop or service removal keeps Treeport tmux sessions.

To terminate all sessions, use the explicit destructive command:

```sh
treeport stop --terminate-terminals --force
```

## Check status, health, and logs

Use these commands:

```sh
treeport service status
treeport status
treeport doctor
treeport logs
```

The service status has these possible conditions:

- disabled;
- waiting for an administrator action;
- healthy;
- intentionally stopped;
- starting;
- unhealthy;
- stale configuration or installation path.

`treeport service status` exits with code `1` when an administrator action or repair is necessary.

Use `--json` for structured output. An intentionally stopped service is valid and exits successfully.

On macOS, `treeport logs` reads the Treeport daemon log.

On Linux, it reads the systemd user journal for `treeport.service`.

Run `treeport service enable` again when the status reports a stale definition, environment, or installation path.

## Recover after an unexpected exit

launchd and systemd restart Treeport after an unexpected daemon exit.

The Treeport ownership lock continues to permit only one daemon for each data directory.

The service manager stops only the daemon process. Treeport tmux servers continue to run.

Terminals connect again when the replacement daemon is healthy.

## Restore remote access after a reboot

Service mode restores only the loopback daemon. It does not create or change remote access.

If you enabled remote access, Tailscale Serve keeps its route separately.

After a reboot, the same private URL works when the supervised daemon is healthy. See [Remote access](/features/remote-access/).

## Update or remove Treeport

For an npm update, run:

```sh
treeport stop
npm install --global @treeport/treeport@latest
treeport start
```

If the npm prefix or Node.js installation changes, run `treeport service enable` again.

This command updates the stable CLI path and service environment.

Disable service mode before you remove the npm package:

```sh
treeport service disable
npm uninstall --global @treeport/treeport
```

npm does not have a reliable removal hook.

If you remove the package first, the service runner stops safely and writes a recovery message. It does not start an incomplete daemon.

Reinstall Treeport. Then, enable service mode to repair it or disable service mode to remove it.

The curl removal program checks service mode.

On macOS, it can stop and ask for an administrator action. Complete that action, and then run the removal program again.
