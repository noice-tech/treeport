# Decision 0003: SQLite schema and migration ownership

- Status: Accepted
- Date: 2026-07-28
- Related: Issues #125 and #128

## Context

Treeport needs a small durable catalog that is easy to reconstruct.

Git owns repositories, worktrees, branches, commits, and files. Treeport's detached terminal host owns active terminal processes and canonical terminal state.

Copying this state to SQLite would make recovery less reliable because it creates different sources of truth.

Treeport must save some application state:

- repository registration and presentation information;
- terminal presets;
- terminal attention acknowledgment;
- operation records for recovery after an interruption.

Attention state contains only the latest BEL sequence and read state for each terminal.

It is not a terminal process manifest or a notification history.

This durable state needs an explicit update path before public releases.

## Decision

SQLite is a small Treeport catalog in the configured data directory.

It is not a manifest for Git work or live terminal-host processes.

Loss of the database can remove Treeport information. It must not remove or damage a repository or worktree.

The daemon uses Drizzle for the complete catalog boundary:

- `apps/treeport/src/server/core/database-schema.ts` defines the TypeScript schema.
- `apps/treeport/drizzle` contains ordered SQL migrations and Drizzle information.
- `pnpm --filter @treeport/treeport db:generate` makes the next migration after a schema change.
- `@libsql/client` supplies the local SQLite driver through `drizzle-orm/libsql`.
- Drizzle controls all reads, writes, and transactions.
- Only the daemon opens and migrates the production database.
- Pending migrations run before service setup and before the server listens.
- During a CLI-owned binary update, the daemon privately reports whether migration history stayed unchanged or advanced. The updater does not open the database.

Published migration files come from `apps/treeport/drizzle`.

Runtime migration discovery uses package assets. It does not require a monorepo checkout.

## Migration procedure

1. Change the TypeScript schema.
2. Run `pnpm --filter @treeport/treeport db:generate`.
3. Review the generated SQL.
4. Add behavioral update tests.
5. Commit the schema, migration, Drizzle information, and tests together.
6. Test an update through the daemon migrator.

Do not use `drizzle-kit push` with a released or user database.

The `push` command does not use the reviewed migration history. It is not an update mechanism.

After a migration has shipped, do not change its SQL or journal entry.

Make a new forward migration to correct a released migration.

A changed or removed migration can make an incorrect schema appear compatible.

## Prerelease legacy transition

Earlier code had migrations 7 through 10 in `database.ts`.

Because Treeport did not have a public release, the public migration chain does not keep these numbers.

The first Drizzle migration is the public baseline for the current schema.

The daemon identifies a legacy database only with both these conditions:

- the `schema_migrations` ledger contains version 7;
- the core catalog tables are present.

The daemon rejects a version later than 10.

For version 7, the baseline can create the final preset table.

For version 8 or 9, Treeport adds the version 10 `close_on_success` column before it applies the baseline.

These operations keep existing rows. After the baseline succeeds, Treeport removes the legacy ledger.

This compatibility step has a narrow prerelease purpose. Remove it when old development databases no longer need it.

Treeport rejects untracked databases. It does not infer or silently change their format.

## Update safety

Before a write, the daemon reads the migration ledger.

It rejects migration history that is newer than the binary or unknown to it.

The error tells the user to update Treeport or use a compatible snapshot.

Rejection occurs before WAL mode or a schema write.

Before pending migrations, the daemon makes a consistent snapshot with SQLite `VACUUM INTO` through Drizzle and libSQL.

Do not use a raw file copy because committed data can be in the WAL.

Snapshots are in `database-backups` in the data directory.

The directory and files have owner-only permissions.

Treeport keeps the two latest snapshots for each database.

It does not make a snapshot for a new empty database or a start without pending migrations.

Drizzle applies each pending migration group in a transaction.

The legacy one-column adjustment is also transactional.

If migration fails, Treeport does not initialize services or listen.

The database and premigration snapshot stay available for a corrected binary.

After an update startup failure, the CLI starts the previous binary only when the daemon proved that migration history did not advance. An advanced or unknown result keeps the new binary active. The CLI reports snapshots but never restores one automatically.

## Consequences

- Catalog access and schema changes use one typed Drizzle boundary over libSQL.
- Treeport finds update failures before it reconciles worktrees or terminal sessions.
- Database loss cannot directly remove Git work.
- The daemon owns database snapshots and migrations.
- Electron, the updater, and other manifests do not own migrations.
- Restore interfaces and a general backup CLI remain outside this decision.
