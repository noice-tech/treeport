import crypto from 'node:crypto'
import type {
  TerminalPreset,
  TerminalPresetDefinitionListing
} from '@treeport/shared'
import { and, asc, eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import { mapTerminalPreset } from '../../database'
import { terminalPresets } from '../../database-schema'
import { DomainError } from '../../domain'
import { loadRepositoryTerminalPresets } from '../../repository-terminal-presets'
import { Zed } from '../../zed'
import type { ApplicationServices } from '../infrastructure/application-runtime'
import { ConfigPort, PackageSystemPort } from '../infrastructure/ports'
import { DatabasePort } from '../../database'
import { ProjectStore } from '../project/project-store'

const now = (): string => new Date().toISOString()
const id = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`

export class TerminalPresetService {
  listTerminalPresets(): Effect.Effect<
    TerminalPreset[],
    never,
    ApplicationServices
  > {
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const rows = yield* database
        .execute('terminal.preset.service.33', (db) =>
          db
            .select()
            .from(terminalPresets)
            .orderBy(asc(terminalPresets.createdAt), asc(terminalPresets.id))
        )
        .pipe(Effect.orDie)
      return rows.map(mapTerminalPreset)
    })
  }

  listTerminalPresetDefinitions(context?: {
    projectId?: string | undefined
    worktreeId?: string | undefined
  }): Effect.Effect<
    TerminalPresetDefinitionListing,
    DomainError<unknown>,
    ApplicationServices
  > {
    const listTerminalPresets = this.listTerminalPresets.bind(this)

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
      if (project) {
        yield* Effect.sync(() => packages.syncProjects([project]))
      }

      const [userPresets, packagePresets, repositoryPresets, zedPresets] =
        yield* Effect.all(
          [
            listTerminalPresets(),
            packages.terminalPresetDefinitions(projectId),
            worktree && project
              ? Effect.tryPromise(() =>
                  loadRepositoryTerminalPresets(project.id, worktree.path)
                ).pipe(Effect.orDie)
              : Effect.succeed({ definitions: [], diagnostics: [] }),
            worktree && project?.kind === 'repository'
              ? zed
                  .loadTerminalPresetDefinitions({
                    projectId: project.id,
                    shell: config.shell,
                    mainWorktreePath: project.mainWorktreePath,
                    worktreePath: worktree.path
                  })
                  .pipe(Effect.orDie)
              : Effect.succeed({ definitions: [], diagnostics: [] })
          ] as const,
          { concurrency: 'unbounded' }
        )
      const repositoryPackagePresets = packagePresets.filter(
        (preset) =>
          preset.source.type === 'package' && preset.source.scope === 'project'
      )
      const globalPackagePresets = packagePresets.filter(
        (preset) =>
          preset.source.type === 'package' && preset.source.scope === 'global'
      )

      return {
        definitions: [
          ...repositoryPresets.definitions,
          ...zedPresets.definitions,
          ...repositoryPackagePresets,
          ...userPresets.map((preset) => ({
            id: preset.id,
            name: preset.name,
            executable: preset.executable,
            args: [...preset.args],
            shellCommand: null,
            cwd: null,
            env: {},
            closeOnSuccess: preset.closeOnSuccess,
            source: { type: 'user' as const }
          })),
          ...globalPackagePresets
        ],
        diagnostics: [
          ...repositoryPresets.diagnostics,
          ...zedPresets.diagnostics
        ]
      }
    })
  }

  createTerminalPreset(
    input: Pick<TerminalPreset, 'name' | 'executable' | 'args'> &
      Partial<Pick<TerminalPreset, 'closeOnSuccess'>>
  ): Effect.Effect<TerminalPreset, never, ApplicationServices> {
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const timestamp = now()
      const preset: TerminalPreset = {
        id: id('preset'),
        name: input.name,
        executable: input.executable,
        args: [...input.args],
        closeOnSuccess: input.closeOnSuccess ?? false,
        createdAt: timestamp,
        updatedAt: timestamp
      }
      yield* database
        .execute('terminal.preset.service.142', (db) =>
          db.insert(terminalPresets).values({
            id: preset.id,
            name: preset.name,
            executable: preset.executable,
            argsJson: JSON.stringify(preset.args),
            closeOnSuccess: Number(preset.closeOnSuccess),
            createdAt: preset.createdAt,
            updatedAt: preset.updatedAt
          })
        )
        .pipe(Effect.orDie)
      return preset
    })
  }

  updateTerminalPreset(
    presetId: string,
    input: Pick<TerminalPreset, 'name' | 'executable' | 'args'> & {
      closeOnSuccess?: boolean | undefined
    },
    expectedUpdatedAt: string
  ): Effect.Effect<TerminalPreset, DomainError<unknown>, ApplicationServices> {
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const [existingRow] = yield* database
        .execute('terminal.preset.service.166', (db) =>
          db
            .select()
            .from(terminalPresets)
            .where(eq(terminalPresets.id, presetId))
            .limit(1)
        )
        .pipe(Effect.orDie)
      if (!existingRow) {
        return yield* Effect.fail(
          new DomainError(
            'TERMINAL_PRESET_NOT_FOUND',
            'Terminal preset not found',
            404
          )
        )
      }

      const existing = mapTerminalPreset(existingRow)
      if (existing.updatedAt !== expectedUpdatedAt) {
        return yield* Effect.fail(
          new DomainError(
            'TERMINAL_PRESET_CHANGED',
            'Terminal preset changed; review the latest values and try again',
            409
          )
        )
      }

      const timestamp = now()
      const preset: TerminalPreset = {
        ...existing,
        name: input.name,
        executable: input.executable,
        args: [...input.args],
        closeOnSuccess: input.closeOnSuccess ?? existing.closeOnSuccess,
        updatedAt:
          timestamp > existing.updatedAt
            ? timestamp
            : new Date(Date.parse(existing.updatedAt) + 1).toISOString()
      }
      const result = yield* database
        .execute('terminal.preset.service.206', (db) =>
          db
            .update(terminalPresets)
            .set({
              name: preset.name,
              executable: preset.executable,
              argsJson: JSON.stringify(preset.args),
              closeOnSuccess: Number(preset.closeOnSuccess),
              updatedAt: preset.updatedAt
            })
            .where(
              and(
                eq(terminalPresets.id, preset.id),
                eq(terminalPresets.updatedAt, expectedUpdatedAt)
              )
            )
        )
        .pipe(Effect.orDie)
      if (result.rowsAffected === 0) {
        return yield* Effect.fail(
          new DomainError(
            'TERMINAL_PRESET_CHANGED',
            'Terminal preset changed; review the latest values and try again',
            409
          )
        )
      }

      return preset
    })
  }

  deleteTerminalPreset(
    presetId: string,
    expectedUpdatedAt: string
  ): Effect.Effect<void, DomainError<unknown>, ApplicationServices> {
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const [existing] = yield* database
        .execute('terminal.preset.service.243', (db) =>
          db
            .select({ updatedAt: terminalPresets.updatedAt })
            .from(terminalPresets)
            .where(eq(terminalPresets.id, presetId))
            .limit(1)
        )
        .pipe(Effect.orDie)
      if (!existing) {
        return yield* Effect.fail(
          new DomainError(
            'TERMINAL_PRESET_NOT_FOUND',
            'Terminal preset not found',
            404
          )
        )
      }

      const result = yield* database
        .execute('terminal.preset.service.260', (db) =>
          db
            .delete(terminalPresets)
            .where(
              and(
                eq(terminalPresets.id, presetId),
                eq(terminalPresets.updatedAt, expectedUpdatedAt)
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
            'TERMINAL_PRESET_CHANGED',
            'Terminal preset changed; review the latest values and try again',
            409
          )
        )
      }
    })
  }
}
