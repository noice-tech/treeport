# Decision 0009: Operating-system service supervision is explicit and user-scoped

- Status: Accepted
- Date: 2026-08-22

## Context

The standard background daemon continues after its start shell exits.

It does not start automatically after a restart. It also does not restart after an unexpected exit.

The daemon controls application startup, database checks, and the single-process data-directory lock.

Treeport tmux servers must continue after daemon shutdown.

Tailscale Serve keeps its route separately and must stay as the remote authentication boundary.

A macOS LaunchAgent starts after its user logs in. The user can install and manage it without administrator access.

A system LaunchDaemon starts before login. Changes to its root-owned definition require administrator authority.

A systemd user unit keeps the Linux daemon under the user manager. User lingering makes that manager available before login.

## Decision

Treeport has an explicit `service` daemon lifecycle.

Service mode is separate from standard local and external lifecycles.

Installation and standard startup do not enable service mode.

### Normal macOS mode

Treeport uses a per-user LaunchAgent as the normal macOS service.

`treeport service enable` installs this mode without `sudo` or an administrator request.

The LaunchAgent starts after the owning user logs in. launchd restarts the daemon after an unexpected exit.

Normal enable, status, start, stop, disable, and package update operations run as the owning user.

The LaunchAgent does not contain `UserName` or `GroupName`. The user launchd domain supplies the account boundary.

Normal service and update operations never select headless mode automatically.

### Advanced macOS headless mode

Treeport keeps startup before login as a separate advanced mode.

The user must select it with `treeport service enable --headless`.

This mode uses a system LaunchDaemon. `UserName` and `GroupName` identify the Treeport data owner.

The backend does not run as the root user.

Treeport prepares a short-duration, one-use administrator request only for this mode.

The apply boundary validates the request, account, stable runner, and definition before it changes launchd.

An existing released LaunchDaemon record has no mode field. Treeport classifies this record as advanced headless mode.

Treeport continues to detect and manage these installations through their existing protected lifecycle.

Treeport does not rewrite a valid system definition only because the package implementation path changed.

The stable CLI entrypoint remains the definition contract. The current package runtime is resolved only when an administrator request is necessary.

Migration to user/login mode is deliberate. The user disables the headless service with administrator approval before enabling normal mode.

Treeport never removes a root-owned definition without administrator approval.

### Linux mode

Treeport uses `treeport.service` in the systemd user manager.

Startup before login requires user lingering.

When necessary, Treeport prints the exact `loginctl enable-linger` administrator command.

Treeport does not install a system unit.

It does not disable lingering during removal because other user units can require this setting.

### Shared service contract

All service definitions start a stable runner in the Treeport data directory.

The runner uses the stable npm global binary link.

It then replaces itself with the foreground Treeport process.

Service definitions do not point to an npm package implementation file.

A missing package path stops safely and supplies a diagnostic.

`treeport start` and `treeport stop` use the operating-system manager while service mode is installed.

Stop prevents an immediate restart but keeps the service definition enabled for its next automatic start.

`treeport service disable` removes automatic startup.

launchd uses `AbandonProcessGroup`. systemd uses `KillMode=process`.

These settings let a normal daemon stop keep Treeport tmux servers active.

The daemon ownership lock stays as the last protection against duplicate processes.

The service supervisor starts only the loopback daemon.

It does not create, remove, or change Tailscale Serve state.

## Consequences

Normal macOS service use does not need an administrator.

A user/login service starts only after the owning user logs in.

A headless macOS host can recover Treeport before login, but this mode has an explicit administrator boundary.

Treeport data and terminal sessions stay under the service user in both macOS modes.

Linux service removal keeps the account lingering setting. Administrators control that shared account policy separately.

A normal stop does not remove automatic startup. Disable service mode to remove that behavior.

Service configuration uses a reviewed environment, not the interactive shell environment.

After a related path or configuration change, run the applicable service enable command again.

npm does not have a reliable removal hook.

Thus, public instructions require explicit service removal. The stable runner stops safely after an incorrect removal order.
