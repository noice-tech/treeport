# Decision 0004: Durable local repository identity

- Status: Accepted
- Date: 2026-08-04

## Context

Treeport must recognize a registered local repository after daemon restarts, filesystem remounts, and ordinary directory moves. A persisted `(st_dev, st_ino)` pair cannot provide that identity: POSIX only identifies a filesystem object at one observation in time, device numbers can change after a reboot or remount, and both values can eventually be reused.

Remote URLs and Git history are also unsuitable. Clones, forks, empty repositories, and mutable remotes can legitimately share or change those values. Treeport identifies a local repository instance, not a remote or a line of history.

## Decision

Each enrolled repository has a random UUID in its common repository-local Git config:

```ini
[treeport]
    repositoryId = 9c31d261-...
```

Treeport reads and writes `treeport.repositoryId` with `git config --local`. Git config includes are disabled while reading so global and conditional configuration cannot impersonate a repository marker. Linked worktrees share the common config, while a normal fresh clone does not copy it. The marker is local and uncommitted, and it is independent of any one Treeport database profile.

The SQLite `projects.repository_identity` column stores the same UUID and uniquely associates it with a project. `repository_path` remains only the last-known location. The retained device and inode columns are migration observations for legacy rows whose durable identity is null; they are not repository identity after enrollment.

Treeport does not remove the Git marker when a registration is deleted because another local Treeport profile may still refer to it.

## Enrollment and recovery

New registration initializes the marker, verifies the Git main checkout, and records the UUID. Registration reconnects an existing marked project even after a move, preserving project, worktree, terminal, tmux, and presentation identities.

Legacy rows enroll lazily under the project observation lock. Without an existing marker, enrollment is permitted only at the exact stored canonical path, with the same inode, a complete verified Git inventory, and an unchanged operation-scoped stat. A changed device is permitted for this one-time migration. The fallback is never used after a durable UUID is stored.

Normal reconciliation requires the stored marker at the last-known path. If it is absent or different, Treeport scans only the bounded recovery area (currently the path's parent), deduplicates candidates, and adopts a move only when exactly one main checkout has the expected marker. A move outside that area requires explicit registration.

A different marker at the stored path is a different repository. A missing, invalid, or repeated marker is not recreated during observation. Multiple matching paths are treated as a copied identity and remain ambiguous. Treeport preserves existing metadata and asks for explicit recovery rather than guessing.

## Observation safety

The durable UUID proves repository continuity across daemon runs. It does not replace short-lived filesystem observations used to authorize an operation.

Registration and reconciliation capture a path's `(st_dev, st_ino)`, inspect Git and the marker, then require the same stat and marker before committing metadata. Destructive worktree removal additionally persists and revalidates the accepted path, stat, `.git` marker, Git administrative key, repository UUID, and quarantine path immediately before cleanup. A restart or remount that changes an operation-scoped stat intentionally fails closed and preserves the uncertain filesystem path. As established by Decision 0007, preserving residual files does not preserve or resurrect a worktree that Git no longer reports.

## Consequences

- Reboots and remounts do not make an enrolled repository unavailable merely because `st_dev` changed.
- Replacing a repository at a registered path cannot inherit the old project's metadata.
- Ordinary moves preserve Treeport-owned IDs and terminal bindings when the marker can be found or the new path is explicitly registered.
- Copied local config requires an explicit future marker-rotation action; automatic recovery never chooses between copies.
- Read-only common Git metadata prevents enrollment and produces a writable-metadata error.
- A later migration may drop the legacy device and inode columns after supported databases have enrolled or been explicitly re-linked.
