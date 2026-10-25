import crypto from 'node:crypto'
import type { Launcher, LauncherDefinitionListing } from '@treeport/shared'
import { and, asc, eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import { mapLauncher } from '../../database'
import { launchers } from '../../database-schema'
import { DomainError } from '../../domain'
import { loadRepositoryLaunchers } from '../../repository-launchers'
import { Zed } from '../../zed'
import type { ApplicationServices } from '../infrastructure/application-runtime'
import { ConfigPort, PackageSystemPort } from '../infrastructure/ports'
import { DatabasePort } from '../../database'
import { ProjectStore } from '../project/project-store'

const now = (): string => new Date().toISOString()

const id = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`

export class LauncherService {
  listLaunchers(): Effect.Effect<Launcher[], never, ApplicationServices> {
    return Effect.gen(function* () {
      const database = yield* DatabasePort

      const rows = yield* database
        .execute('launcher.service.33', (db) =>
          db
            .select()
            .from(launchers)
            .orderBy(asc(launchers.createdAt), asc(launchers.id))
        )
        .pipe(Effect.orDie)

      return rows.map(mapLauncher)
    })
  }

  listLauncherDefinitions(context?: {
    projectId?: string | undefined
    worktreeId?: string | undefined
  }): Effect.Effect<
    LauncherDefinitionListing,
    DomainError<unknown>,
    ApplicationServices
  > {
    const listLaunchers = this.listLaunchers.bind(this)

    return Effect.gen(function* () {
      const config = yield* ConfigPort
      const zed = yield* Zed
      const packages = yield* PackageSystemPort
      const projectStore = yield* ProjectStore

      const worktree = context?.worktreeId
        ? yield* projectStore.getWorktree(context.worktreeId)
        : null

      const projectId = worktree?.projectId ?? context?.projectId

      const project = projectId
        ? yield* projectStore.getProject(projectId)
        : null

      const worktreePath = worktree?.path ?? project?.mainWorktreePath ?? null

      if (project) {
        yield* Effect.sync(() => packages.syncProjects([project]))
      }

      const [
        userLaunchers,
        packageLaunchers,
        repositoryLaunchers,
        zedLaunchers
      ] = yield* Effect.all(
        [
          listLaunchers(),
          packages.launcherDefinitions(projectId),
          worktreePath && project
            ? Effect.tryPromise(() =>
                loadRepositoryLaunchers(project.id, worktreePath)
              ).pipe(Effect.orDie)
            : Effect.succeed({ definitions: [], diagnostics: [] }),
          worktreePath && project?.kind === 'repository'
            ? zed
                .loadLauncherDefinitions({
                  projectId: project.id,
                  shell: config.shell,
                  mainWorktreePath: project.mainWorktreePath,
                  worktreePath
                })
                .pipe(Effect.orDie)
            : Effect.succeed({ definitions: [], diagnostics: [] })
        ] as const,
        { concurrency: 'unbounded' }
      )

      const repositoryPackageLaunchers = packageLaunchers.filter(
        (launcher) =>
          launcher.source.type === 'package' &&
          launcher.source.scope === 'project'
      )

      const globalPackageLaunchers = packageLaunchers.filter(
        (launcher) =>
          launcher.source.type === 'package' &&
          launcher.source.scope === 'global'
      )

      return {
        definitions: [
          ...repositoryLaunchers.definitions,
          ...zedLaunchers.definitions,
          ...repositoryPackageLaunchers,
          ...userLaunchers.map((launcher) => ({
            id: launcher.id,
            name: launcher.name,
            executable: launcher.executable,
            args: [...launcher.args],
            shellCommand: null,
            cwd: null,
            env: {},
            closeOnSuccess: launcher.closeOnSuccess,
            treeTitle: launcher.treeTitle,
            source: { type: 'user' as const }
          })),
          ...globalPackageLaunchers
        ],
        diagnostics: [
          ...repositoryLaunchers.diagnostics,
          ...zedLaunchers.diagnostics
        ]
      }
    })
  }

  createLauncher(
    input: Pick<Launcher, 'name' | 'executable' | 'args'> &
      Partial<Pick<Launcher, 'closeOnSuccess' | 'treeTitle'>>
  ): Effect.Effect<Launcher, never, ApplicationServices> {
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const timestamp = now()

      const launcher: Launcher = {
        id: id('launcher'),
        name: input.name,
        executable: input.executable,
        args: [...input.args],
        closeOnSuccess: input.closeOnSuccess ?? false,
        treeTitle: input.treeTitle ?? null,
        createdAt: timestamp,
        updatedAt: timestamp
      }

      yield* database
        .execute('launcher.service.142', (db) =>
          db.insert(launchers).values({
            id: launcher.id,
            name: launcher.name,
            executable: launcher.executable,
            argsJson: JSON.stringify(launcher.args),
            closeOnSuccess: Number(launcher.closeOnSuccess),
            treeTitleJson: launcher.treeTitle
              ? JSON.stringify(launcher.treeTitle)
              : null,
            createdAt: launcher.createdAt,
            updatedAt: launcher.updatedAt
          })
        )
        .pipe(Effect.orDie)

      return launcher
    })
  }

  updateLauncher(
    launcherId: string,
    input: Pick<Launcher, 'name' | 'executable' | 'args'> & {
      closeOnSuccess?: boolean | undefined
      treeTitle?: Launcher['treeTitle'] | undefined
    },
    expectedUpdatedAt: string
  ): Effect.Effect<Launcher, DomainError<unknown>, ApplicationServices> {
    return Effect.gen(function* () {
      const database = yield* DatabasePort

      const [existingRow] = yield* database
        .execute('launcher.service.166', (db) =>
          db
            .select()
            .from(launchers)
            .where(eq(launchers.id, launcherId))
            .limit(1)
        )
        .pipe(Effect.orDie)

      if (!existingRow) {
        return yield* Effect.fail(
          new DomainError('LAUNCHER_NOT_FOUND', 'Launcher not found', 404)
        )
      }

      const existing = mapLauncher(existingRow)

      if (existing.updatedAt !== expectedUpdatedAt) {
        return yield* Effect.fail(
          new DomainError(
            'LAUNCHER_CHANGED',
            'Launcher changed; review the latest values and try again',
            409
          )
        )
      }

      const timestamp = now()

      const launcher: Launcher = {
        ...existing,
        name: input.name,
        executable: input.executable,
        args: [...input.args],
        closeOnSuccess: input.closeOnSuccess ?? existing.closeOnSuccess,
        treeTitle:
          input.treeTitle === undefined ? existing.treeTitle : input.treeTitle,
        updatedAt:
          timestamp > existing.updatedAt
            ? timestamp
            : new Date(Date.parse(existing.updatedAt) + 1).toISOString()
      }

      const result = yield* database
        .execute('launcher.service.206', (db) =>
          db
            .update(launchers)
            .set({
              name: launcher.name,
              executable: launcher.executable,
              argsJson: JSON.stringify(launcher.args),
              closeOnSuccess: Number(launcher.closeOnSuccess),
              treeTitleJson: launcher.treeTitle
                ? JSON.stringify(launcher.treeTitle)
                : null,
              updatedAt: launcher.updatedAt
            })
            .where(
              and(
                eq(launchers.id, launcher.id),
                eq(launchers.updatedAt, expectedUpdatedAt)
              )
            )
        )
        .pipe(Effect.orDie)

      if (result.rowsAffected === 0) {
        return yield* Effect.fail(
          new DomainError(
            'LAUNCHER_CHANGED',
            'Launcher changed; review the latest values and try again',
            409
          )
        )
      }

      return launcher
    })
  }

  deleteLauncher(
    launcherId: string,
    expectedUpdatedAt: string
  ): Effect.Effect<void, DomainError<unknown>, ApplicationServices> {
    return Effect.gen(function* () {
      const database = yield* DatabasePort

      const [existing] = yield* database
        .execute('launcher.service.243', (db) =>
          db
            .select({ updatedAt: launchers.updatedAt })
            .from(launchers)
            .where(eq(launchers.id, launcherId))
            .limit(1)
        )
        .pipe(Effect.orDie)

      if (!existing) {
        return yield* Effect.fail(
          new DomainError('LAUNCHER_NOT_FOUND', 'Launcher not found', 404)
        )
      }

      const result = yield* database
        .execute('launcher.service.260', (db) =>
          db
            .delete(launchers)
            .where(
              and(
                eq(launchers.id, launcherId),
                eq(launchers.updatedAt, expectedUpdatedAt)
              )
            )
        )
        .pipe(Effect.orDie)

      if (
        existing.updatedAt !== expectedUpdatedAt ||
        result.rowsAffected === 0
      ) {
        return yield* Effect.fail(
          new DomainError(
            'LAUNCHER_CHANGED',
            'Launcher changed; review the latest values and try again',
            409
          )
        )
      }
    })
  }
}
