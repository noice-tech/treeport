import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WEB_PANEL_INPUT_MAX_BYTES } from '@treeport/shared'
import type {
  ProjectRecord,
  WebPanelDefinition,
  WebPanelLaunch,
  WebPanelPermission,
  WorktreeRecord
} from '@treeport/shared'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import type { TreeportDatabase } from '../../database'
import { webPanelPermissionGrants, webPanels } from '../../database-schema'
import { DomainError } from '../../domain'
import type { ProductEventBus } from '../../events'
import type { PackageSystem } from '../../package-system'
import type {
  ResolvedWebPanelSource,
  WebPanelViteRuntime
} from '../../web-panel-vite-runtime'

const now = (): string => new Date().toISOString()
const WEB_PANEL_ICON_MAX_BYTES = 64 * 1024

export interface PanelDefinitionDependencies {
  readonly config: AppConfig
  readonly database: TreeportDatabase
  readonly packages: PackageSystem
  readonly webPanelRuntime: WebPanelViteRuntime
  readonly events: ProductEventBus
  readonly requireAvailableWorktree: (
    worktreeId: string,
    allowPrunable?: boolean
  ) => Promise<WorktreeRecord>
  readonly getProject: (projectId: string) => Promise<ProjectRecord>
  readonly getWorktree: (worktreeId: string) => Promise<WorktreeRecord>
  readonly invalidateProjectsSnapshot: () => void
}

export class PanelDefinitionService {
  constructor(private readonly host: PanelDefinitionDependencies) {}

  private get deps() {
    return this.host
  }

  private get events() {
    return this.host.events
  }

  private get packages() {
    return this.host.packages
  }

  private get webPanelRuntime() {
    return this.host.webPanelRuntime
  }

  private requireAvailableWorktree(worktreeId: string, allowPrunable = false) {
    return this.host.requireAvailableWorktree(worktreeId, allowPrunable)
  }

  private getProject(projectId: string) {
    return this.host.getProject(projectId)
  }

  private getWorktree(worktreeId: string) {
    return this.host.getWorktree(worktreeId)
  }

  private invalidateProjectsSnapshot() {
    this.host.invalidateProjectsSnapshot()
  }

  private async localWebPanelDefinitions(
    worktreeId: string
  ): Promise<Array<WebPanelDefinition & ResolvedWebPanelSource>> {
    const worktree = await this.getWorktree(worktreeId)
    const webPanelsRoot = path.join(worktree.path, '.treeport', 'web-panels')
    const directories = await fs
      .readdir(webPanelsRoot, { withFileTypes: true })
      .catch((error) => {
        // SAFETY: The surrounding boundary contract establishes this asserted value.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return []
        }

        throw error
      })
    const definitions: Array<WebPanelDefinition & ResolvedWebPanelSource> = []
    for (const directory of directories.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (!directory.isDirectory()) {
        continue
      }

      const root = path.join(webPanelsRoot, directory.name)
      const entry = 'index.html'
      const entryIsFile = await fs
        .stat(path.join(root, entry))
        .then((value) => value.isFile())
        .catch(() => false)
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
  }

