import type {
  PackageListing,
  PackageOperationResult,
  PackageResourceDiagnostic
} from '@treeport/shared'
import { eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import { webPanelPermissionGrants } from '../../database-schema'
import type { DomainError } from '../../domain'
import { PanelOperations, ProjectSnapshotOperations } from '../domain-services'
import type { ApplicationServices } from '../infrastructure/application-runtime'
import {
  DatabasePort,
  EventBusPort,
  PackageSystemPort,
  WebPanelRuntimePort
} from '../infrastructure/ports'
import { ProjectStore } from '../project/project-store'

export class PackageService {
  listPackages(): Effect.Effect<
    {
      packages: PackageListing[]
      diagnostics: PackageResourceDiagnostic[]
    },
    never,
    ApplicationServices
  > {
    return Effect.gen(function* () {
      const packages = yield* PackageSystemPort
      const projectStore = yield* ProjectStore
      const projects = yield* projectStore.storedProjects()
      yield* Effect.sync(() => packages.syncProjects(projects))
      return yield* packages.list()
    })
  }

  installPackage(
    source: string,
    projectId?: string
  ): Effect.Effect<
    PackageOperationResult,
    DomainError<unknown>,
    ApplicationServices
  > {
    const resourcesChanged = this.resourcesChanged.bind(this)

    return Effect.gen(function* () {
      const packages = yield* PackageSystemPort
      const projectStore = yield* ProjectStore
      const webPanelRuntime = yield* WebPanelRuntimePort
      if (projectId) {
        const project = yield* projectStore.getProject(projectId)
        yield* Effect.sync(() => packages.syncProjects([project]))
      }

      const result = yield* packages.install(source, projectId)
      yield* Effect.promise(() => webPanelRuntime.disposeDevelopmentServers())
      yield* resourcesChanged(projectId)
      return result
    })
  }

  removePackage(
    source: string,
    projectId?: string
  ): Effect.Effect<
    PackageOperationResult,
    DomainError<unknown>,
    ApplicationServices
  > {
    const resourcesChanged = this.resourcesChanged.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const packages = yield* PackageSystemPort
      const panels = yield* PanelOperations
      const projectStore = yield* ProjectStore
      const webPanelRuntime = yield* WebPanelRuntimePort
      if (projectId) {
        const project = yield* projectStore.getProject(projectId)
        yield* Effect.sync(() => packages.syncProjects([project]))
      }

      const registeredProjects = projectId
        ? [yield* projectStore.getProject(projectId)]
        : yield* projectStore.storedProjects()
      const collectPermissionSourceKeys = Effect.gen(function* () {
        const keys = new Set<string>()
        for (const project of registeredProjects) {
          const worktree = project.worktrees[0]
          if (!worktree) {
            continue
          }

          const definitions = yield* Effect.catchAll(
            panels.effectiveWebPanelDefinitions(worktree.id),
            () => Effect.succeed([])
          )
          for (const definition of definitions) {
            if (definition.permissions.length > 0) {
              keys.add(
                yield* panels.webPanelPermissionSourceKey(
                  worktree.id,
                  definition
                )
              )
            }
          }
        }
        return keys
      })
      const before = yield* collectPermissionSourceKeys
      const result = yield* packages.remove(source, projectId)
      const after = yield* collectPermissionSourceKeys
      for (const sourceKey of before) {
        if (!after.has(sourceKey)) {
          yield* Effect.promise(() =>
            database.db
              .delete(webPanelPermissionGrants)
              .where(eq(webPanelPermissionGrants.sourceKey, sourceKey))
          )
        }
      }
      yield* Effect.promise(() => webPanelRuntime.disposeDevelopmentServers())
      yield* resourcesChanged(projectId)
      return result
    })
  }

  updatePackages(
    source?: string
  ): Effect.Effect<
    PackageOperationResult[],
    DomainError<unknown>,
    ApplicationServices
  > {
    const resourcesChanged = this.resourcesChanged.bind(this)

    return Effect.gen(function* () {
      const packages = yield* PackageSystemPort
      const projectStore = yield* ProjectStore
      const webPanelRuntime = yield* WebPanelRuntimePort
      const projects = yield* projectStore.storedProjects()
      yield* Effect.sync(() => packages.syncProjects(projects))
      const results = yield* packages.update(source)
      yield* Effect.promise(() => webPanelRuntime.disposeDevelopmentServers())
      yield* resourcesChanged()
      return results
    })
  }

  reloadPackages(projectId?: string): Effect.Effect<
    {
      results: PackageOperationResult[]
      diagnostics: PackageResourceDiagnostic[]
    },
    DomainError<unknown>,
    ApplicationServices
  > {
    const resourcesChanged = this.resourcesChanged.bind(this)

    return Effect.gen(function* () {
      const packages = yield* PackageSystemPort
      const projectStore = yield* ProjectStore
      const webPanelRuntime = yield* WebPanelRuntimePort
      const projects = yield* projectStore.storedProjects()
      yield* Effect.sync(() => packages.syncProjects(projects))
      if (projectId) {
        yield* projectStore.getProject(projectId)
      }

      const result = yield* packages.reload(projectId)
      yield* Effect.promise(() => webPanelRuntime.disposeDevelopmentServers())
      yield* resourcesChanged(projectId)
      return result
    })
  }

  private resourcesChanged(
    projectId?: string
  ): Effect.Effect<void, DomainError<unknown>, ApplicationServices> {
    return Effect.gen(function* () {
      const events = yield* EventBusPort
      const projectSnapshots = yield* ProjectSnapshotOperations
      const projectStore = yield* ProjectStore
      yield* Effect.sync(() => projectSnapshots.invalidate())
      const projects = projectId
        ? [yield* projectStore.getProject(projectId)]
        : yield* projectStore.storedProjects(true)
      yield* Effect.sync(() => {
        for (const project of projects) {
          events.publish('project.updated', { projectId: project.id })
        }
      })
    })
  }
}
