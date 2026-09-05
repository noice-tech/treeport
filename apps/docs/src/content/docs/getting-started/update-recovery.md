---
title: Recover after an update
description: Recover desktop and backend updates without an unsafe database downgrade.
---

## Identify the installation

The macOS desktop application and the npm backend update separately.

A desktop update replaces only the client. It does not stop, upgrade, or restart any backend.

For a remote backend, run recovery commands on its host. Do not run local restart commands to repair another computer.

## Recover the desktop application

If an update fails, select **Desktop update failed** in the title bar. Treeport shows the error and installation instructions.

Automatic update checks continue. You can wait for another check or install the application manually.

To recover an interrupted installation:

1. Quit the desktop application.
2. Download a supported DMG from [GitHub Releases](https://github.com/noice-tech/treeport/releases).
3. Replace Treeport in the Applications folder.
4. Open Treeport.

Keep the existing application settings. The desktop application reconnects to the saved computer.

If a release was withdrawn, use the corrected release. A previous desktop release is usable only with a backend that it supports.

A desktop downgrade does not change the backend database.

## Update an older backend

For normal backend updates, run:

```sh
treeport update
```

An intentionally stopped daemon stays stopped. A running daemon restarts through its existing lifecycle.

### Upgrade from the old tmux terminal runtime

Older releases, including `0.5.0`, use tmux. The current backend cannot adopt those live terminal processes.

Save your work before this one-time upgrade. The following stop command terminates every Treeport terminal, including commands running inside them.

Run these commands from a terminal outside Treeport:

```sh
treeport stop --terminate-terminals --force
treeport update
treeport start
```

For advanced headless service mode, complete the administrator stop action before the update. See [Service supervision](/features/service-supervision/).

Projects and trees remain in the catalog. Start new terminals after the upgrade.

### Upgrade a release without self-update support

Stop the backend before you replace the npm package:

```sh
treeport stop
npm install --global @treeport/treeport@latest
treeport start
```

If the old backend uses tmux, first use the terminal-termination procedure above. Substitute the npm installation command for `treeport update`.

Do not start a service that you intend to leave stopped.

If the npm prefix or Node installation changes, repair the service configuration as described in [Service supervision](/features/service-supervision/).

## Recover the backend

If downloading or verification fails, the existing installation and daemon remain unchanged. Correct the network or npm permission problem, then retry.

If installation was interrupted, run `treeport update` again. Treeport checks the saved operation before it continues.

Treeport can restore the previous binary only when it proves that migration did not advance and the replacement daemon is stopped.

Missing startup evidence does not prove that rollback is safe. An uncertain or advanced migration requires a compatible release.

If the daemon cannot start:

1. Keep the installed version and database.
2. Read the update error and its recovery instruction.
3. Inspect the daemon log.
4. Install a corrected release that supports the database.
5. Run `treeport start` when the installation is ready.

Use these commands for diagnostics:

```sh
treeport status
treeport doctor
treeport logs --lines 100
```

The update error includes available log and snapshot paths. `treeport update --json` supplies structured details for automation.

The daemon log is `logs/daemon.log` in the data directory. Linux service logs are also available through `treeport logs`.

See [Configuration](/reference/configuration/#find-the-default-data-directory) for data directory locations.

If the selected release is faulty or withdrawn, install the corrected version with npm after stopping the daemon or service.

Do not replace it with an older backend merely because that backend started before the update.

A binary refuses migration history that is newer than it supports or that it does not recognize. It does not serve the application.

## Restore a pre-migration snapshot

Before pending migrations modify an existing catalog, the daemon creates a consistent SQLite snapshot.

Snapshots are in `database-backups` in the data directory. Treeport retains the two latest snapshots for each database.

A normal startup without pending migrations does not create a snapshot. A new empty database does not need one.

:::caution
Restoration discards catalog changes made after the snapshot. Terminal processes and Git files are not part of the snapshot.

Treeport never restores a snapshot automatically. Prefer a corrected binary when possible.
:::

Restore a snapshot only when you deliberately choose that data loss:

1. Stop the daemon with `treeport stop`.
2. If service mode is enabled, confirm that the service is stopped with `treeport service status`.
3. If shutdown cannot be verified, stop here and ask the process owner or administrator for help.
4. Locate the configured database and a compatible pre-migration snapshot.
5. Move the database into a separate recovery directory.
6. Move its `-wal` and `-shm` files into that directory, if present.
7. Copy the selected snapshot to the configured database path.
8. Give only the owning user read and write permission to the restored database.
9. Install a backend version that supports the snapshot.
10. Run `treeport start`.
11. Check your projects and trees.

Never copy or replace the live database while a daemon can write to it. Keep the original database and its sidecar files together.

Do not delete the recovery directory until you have checked the restored catalog.
