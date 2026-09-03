import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WEB_PANEL_INPUT_MAX_BYTES } from '@treeport/shared'
import type {
  WebPanelDefinition,
  WebPanelLaunch,
  WebPanelPermission,
  WorktreeRecord
} from '@treeport/shared'
import { and, eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import { webPanelPermissionGrants, webPanels } from '../../database-schema'
import { DomainError } from '../../domain'
import type { ResolvedWebPanelSource } from '../../web-panel-vite-runtime'
import {
  ProjectObservationOperations,
  ProjectSnapshotOperations
} from '../domain-services'
import type { ApplicationServices } from '../infrastructure/application-runtime'
import {
  DatabasePort,
  EventBusPort,
  PackageSystemPort
} from '../infrastructure/ports'
import { ProjectStore } from '../project/project-store'

const now = (): string => new Date().toISOString()
const WEB_PANEL_ICON_MAX_BYTES = 64 * 1024

type ResolvedDefinition = WebPanelDefinition & ResolvedWebPanelSource

export class PanelDefinitionService {
  private localWebPanelDefinitions(
    worktreeId: string
  ): Effect.Effect<
    ResolvedDefinition[],
    DomainError<unknown>,
    ApplicationServices
  > {
    return Effect.gen(function* () {
      const projectStore = yield* ProjectStore
      const worktree = yield* projectStore.getWorktree(worktreeId)
      const webPanelsRoot = path.join(worktree.path, '.treeport', 'web-panels')
      const directories = yield* Effect.promise(() =>
        fs.readdir(webPanelsRoot, { withFileTypes: true }).catch((error) => {
          // SAFETY: Node filesystem errors expose their stable code here.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return []
          }

          throw error
        })
      )
      const definitions: ResolvedDefinition[] = []
      for (const directory of directories.sort((left, right) =>
        left.name.localeCompare(right.name)
      )) {
        if (!directory.isDirectory()) {
          continue
        }

        const root = path.join(webPanelsRoot, directory.name)
        const entry = 'index.html'
        const entryIsFile = yield* Effect.promise(() =>
          fs
            .stat(path.join(root, entry))
            .then((value) => value.isFile())
            .catch(() => false)
        )
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
          sandbox: { allowSameOrigin: false },
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

  effectiveWebPanelDefinitions(
    worktreeId: string
  ): Effect.Effect<
    ResolvedDefinition[],
    DomainError<unknown>,
    ApplicationServices
  > {
    const localWebPanelDefinitions = this.localWebPanelDefinitions.bind(this)

    return Effect.gen(function* () {
      const packages = yield* PackageSystemPort
      const projectStore = yield* ProjectStore
      const worktree = yield* projectStore.getWorktree(worktreeId)
      const project = yield* projectStore.getProject(worktree.projectId)
      yield* Effect.sync(() => packages.syncProjects([project]))
      const packageDefinitions = yield* packages.webPanelDefinitions(
        worktree.projectId
      )
      const definitions: ResolvedDefinition[] = [
        ...(yield* localWebPanelDefinitions(worktreeId)),
        ...packageDefinitions.map(
          ({
            definition,
            root,
            entry,
            packageRoot,
            development,
            packageLockPath
          }) => {
            const resolved: ResolvedDefinition = {
              ...definition,
              root,
              entry,
              packageRoot,
              development,
              definitionId: definition.id,
              allowNetworkRequests: definition.sandbox.allowSameOrigin
            }
            if (packageLockPath) {
              resolved.packageLockPath = packageLockPath
            }

            if (definition.source.type === 'package') {
              resolved.packageSource = definition.source.source
            }

            return resolved
          }
        )
      ]
      return yield* Effect.forEach(definitions, (definition) =>
        Effect.promise(async () => {
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
            iconSize > WEB_PANEL_ICON_MAX_BYTES
          ) {
            return definition
          }

          return {
            ...definition,
            icon: `data:image/svg+xml;base64,${await fs.readFile(realIcon, 'base64')}`
          }
        })
      )
    })
  }

  webPanelPermissionSourceKey(
    worktreeId: string,
    definition: WebPanelDefinition
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

  webPanelPermissionsGranted(
    worktreeId: string,
    definition: WebPanelDefinition
  ): Effect.Effect<boolean, DomainError<unknown>, ApplicationServices> {
    const webPanelPermissionSourceKey =
      this.webPanelPermissionSourceKey.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const sourceKey = yield* webPanelPermissionSourceKey(
        worktreeId,
        definition
      )
      const [grant] = yield* Effect.promise(() =>
        database.db
          .select({ permissionsJson: webPanelPermissionGrants.permissionsJson })
          .from(webPanelPermissionGrants)
          .where(eq(webPanelPermissionGrants.sourceKey, sourceKey))
          .limit(1)
      )
      if (definition.permissions.length === 0) {
        if (grant) {
          yield* Effect.promise(() =>
            database.db
              .delete(webPanelPermissionGrants)
              .where(eq(webPanelPermissionGrants.sourceKey, sourceKey))
          )
        }

        return true
      }

      const matches =
        grant?.permissionsJson ===
        JSON.stringify([...definition.permissions].sort())
      if (grant && !matches) {
        yield* Effect.promise(() =>
          database.db
            .delete(webPanelPermissionGrants)
            .where(eq(webPanelPermissionGrants.sourceKey, sourceKey))
        )
      }

      return matches
    })
  }

  listWebPanelDefinitions(
    worktreeId: string
  ): Effect.Effect<
    WebPanelDefinition[],
    DomainError<unknown>,
    ApplicationServices
  > {
    const effectiveWebPanelDefinitions =
      this.effectiveWebPanelDefinitions.bind(this)
    const webPanelPermissionsGranted =
      this.webPanelPermissionsGranted.bind(this)

    return Effect.gen(function* () {
      const definitions = yield* effectiveWebPanelDefinitions(worktreeId)
      return yield* Effect.forEach(
        definitions,
        ({
          root: _root,
          entry: _entry,
          packageRoot: _packageRoot,
          development: _development,
          packageLockPath: _packageLockPath,
          definitionId: _definitionId,
          packageSource: _packageSource,
          allowNetworkRequests: _allowNetworkRequests,
          ...definition
        }) =>
          Effect.map(
            webPanelPermissionsGranted(worktreeId, definition),
            (permissionsGranted) => ({ ...definition, permissionsGranted })
          )
      )
    })
  }

  setWebPanelPermissionGrant(
    worktreeId: string,
    definitionId: string,
    granted: boolean,
    expectedPermissions: WebPanelPermission[]
  ): Effect.Effect<
    WebPanelDefinition,
    DomainError<unknown>,
    ApplicationServices
  > {
    const effectiveWebPanelDefinitions =
      this.effectiveWebPanelDefinitions.bind(this)
    const webPanelPermissionSourceKey =
      this.webPanelPermissionSourceKey.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const observations = yield* ProjectObservationOperations
      const projectSnapshots = yield* ProjectSnapshotOperations
      yield* observations.requireAvailableWorktree(worktreeId)
      const definition = (yield* effectiveWebPanelDefinitions(worktreeId)).find(
        (candidate) => candidate.id === definitionId
      )
      if (!definition) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_PANEL_DEFINITION_NOT_FOUND',
            'Web panel definition not found',
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
            'WEB_PANEL_PERMISSIONS_CHANGED',
            'Web panel permissions changed; review them and try again',
            409,
            { permissions: definition.permissions }
          )
        )
      }

      const sourceKey = yield* webPanelPermissionSourceKey(
        worktreeId,
        definition
      )
      if (granted && definition.permissions.length > 0) {
        const timestamp = now()
        yield* Effect.promise(() =>
          database.db
            .insert(webPanelPermissionGrants)
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
              target: webPanelPermissionGrants.sourceKey,
              set: {
                permissionsJson: JSON.stringify(
                  [...definition.permissions].sort()
                ),
                updatedAt: timestamp
              }
            })
        )
      } else {
        yield* Effect.promise(() =>
          database.db
            .delete(webPanelPermissionGrants)
            .where(eq(webPanelPermissionGrants.sourceKey, sourceKey))
        )
      }

      const affectedPanels = yield* Effect.promise(() =>
        database.db
          .select({ id: webPanels.id })
          .from(webPanels)
          .where(
            and(
              eq(webPanels.worktreeId, worktreeId),
              eq(webPanels.definitionId, definitionId)
            )
          )
      )
      yield* Effect.sync(() => projectSnapshots.invalidate())
      yield* Effect.sync(() => {
        for (const panel of affectedPanels) {
          events.publish('panel.updated', {
            worktreeId,
            panelId: panel.id
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

  requireWebPanelPermissions(
    worktreeId: string,
    definition: WebPanelDefinition
  ): Effect.Effect<void, DomainError<unknown>, ApplicationServices> {
    return Effect.flatMap(
      this.webPanelPermissionsGranted(worktreeId, definition),
      (granted) =>
        granted
          ? Effect.void
          : Effect.fail(
              new DomainError(
                'WEB_PANEL_PERMISSION_REQUIRED',
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

  normalizeWebPanelLaunch(
    worktree: WorktreeRecord,
    launch: WebPanelLaunch
  ): Effect.Effect<
    { launch: WebPanelLaunch; inputJson: string },
    DomainError<unknown>
  > {
    return Effect.gen(function* () {
      const inputJson = JSON.stringify(launch.input)
      if (Buffer.byteLength(inputJson) > WEB_PANEL_INPUT_MAX_BYTES) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_PANEL_INPUT_TOO_LARGE',
            'Web panel input is limited to 64 KiB',
            413
          )
        )
      }

      if (launch.cwd === null) {
        return { launch: { input: launch.input, cwd: null }, inputJson }
      }

      const worktreeRoot = yield* Effect.promise(() =>
        fs.realpath(worktree.path)
      )
      const requestedCwd = yield* Effect.promise(() =>
        fs.realpath(path.resolve(worktree.path, launch.cwd!)).catch(() => null)
      )
      if (
        !requestedCwd ||
        !(yield* Effect.promise(() => fs.stat(requestedCwd))).isDirectory()
      ) {
        return yield* Effect.fail(
          new DomainError(
            'INVALID_WEB_PANEL_LAUNCH_CWD',
            'Web panel launch directory does not exist',
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
            'INVALID_WEB_PANEL_LAUNCH_CWD',
            'Web panel launch directory must be inside the tree',
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
