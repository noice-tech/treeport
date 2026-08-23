---
title: Service supervision
description: Start Treeport after login and restart it after an unexpected exit.
---

Treeport usually starts a background daemon when you open a folder or run `treeport start`.

Enable service mode when Treeport must restart after an unexpected exit:

```sh
treeport service enable
```

Service mode is optional. A normal installation or start does not enable it.

The supervised backend runs as your user and listens only on loopback.

It uses the same data, projects, trees, terminals, listener, and Tailscale Serve route as the standard background daemon.

## macOS user/login mode

The normal macOS service is a per-user LaunchAgent.

It starts after you log in to macOS. launchd restarts it after an unexpected exit.

Enable it as the user who owns the Treeport data:

```sh
treeport service enable
```

This command does not use `sudo`. It does not create an administrator request.

Normal start, stop, disable, and update operations do not need an administrator.

## Advanced macOS headless mode

Use advanced headless mode only when Treeport must start before a user logs in.

Enable this mode explicitly:

```sh
treeport service enable --headless
```

This option prepares a system LaunchDaemon. It tells you that an administrator must approve the system change.

Treeport prints one administrator command. The command uses absolute paths to Node.js and the Treeport CLI:

```sh
sudo '/absolute/path/to/node' '/absolute/path/to/treeport.mjs' service apply --request '/absolute/path/to/request.json'
```

Run `treeport service enable --headless` as the Treeport data owner. Do not run it as the root user.

An administrator can run the printed command from a different account.

The LaunchDaemon starts Treeport as the data owner. The backend does not run as the root user.

Treeport can also print an administrator command after start, stop, or disable operations in advanced headless mode.

Administrator requests expire. If a request expires, run the original Treeport command again.

Normal service commands do not select advanced headless mode automatically.

## Existing macOS LaunchDaemons

Treeport identifies an existing system LaunchDaemon as advanced headless mode.

Status, start, stop, and disable operations continue to use the protected administrator approval process.

A package update does not rewrite the system definition when its stable Treeport entrypoint is still valid.

To migrate to user/login mode:

1. Run `treeport service disable`.
2. Complete the administrator action that Treeport prints.
3. Run `treeport service enable`.

Treeport never removes a root-owned LaunchDaemon without administrator approval.

## Linux

Treeport uses a systemd user service. It enables and starts `treeport.service` through your user manager.

User lingering is necessary for startup after a reboot without login.

If lingering is off, `treeport service enable` starts Treeport for the current session.

It also prints this administrator command:

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

The stop command prevents an immediate automatic restart. It keeps automatic startup enabled.

The start command starts the service again.

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

The service status shows one of these modes:

- user/login mode on macOS;
- advanced headless mode on macOS;
- user service mode on Linux.

The service status has these possible conditions:

- disabled;
- waiting for an administrator action;
- healthy;
- intentionally stopped;
- starting;
- unhealthy;
- stale configuration or installation path.

`treeport service status` exits with code `1` when an administrator action or repair is necessary.

Use `--json` for structured output. The `mode` field is `user`, `headless`, or `null` when disabled.

An intentionally stopped service is valid and exits successfully.

On macOS, `treeport logs` reads the Treeport daemon log.

On Linux, it reads the systemd user journal for `treeport.service`.

When the status reports stale configuration, run the applicable enable command again.

Use `--headless` only to repair an advanced headless installation.

## Recover after an unexpected exit

launchd and systemd restart Treeport after an unexpected daemon exit.

The Treeport ownership lock continues to permit only one daemon for each data directory.

The service manager stops only the daemon process. Treeport tmux servers continue to run.

Terminals connect again when the replacement daemon is healthy.

## Restore remote access

Service mode restores only the loopback daemon. It does not create or change remote access.

If you enabled remote access, Tailscale Serve keeps its route separately.

The same private URL works when the supervised daemon is healthy. See [Remote access](/features/remote-access/).

## Update or remove Treeport

To update Treeport, run:

```sh
treeport update
```

A running service stops and starts through its existing operating-system manager. The service stays enabled, keeps its selected mode and definition, and reconnects to the preserved tmux terminals. An intentionally stopped service stays stopped.

Normal macOS user service updates do not need administrator access. Stop an advanced headless service with the administrator action before you update it.

If updated startup fails before a database migration, Treeport restores the previous version. If migration history advanced or is unknown, Treeport keeps the new version, stops the service without disabling it, and reports the daemon log and snapshot paths. It never starts an older daemon against a possibly newer database.

The npm prefix must be writable by the service owner. If the npm prefix or Node.js installation changes outside Treeport, reinstall Treeport and run the applicable service enable command again.

Disable service mode before you remove the npm package:

```sh
treeport service disable
npm uninstall --global @treeport/treeport
rm -rf "$(npm prefix --global)/lib/treeport"
```

The final command removes only the Treeport-owned update versions.

npm does not have a reliable removal hook.

If you remove the package first, the service runner stops safely and writes a recovery message.

Reinstall Treeport. Then, enable service mode to repair it or disable service mode to remove it.

Advanced headless mode can require an administrator action during removal.
