# Decision 0009: OS service supervision is explicit and user-scoped

- Status: Accepted
- Date: 2026-08-22

## Context

Treeport's normal detached daemon survives the invoking shell, but it does not start after a host reboot and it does not have an OS supervisor after an unexpected exit. A headless Mac mini or Linux host can therefore lose its remote Treeport backend until someone logs in and starts it.

The daemon owns application startup, database checks, and a lock that prevents two processes from using one Treeport data directory. Treeport's tmux servers must survive daemon shutdown. Tailscale Serve also keeps its route independently of the daemon and must remain the remote authentication boundary.

macOS LaunchAgents normally depend on a login session. A system LaunchDaemon starts before login, but installing or changing its root-owned definition needs administrator authority. On Linux, a systemd user unit keeps the daemon under the user's manager, while lingering makes that manager available without login.

## Decision

Treeport has an explicit `service` daemon lifecycle in addition to its normal local and external lifecycles. Service mode is never enabled by installation or ordinary startup.

On macOS, Treeport uses a system LaunchDaemon with `UserName` and `GroupName` set to the user who enabled service mode. The backend never runs as root. Treeport prepares a short-lived, one-use request and prints one exact root apply command. The apply boundary validates the request, account, stable runner, and definition before it changes the system launchd domain.

On Linux, Treeport uses `treeport.service` in the systemd user manager. It requires user lingering for reboot startup without login. Treeport prints the exact `loginctl enable-linger` administrator action when needed. It does not install a system unit and it does not disable lingering during removal because other user units can depend on it.

Both manager definitions invoke a stable runner in the Treeport data directory. The runner uses the stable curl shim or npm global bin link and then replaces itself with the foreground Treeport process. Manager definitions do not point to a versioned curl directory or npm package implementation file. A missing package path fails closed with a diagnostic.

`treeport start` and `treeport stop` delegate to the OS manager while service mode is installed. Stop keeps reboot registration. Thus, it prevents an immediate restart, while a later boot starts Treeport again. `treeport service disable` is the separate operation that unregisters reboot startup.

launchd uses `AbandonProcessGroup`; systemd uses `KillMode=process`. These settings let normal daemon stop preserve Treeport-owned tmux servers. The existing daemon ownership lock remains the final duplicate-process guard.

The supervisor starts only the loopback daemon. It does not create, remove, or rewrite Tailscale Serve state.

## Consequences

A headless host can recover Treeport after reboot and after an unexpected daemon exit without a GUI login. Treeport data and tmux terminals stay owned by the service user.

macOS lifecycle changes can need a separate administrator action. A dedicated non-admin service account can send that one command to an administrator instead of receiving broad sudo access.

Linux service removal leaves the account's lingering setting unchanged. Administrators can manage that shared account policy separately.

A normal stop does not mean "stay stopped across the next reboot." Users who need that result must disable service supervision.

Service configuration captures a reviewed environment instead of an interactive shell environment. A moved npm prefix or relevant PATH and configuration change requires `treeport service enable` again.

The curl uninstaller must refuse to remove package files until service supervision is disabled. npm has no reliable uninstall lifecycle hook, so documentation requires explicit disablement and the stable runner provides fail-closed behavior when a user omits it.
