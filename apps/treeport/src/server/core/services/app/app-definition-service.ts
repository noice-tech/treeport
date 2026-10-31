import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WEB_APP_INPUT_MAX_BYTES } from '@treeport/shared'
import type {
  WebAppDefinition,
  WebAppLaunch,
  WebAppPermission,
  WorktreeRecord
} from '@treeport/shared'
import { and, eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import { webAppPermissionGrants, webApps } from '../../database-schema.ts'
import { DomainError } from '../../domain.ts'
import type { ResolvedWebAppSource } from '../../web-app-vite-runtime.ts'
import {
  ProjectObservationOperations,
  ProjectSnapshotOperations
} from '../domain-services.ts'
import type { ApplicationServices } from '../infrastructure/application-runtime.ts'
import { EventBusPort, PackageSystemPort } from '../infrastructure/ports.ts'
import { DatabasePort } from '../../database.ts'
import { ProjectStore } from '../project/project-store.ts'

const now = (): string => new Date().toISOString()
const WEB_APP_ICON_MAX_BYTES = 64 * 1024

type ResolvedDefinition = WebAppDefinition & ResolvedWebAppSource

export class AppDefinitionService {
  private localWebAppDefinitions(
    worktreeId: string
  ): Effect.Effect<
    ResolvedDefinition[],
    DomainError<unknown>,
    ApplicationServices
  > {
    return Effect.gen(function* () {
      const projectStore = yield* ProjectStore
      const worktree = yield* projectStore.getWorktree(worktreeId)
      const webAppsRoot = path.join(worktree.path, '.treeport', 'web-apps')

      const directories = yield* Effect.tryPromise(() =>
        fs.readdir(webAppsRoot, { withFileTypes: true }).catch((error) => {
          // SAFETY: Node filesystem errors expose their stable code here.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return []
          }

          throw error
        })
      ).pipe(Effect.orDie)

      const definitions: ResolvedDefinition[] = []

      for (const directory of directories.sort((left, right) =>
        left.name.localeCompare(right.name)
      )) {
        if (!directory.isDirectory()) {
          continue
        }

        const root = path.join(webAppsRoot, directory.name)
        const entry = 'index.html'

        const entryIsFile = yield* Effect.tryPromise(() =>
          fs
            .stat(path.join(root, entry))
            .then((value) => value.isFile())
            .catch(() => false)
        ).pipe(Effect.orDie)

        if (!entryIsFile) {
          continue
        }

        const words = directory.name
          .split(/[-_.]+/)
          .filter(Boolean)
          .join(' ')

        definitions.push({
          id: `project:${encodeURIComponent(directory.name)}`,
          title: words
            ? `${words[0]!.toLocaleUpperCase()}${words.slice(1)}`
            : directory.name,
          icon: null,
          source: { type: 'project' },
          permissions: [],
          permissionsGranted: true,
          sandbox: { enabled: true, allowSameOrigin: false },
          root,
          entry,
          packageRoot: worktree.path,
          development: true,
          definitionId: `project:${encodeURIComponent(directory.name)}`,
          allowNetworkRequests: false
        })
      }

      return definitions
    })
  }

  effectiveWebAppDefinitions(
    worktreeId: string
  ): Effect.Effect<
    ResolvedDefinition[],
    DomainError<unknown>,
    ApplicationServices
  > {
    const localWebAppDefinitions = this.localWebAppDefinitions.bind(this)

    return Effect.gen(function* () {
      const packages = yield* PackageSystemPort
      const projectStore = yield* ProjectStore
      const worktree = yield* projectStore.getWorktree(worktreeId)
      const project = yield* projectStore.getProject(worktree.projectId)
      yield* Effect.sync(() => packages.syncProjects([project]))

      const packageDefinitions = yield* packages.webAppDefinitions(
        worktree.projectId
      )

      const definitions: ResolvedDefinition[] = [
        ...(yield* localWebAppDefinitions(worktreeId)),
        ...packageDefinitions.map(
          ({ definition, root, entry, packageRoot, development }) => {
            const resolved: ResolvedDefinition = {
              ...definition,
              root,
              entry,
              packageRoot,
              development,
              definitionId: definition.id,
              allowNetworkRequests: definition.sandbox.allowSameOrigin
            }

            if (definition.source.type === 'package') {
              resolved.packageSource = definition.source.source
            }

            return resolved
          }
        )
      ]

      return yield* Effect.forEach(definitions, (definition) =>
        Effect.tryPromise(async () => {
          const realRoot = await fs.realpath(definition.root).catch(() => null)

          const realIcon = await fs
            .realpath(path.join(definition.root, 'icon.svg'))
            .catch(() => null)

          if (!realRoot || !realIcon) {
            return definition
          }

          const relativeIcon = path.relative(realRoot, realIcon)

          const iconSize = await fs
            .stat(realIcon)
            .then((value) => (value.isFile() ? value.size : null))
            .catch(() => null)

          if (
            path.isAbsolute(relativeIcon) ||
            relativeIcon === '..' ||
            relativeIcon.startsWith(`..${path.sep}`) ||
            iconSize === null ||
            iconSize > WEB_APP_ICON_MAX_BYTES
          ) {
            return definition
          }

          return {
            ...definition,
            icon: `data:image/svg+xml;base64,${await fs.readFile(realIcon, 'base64')}`
          }
        }).pipe(Effect.orDie)
      )
    })
  }

  webAppPermissionSourceKey(
    worktreeId: string,
    definition: WebAppDefinition
  ): Effect.Effect<string, DomainError<unknown>, ApplicationServices> {
    return Effect.gen(function* () {
      const projectStore = yield* ProjectStore
      const worktree = yield* projectStore.getWorktree(worktreeId)

      const source =
        definition.source.type === 'project'
          ? {
              type: 'project',
              projectId: worktree.projectId,
              definitionId: definition.id
            }
          : {
              type: 'package',
              scope: definition.source.scope,
              projectId:
                definition.source.scope === 'project'
                  ? worktree.projectId
                  : null,
              packageId: definition.source.packageId,
              source: definition.source.source,
              definitionId: definition.id
            }

      return crypto
        .createHash('sha256')
        .update(JSON.stringify(source))
        .digest('hex')
    })
  }

  webAppPermissionsGranted(
    worktreeId: string,
    definition: WebAppDefinition
  ): Effect.Effect<boolean, DomainError<unknown>, ApplicationServices> {
    const webAppPermissionSourceKey = this.webAppPermissionSourceKey.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const sourceKey = yield* webAppPermissionSourceKey(worktreeId, definition)

      const [grant] = yield* database
        .execute('app.definition.service.230', (db) =>
          db
            .select({
              permissionsJson: webAppPermissionGrants.permissionsJson
            })
            .from(webAppPermissionGrants)
            .where(eq(webAppPermissionGrants.sourceKey, sourceKey))
            .limit(1)
        )
        .pipe(Effect.orDie)

      if (definition.permissions.length === 0) {
        if (grant) {
          yield* database
            .execute('app.definition.service.239', (db) =>
              db
                .delete(webAppPermissionGrants)
                .where(eq(webAppPermissionGrants.sourceKey, sourceKey))
            )
            .pipe(Effect.orDie)
        }

        return true
      }

      const matches =
        grant?.permissionsJson ===
        JSON.stringify([...definition.permissions].sort())

      if (grant && !matches) {
        yield* database
          .execute('app.definition.service.253', (db) =>
            db
              .delete(webAppPermissionGrants)
              .where(eq(webAppPermissionGrants.sourceKey, sourceKey))
          )
          .pipe(Effect.orDie)
      }

      return matches
    })
  }

  listWebAppDefinitions(
    worktreeId: string
  ): Effect.Effect<
    WebAppDefinition[],
    DomainError<unknown>,
    ApplicationServices
  > {
    const effectiveWebAppDefinitions =
      this.effectiveWebAppDefinitions.bind(this)

    const webAppPermissionsGranted = this.webAppPermissionsGranted.bind(this)

    return Effect.gen(function* () {
      const definitions = yield* effectiveWebAppDefinitions(worktreeId)

      return yield* Effect.forEach(
        definitions,
        ({
          root: _root,
          entry: _entry,
          packageRoot: _packageRoot,
          development: _development,
          definitionId: _definitionId,
          packageSource: _packageSource,
          allowNetworkRequests: _allowNetworkRequests,
          ...definition
        }) =>
          Effect.map(
            webAppPermissionsGranted(worktreeId, definition),
            (permissionsGranted) => ({ ...definition, permissionsGranted })
          )
      )
    })
  }

  setWebAppPermissionGrant(
    worktreeId: string,
    definitionId: string,
    granted: boolean,
    expectedPermissions: WebAppPermission[]
  ): Effect.Effect<
    WebAppDefinition,
    DomainError<unknown>,
    ApplicationServices
  > {
    const effectiveWebAppDefinitions =
      this.effectiveWebAppDefinitions.bind(this)

    const webAppPermissionSourceKey = this.webAppPermissionSourceKey.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const observations = yield* ProjectObservationOperations
      const projectSnapshots = yield* ProjectSnapshotOperations
      yield* observations.requireAvailableWorktree(worktreeId)

      const definition = (yield* effectiveWebAppDefinitions(worktreeId)).find(
        (candidate) => candidate.id === definitionId
      )

      if (!definition) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_APP_DEFINITION_NOT_FOUND',
            'Web app definition not found',
            404
          )
        )
      }

      if (
        JSON.stringify([...definition.permissions].sort()) !==
        JSON.stringify([...expectedPermissions].sort())
      ) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_APP_PERMISSIONS_CHANGED',
            'Web app permissions changed; review them and try again',
            409,
            { permissions: definition.permissions }
          )
        )
      }

      const sourceKey = yield* webAppPermissionSourceKey(worktreeId, definition)

      if (granted && definition.permissions.length > 0) {
        const timestamp = now()
        yield* database
          .execute('app.definition.service.353', (db) =>
            db
              .insert(webAppPermissionGrants)
              .values({
                sourceKey,
                definitionId,
                permissionsJson: JSON.stringify(
                  [...definition.permissions].sort()
                ),
                grantedAt: timestamp,
                updatedAt: timestamp
              })
              .onConflictDoUpdate({
                target: webAppPermissionGrants.sourceKey,
                set: {
                  permissionsJson: JSON.stringify(
                    [...definition.permissions].sort()
                  ),
                  updatedAt: timestamp
                }
              })
          )
          .pipe(Effect.orDie)
      } else {
        yield* database
          .execute('app.definition.service.376', (db) =>
            db
              .delete(webAppPermissionGrants)
              .where(eq(webAppPermissionGrants.sourceKey, sourceKey))
          )
          .pipe(Effect.orDie)
      }

      const affectedApps = yield* database
        .execute('app.definition.service.383', (db) =>
          db
            .select({ id: webApps.id })
            .from(webApps)
            .where(
              and(
                eq(webApps.worktreeId, worktreeId),
                eq(webApps.definitionId, definitionId)
              )
            )
        )
        .pipe(Effect.orDie)

      yield* Effect.sync(() => projectSnapshots.invalidate())
      yield* Effect.sync(() => {
        for (const app of affectedApps) {
          events.publish('app.updated', {
            worktreeId,
            appId: app.id
          })
        }
      })

      return {
        id: definition.id,
        title: definition.title,
        icon: definition.icon,
        source: definition.source,
        permissions: definition.permissions,
        permissionsGranted:
          definition.permissions.length === 0 ? true : granted,
        sandbox: definition.sandbox
      }
    })
  }

  requireWebAppPermissions(
    worktreeId: string,
    definition: WebAppDefinition
  ): Effect.Effect<void, DomainError<unknown>, ApplicationServices> {
    return Effect.flatMap(
      this.webAppPermissionsGranted(worktreeId, definition),
      (granted) =>
        granted
          ? Effect.void
          : Effect.fail(
              new DomainError(
                'WEB_APP_PERMISSION_REQUIRED',
                `Permission is required before ${definition.title} can open`,
                403,
                {
                  definitionId: definition.id,
                  permissions: definition.permissions
                }
              )
            )
    )
  }

  normalizeWebAppLaunch(
    worktree: WorktreeRecord,
    launch: WebAppLaunch
  ): Effect.Effect<
    { launch: WebAppLaunch; inputJson: string },
    DomainError<unknown>
  > {
    return Effect.gen(function* () {
      const inputJson = JSON.stringify(launch.input)

      if (Buffer.byteLength(inputJson) > WEB_APP_INPUT_MAX_BYTES) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_APP_INPUT_TOO_LARGE',
            'Web app input is limited to 64 KiB',
            413
          )
        )
      }

      if (launch.cwd === null) {
        return { launch: { input: launch.input, cwd: null }, inputJson }
      }

      const worktreeRoot = yield* Effect.tryPromise(() =>
        fs.realpath(worktree.path)
      ).pipe(Effect.orDie)

      const requestedCwd = yield* Effect.tryPromise(() =>
        fs.realpath(path.resolve(worktree.path, launch.cwd!)).catch(() => null)
      ).pipe(Effect.orDie)

      if (
        !requestedCwd ||
        !(yield* Effect.tryPromise(() => fs.stat(requestedCwd)).pipe(
          Effect.orDie
        )).isDirectory()
      ) {
        return yield* Effect.fail(
          new DomainError(
            'INVALID_WEB_APP_LAUNCH_CWD',
            'Web app launch directory does not exist',
            400
          )
        )
      }

      const relativeCwd = path.relative(worktreeRoot, requestedCwd)

      if (
        relativeCwd === '..' ||
        relativeCwd.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeCwd)
      ) {
        return yield* Effect.fail(
          new DomainError(
            'INVALID_WEB_APP_LAUNCH_CWD',
            'Web app launch directory must be inside the tree',
            400
          )
        )
      }

      return {
        launch: { input: launch.input, cwd: relativeCwd || '.' },
        inputJson
      }
    })
  }
}
