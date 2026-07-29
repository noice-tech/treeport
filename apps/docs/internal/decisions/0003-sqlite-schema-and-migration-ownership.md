# Decision 0003: SQLite schema and migration ownership

- Status: Accepted
- Date: 2026-07-28
- Related: Issues #125 and #128

## Context

Treeport needs a durable local catalog, but it should remain barely stateful and easy to reconstruct. Git already owns repositories, worktrees, branches, commits, and files. The application-owned tmux server owns live terminal processes. Duplicating either system in SQLite would create conflicting sources of truth and make recovery less reliable.

Treeport does need a small amount of durable application state: repository registration and presentation metadata, terminal presets, and operation records used to recover interrupted Treeport operations. That state needs an explicit upgrade path before public releases.

## Decision

SQLite remains a small local Treeport catalog under the configured data directory. It is not a manifest for Git work or tmux processes. Losing the database may lose Treeport-owned metadata, but must never delete or damage a repository or worktree.

The server uses Drizzle for the complete catalog boundary:

- `apps/treeport/src/server/core/database-schema.ts` describes the schema in TypeScript;
- `apps/treeport/drizzle` contains explicit, ordered SQL migrations and Drizzle metadata;
- `pnpm --filter @treeport/treeport db:generate` generates the next migration after a schema change;
- `@libsql/client` provides the local-file SQLite driver through `drizzle-orm/libsql`;
- reads, writes, and transactions use Drizzle rather than a second database API;
- only the daemon opens and migrates the production database;
- pending migrations run before service initialization and before the server listens.

Migration files are published directly from `apps/treeport/drizzle`. Runtime migration discovery uses those package-owned assets and does not depend on a monorepo checkout.

## Migration workflow

1. Change the TypeScript schema.
2. Run `pnpm --filter @treeport/treeport db:generate`.
3. Review the generated SQL and add behavioral upgrade coverage.
4. Commit the schema, SQL migration, Drizzle metadata, and tests together.
5. Exercise an upgrade through the daemon/runtime migrator.

Never use `drizzle-kit push` against shipped or user databases. `push` bypasses the reviewed migration history and is not an upgrade mechanism.

Once a migration has shipped, its SQL and journal entry are immutable. Fixes are new, forward-only migrations. Rewriting or deleting a released migration can make a database appear compatible while its schema differs from the binary's expectations.

## Pre-public legacy transition

Before this decision, the server carried inline migrations numbered 7 through 10 in `database.ts`. This repository is still pre-public-release, so those implementation-history numbers are not retained as the public migration chain.

The first Drizzle migration is the public baseline containing the current schema. On startup, the daemon recognizes a legacy database only when its `schema_migrations` ledger includes version 7 and its core catalog tables are present. Versions newer than 10 are refused. Version 7 databases can create the final preset table from the baseline; version 8 or 9 preset tables receive the version 10 `close_on_success` column before the idempotent baseline is applied. Existing rows are preserved. After the Drizzle baseline succeeds, the legacy ledger is removed.

The compatibility step is intentionally narrow and can be removed after pre-release development databases no longer need it. Untracked databases are refused rather than guessed at or silently rewritten.

## Upgrade safety

Before opening the database for writes, the daemon reads its migration ledger and refuses migration history newer than or unknown to the binary. The error tells the user to upgrade Treeport or use a compatible snapshot. Refusal happens before WAL mode or any schema write is requested.

When an existing catalog has pending migrations, the daemon creates a consistent snapshot with SQLite's `VACUUM INTO` operation through Drizzle and libSQL. A raw file copy is not safe because committed data may still be in the WAL. Snapshots live in `database-backups` under the configured data directory, use owner-only directory/file permissions, and retain only the two newest files for each database. An empty new database is not backed up, and startup without pending migrations does not create a backup.

Drizzle applies each pending migration set in a transaction. The one-column legacy compatibility adjustment is also transactional. If migration fails, Treeport does not initialize services or listen; the database and pre-migration snapshot remain available for a corrected binary to retry.

## Consequences

- Schema changes and catalog access use one typed Drizzle boundary over the libSQL local-file driver.
- Upgrade failure is detected before Treeport begins reconciling Git worktrees or tmux sessions.
- SQLite loss cannot directly remove Git-owned work.
- Backup and migration behavior belongs to the daemon, not Electron, an updater, or a second manifest.
- Restore UI, updater orchestration, and a general backup CLI remain deferred to their respective issues.
