# Decision 0004: Durable local repository identity

- Status: Accepted
- Date: 2026-08-04

## Context

Treeport must identify a registered repository after daemon restarts, filesystem mounts, and directory moves.

A saved `(st_dev, st_ino)` pair cannot supply this identity.

POSIX identifies a filesystem object only at the time of observation. Device numbers can change, and both values can have later reuse.

Remote URLs and Git history are also not suitable.

Clones, forks, empty repositories, and changed remotes can share or change these values.

Treeport identifies one local repository instance, not a remote repository or history line.

## Decision

Each registered repository has a random UUID in its common local Git configuration:

```ini
[treeport]
    repositoryId = 9c31d261-...
```

Treeport reads and writes `treeport.repositoryId` with `git config --local`.

Treeport disables Git configuration includes during a read. Thus, global and conditional configuration cannot supply a false repository marker.

Linked worktrees share the common configuration. A new clone does not copy it.

The marker is local, uncommitted, and separate from a Treeport database profile.

The SQLite `projects.repository_identity` column contains the same UUID. A unique constraint connects it to one project.

`repository_path` is only the last known location.

Device and inode columns are migration observations for old rows without a UUID.

After registration, they are not the repository identity.

Treeport does not remove the Git marker when it removes a registration.

Another local Treeport profile can still use that marker.

## Registration and recovery

New registration creates the marker, verifies the main worktree, and saves the UUID.

Registration can connect a moved, marked repository to its existing project.

This keeps project, worktree, terminal, tmux, and presentation identities.

Old rows register markers under the project observation lock.

Without a marker, registration is permitted only when all these conditions are true:

- The path is the exact saved canonical path.
- The inode is unchanged.
- Git supplies a complete verified inventory.
- An operation-level filesystem observation is unchanged.

A changed device number is permitted for this one-time migration.

Treeport does not use this fallback after it saves a UUID.

Normal reconciliation requires the saved marker at the last known path.

If the marker is absent or different, Treeport searches only the limited recovery area. Currently, this area is the path parent.

Treeport removes duplicate candidates. It accepts a move only when exactly one main worktree has the expected marker.

A move outside the recovery area requires explicit registration.

A different marker at the saved path identifies a different repository.

Treeport does not recreate a missing, invalid, or repeated marker during observation.

Multiple matching paths indicate a copied identity. Treeport keeps current information and requests explicit recovery.

It does not select one path.

## Observation safety

The UUID proves repository continuity between daemon runs.

It does not replace short-duration filesystem observations that authorize an operation.

Registration and reconciliation record a path `(st_dev, st_ino)`. They then inspect Git and the marker.

Before they save information, they require the same filesystem observation and marker.

Worktree removal saves and checks more information immediately before cleanup:

- approved path;
- filesystem observation;
- `.git` marker;
- Git administration key;
- repository UUID;
- quarantine path.

A restart or mount change can change an operation observation.

In this case, Treeport stops cleanup and keeps the uncertain filesystem path.

Decision 0007 controls worktree existence. Residual files do not keep or restore a worktree that Git no longer reports.

## Consequences

- A device-number change after a reboot or mount does not make an enrolled repository unavailable.
- A different repository at a registered path cannot get old project information.
- A normal move keeps Treeport identifiers when the marker is found or the user registers the new path.
- A copied marker requires a future explicit rotation operation.
- Automatic recovery does not select one copied marker.
- Read-only common Git information prevents registration and causes a writable-information error.
- A later migration can remove old device and inode columns after all supported databases have UUIDs.