  async effectiveWebPanelDefinitions(
    worktreeId: string
  ): Promise<Array<WebPanelDefinition & ResolvedWebPanelSource>> {
    const worktree = await this.getWorktree(worktreeId)
    this.packages.syncProjects([await this.getProject(worktree.projectId)])
    const definitions = [
      ...(await this.localWebPanelDefinitions(worktreeId)),
      ...(await this.packages.webPanelDefinitions(worktree.projectId)).map(
        ({
          definition,
          root,
          entry,
          packageRoot,
          development,
          packageLockPath
        }) => {
          const resolved: WebPanelDefinition & ResolvedWebPanelSource = {
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
    return Promise.all(
      definitions.map(async (definition) => {
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
  }

  async webPanelPermissionSourceKey(
    worktreeId: string,
    definition: WebPanelDefinition
  ): Promise<string> {
    const worktree = await this.getWorktree(worktreeId)
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
              definition.source.scope === 'project' ? worktree.projectId : null,
            packageId: definition.source.packageId,
            source: definition.source.source,
            definitionId: definition.id
          }
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(source))
      .digest('hex')
  }

  async webPanelPermissionsGranted(
    worktreeId: string,
    definition: WebPanelDefinition
  ): Promise<boolean> {
    const sourceKey = await this.webPanelPermissionSourceKey(
      worktreeId,
      definition
    )
    const [grant] = await this.deps.database.db
      .select({ permissionsJson: webPanelPermissionGrants.permissionsJson })
      .from(webPanelPermissionGrants)
      .where(eq(webPanelPermissionGrants.sourceKey, sourceKey))
      .limit(1)
    if (definition.permissions.length === 0) {
      if (grant) {
        await this.deps.database.db
          .delete(webPanelPermissionGrants)
          .where(eq(webPanelPermissionGrants.sourceKey, sourceKey))
      }

      return true
    }

    const matches =
      grant?.permissionsJson ===
      JSON.stringify([...definition.permissions].sort())
    if (grant && !matches) {
      await this.deps.database.db
        .delete(webPanelPermissionGrants)
        .where(eq(webPanelPermissionGrants.sourceKey, sourceKey))
    }

    return matches
  }

  async listWebPanelDefinitions(
    worktreeId: string
  ): Promise<WebPanelDefinition[]> {
    const definitions = await this.effectiveWebPanelDefinitions(worktreeId)
    return Promise.all(
      definitions.map(
        async ({
          root: _root,
          entry: _entry,
          packageRoot: _packageRoot,
          development: _development,
          packageLockPath: _packageLockPath,
          definitionId: _definitionId,
          packageSource: _packageSource,
          allowNetworkRequests: _allowNetworkRequests,
          ...definition
        }) => ({
          ...definition,
          permissionsGranted: await this.webPanelPermissionsGranted(
            worktreeId,
            definition
          )
        })
      )
    )
  }

  async setWebPanelPermissionGrant(
    worktreeId: string,
    definitionId: string,
    granted: boolean,
    expectedPermissions: WebPanelPermission[]
  ): Promise<WebPanelDefinition> {
    await this.requireAvailableWorktree(worktreeId)
    const definition = (
      await this.effectiveWebPanelDefinitions(worktreeId)
    ).find((candidate) => candidate.id === definitionId)
    if (!definition) {
      throw new DomainError(
        'WEB_PANEL_DEFINITION_NOT_FOUND',
        'Web panel definition not found',
        404
      )
    }

    if (
      JSON.stringify([...definition.permissions].sort()) !==
      JSON.stringify([...expectedPermissions].sort())
    ) {
      throw new DomainError(
        'WEB_PANEL_PERMISSIONS_CHANGED',
        'Web panel permissions changed; review them and try again',
        409,
        { permissions: definition.permissions }
      )
    }

    const sourceKey = await this.webPanelPermissionSourceKey(
      worktreeId,
      definition
    )
    if (granted && definition.permissions.length > 0) {
      const timestamp = now()
      await this.deps.database.db
        .insert(webPanelPermissionGrants)
        .values({
          sourceKey,
          definitionId,
          permissionsJson: JSON.stringify([...definition.permissions].sort()),
          grantedAt: timestamp,
          updatedAt: timestamp
        })
        .onConflictDoUpdate({
          target: webPanelPermissionGrants.sourceKey,
          set: {
            permissionsJson: JSON.stringify([...definition.permissions].sort()),
            updatedAt: timestamp
          }
        })
    } else {
      await this.deps.database.db
        .delete(webPanelPermissionGrants)
        .where(eq(webPanelPermissionGrants.sourceKey, sourceKey))
    }

    const affectedPanels = await this.deps.database.db
      .select({ id: webPanels.id })
      .from(webPanels)
      .where(
        and(
          eq(webPanels.worktreeId, worktreeId),
          eq(webPanels.definitionId, definitionId)
        )
      )
    this.invalidateProjectsSnapshot()
    for (const panel of affectedPanels) {
      this.events.publish('panel.updated', {
        worktreeId,
        panelId: panel.id
      })
    }

    return {
      id: definition.id,
      title: definition.title,
      icon: definition.icon,
      source: definition.source,
      permissions: definition.permissions,
      permissionsGranted: definition.permissions.length === 0 ? true : granted,
      sandbox: definition.sandbox
    }
  }

  async requireWebPanelPermissions(
    worktreeId: string,
    definition: WebPanelDefinition
  ): Promise<void> {
    if (await this.webPanelPermissionsGranted(worktreeId, definition)) {
      return
    }

    throw new DomainError(
      'WEB_PANEL_PERMISSION_REQUIRED',
      `Permission is required before ${definition.title} can open`,
      403,
      {
        definitionId: definition.id,
        permissions: definition.permissions
      }
    )
  }

  async normalizeWebPanelLaunch(
    worktree: WorktreeRecord,
    launch: WebPanelLaunch
  ): Promise<{ launch: WebPanelLaunch; inputJson: string }> {
    const inputJson = JSON.stringify(launch.input)
    if (Buffer.byteLength(inputJson) > WEB_PANEL_INPUT_MAX_BYTES) {
      throw new DomainError(
        'WEB_PANEL_INPUT_TOO_LARGE',
        'Web panel input is limited to 64 KiB',
        413
      )
    }

    if (launch.cwd === null) {
      return { launch: { input: launch.input, cwd: null }, inputJson }
    }

    const [worktreeRoot, requestedCwd] = await Promise.all([
      fs.realpath(worktree.path),
      fs.realpath(path.resolve(worktree.path, launch.cwd)).catch(() => null)
    ])
    if (!requestedCwd || !(await fs.stat(requestedCwd)).isDirectory()) {
      throw new DomainError(
        'INVALID_WEB_PANEL_LAUNCH_CWD',
        'Web panel launch directory does not exist',
        400
      )
    }

    const relativeCwd = path.relative(worktreeRoot, requestedCwd)
    if (
      relativeCwd === '..' ||
      relativeCwd.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeCwd)
    ) {
      throw new DomainError(
        'INVALID_WEB_PANEL_LAUNCH_CWD',
        'Web panel launch directory must be inside the tree',
        400
      )
    }

    return {
      launch: { input: launch.input, cwd: relativeCwd || '.' },
      inputJson
    }
  }
}
