import type {
  PackageListing,
  PackageOperationResult,
  PackageResourceDiagnostic,
  ProjectRecord,
  WebPanelDefinition
} from '@treeport/shared'
import { eq } from 'drizzle-orm'
import type { TreeportDatabase } from '../../database'
import { webPanelPermissionGrants } from '../../database-schema'
import type { ProductEventBus } from '../../events'
import type { PackageSystem } from '../../package-system'
import type { WebPanelViteRuntime } from '../../web-panel-vite-runtime'

export interface PackageServiceDependencies {
  readonly database: TreeportDatabase
  readonly events: ProductEventBus
  readonly packages: PackageSystem
  readonly webPanelRuntime: WebPanelViteRuntime
  readonly storedProjects: (openOnly?: boolean) => Promise<ProjectRecord[]>
  readonly getProject: (projectId: string) => Promise<ProjectRecord>
  readonly invalidateProjectsSnapshot: () => void
  readonly effectiveWebPanelDefinitions: (
    worktreeId: string
  ) => Promise<WebPanelDefinition[]>
  readonly webPanelPermissionSourceKey: (
    worktreeId: string,
    definition: WebPanelDefinition
  ) => Promise<string>
}

export class PackageService {
  constructor(private readonly dependencies: PackageServiceDependencies) {}

  async listPackages(): Promise<{
    packages: PackageListing[]
    diagnostics: PackageResourceDiagnostic[]
  }> {
    const { packages, storedProjects } = this.dependencies
    packages.syncProjects(await storedProjects())
    return packages.list()
  }

  async installPackage(
    source: string,
    projectId?: string
  ): Promise<PackageOperationResult> {
    const { getProject, packages, webPanelRuntime } = this.dependencies
    if (projectId) {
      packages.syncProjects([await getProject(projectId)])
    }

    const result = await packages.install(source, projectId)
    await webPanelRuntime.disposeDevelopmentServers()
    await this.resourcesChanged(projectId)
    return result
  }

  async removePackage(
    source: string,
    projectId?: string
  ): Promise<PackageOperationResult> {
    const {
      database,
      effectiveWebPanelDefinitions,
      getProject,
      packages,
      storedProjects,
      webPanelPermissionSourceKey,
      webPanelRuntime
    } = this.dependencies
    if (projectId) {
      packages.syncProjects([await getProject(projectId)])
    }

    const registeredProjects = projectId
      ? [await getProject(projectId)]
      : await storedProjects()
    const collectPermissionSourceKeys = async () => {
      const keys = new Set<string>()
      for (const project of registeredProjects) {
        const worktree = project.worktrees[0]
        if (!worktree) {
          continue
        }

        const definitions = await effectiveWebPanelDefinitions(
          worktree.id
        ).catch(() => [])
        for (const definition of definitions) {
          if (definition.permissions.length > 0) {
            keys.add(await webPanelPermissionSourceKey(worktree.id, definition))
          }
        }
      }
      return keys
    }
    const before = await collectPermissionSourceKeys()
    const result = await packages.remove(source, projectId)
    const after = await collectPermissionSourceKeys()
    for (const sourceKey of before) {
      if (!after.has(sourceKey)) {
        await database.db
          .delete(webPanelPermissionGrants)
          .where(eq(webPanelPermissionGrants.sourceKey, sourceKey))
      }
    }
    await webPanelRuntime.disposeDevelopmentServers()
    await this.resourcesChanged(projectId)
    return result
  }

  async updatePackages(source?: string): Promise<PackageOperationResult[]> {
    const { packages, storedProjects, webPanelRuntime } = this.dependencies
    packages.syncProjects(await storedProjects())
    const results = await packages.update(source)
    await webPanelRuntime.disposeDevelopmentServers()
    await this.resourcesChanged()
    return results
  }

  async reloadPackages(projectId?: string): Promise<{
    results: PackageOperationResult[]
    diagnostics: PackageResourceDiagnostic[]
  }> {
    const { getProject, packages, storedProjects, webPanelRuntime } =
      this.dependencies
    packages.syncProjects(await storedProjects())
    if (projectId) {
      await getProject(projectId)
    }

    const result = await packages.reload(projectId)
    await webPanelRuntime.disposeDevelopmentServers()
    await this.resourcesChanged(projectId)
    return result
  }

  private async resourcesChanged(projectId?: string): Promise<void> {
    const { events, getProject, invalidateProjectsSnapshot, storedProjects } =
      this.dependencies
    invalidateProjectsSnapshot()
    const projects = projectId
      ? [await getProject(projectId)]
      : await storedProjects(true)
    for (const project of projects) {
      events.publish('project.updated', { projectId: project.id })
    }
  }
}
