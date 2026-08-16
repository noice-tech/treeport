# Decision 0009: Operating-system service supervision is explicit and user-scoped

- Status: Accepted
- Date: 2026-08-22

## Context

The standard background daemon continues after its start shell exits.

It does not start after a host reboot or restart automatically after an unexpected exit.

Thus, a headless macOS or Linux host can lose its remote Treeport backend until a user starts it.

The daemon controls application startup, database checks, and the single-process data-directory lock.

Treeport tmux servers must continue after daemon shutdown.

Tailscale Serve keeps its route separately and must stay as the remote authentication boundary.

On macOS, a LaunchAgent usually requires a login session.

A system LaunchDaemon starts before login. However, installation or change of its root-owned definition needs administrator authority.

On Linux, a systemd user unit keeps the daemon under the user manager.

User lingering makes that manager available before login.

## Decision

Treeport has an explicit `service` daemon lifecycle.

Service mode is separate from standard local and external lifecycles.

Installation and standard startup do not enable service mode.

On macOS, Treeport uses a system LaunchDaemon.

`UserName` and `GroupName` identify the user who enabled service mode. The backend does not run as the root user.

Treeport prepares a short-duration, one-use request. It prints one exact root apply command.

The apply boundary validates the request, account, stable runner, and definition before it changes launchd.

On Linux, Treeport uses `treeport.service` in the systemd user manager.

Startup before login requires user lingering.

When necessary, Treeport prints the exact `loginctl enable-linger` administrator command.

Treeport does not install a system unit.

It does not disable lingering during removal because other user units can require this setting.

Both service definitions start a stable runner in the Treeport data directory.

The runner uses the stable curl shim or npm global binary link.

It then replaces itself with the foreground Treeport process.

Service definitions do not point to a versioned curl directory or an npm package implementation file.

A missing package path stops safely and supplies a diagnostic.

`treeport start` and `treeport stop` use the operating-system manager while service mode is installed.

Stop prevents an immediate restart but keeps startup after reboot.

`treeport service disable` is the separate operation that removes reboot startup.

launchd uses `AbandonProcessGroup`. systemd uses `KillMode=process`.

These settings let a normal daemon stop keep Treeport tmux servers active.

The daemon ownership lock stays as the last protection against duplicate processes.

The service supervisor starts only the loopback daemon.

It does not create, remove, or change Tailscale Serve state.

## Consequences

A headless host can recover Treeport after reboot or an unexpected exit without a GUI login.

Treeport data and terminal sessions stay under the service user.

macOS lifecycle changes can require a separate administrator action.

A nonadministrator service account can send one command to an administrator without broad `sudo` access.

Linux service removal keeps the account lingering setting. Administrators control that shared account policy separately.

A normal stop does not mean that Treeport stays stopped after the next reboot.

To get this result, disable service mode.

Service configuration uses a reviewed environment, not the interactive shell environment.

After a related path or configuration change, run `treeport service enable` again.

The curl removal program must not remove package files before service mode is disabled.

npm does not have a reliable removal hook.

Thus, public instructions require explicit service removal, and the stable runner stops safely after an incorrect removal order.
