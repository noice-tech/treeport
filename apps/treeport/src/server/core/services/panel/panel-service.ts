import crypto from 'node:crypto'
import { browserUrlSchema, webPanelInputSchema } from '@treeport/shared'
import type {
  BrowserPanel,
  JsonValue,
  OpenBrowserPanelResult,
  OpenWebPanelResult,
  ProjectRecord,
  TerminalRecord,
  WebPanel,
  WebPanelContext,
  WebPanelDefinition,
  WebPanelLaunch,
  WebPanelPermission,
  WorktreeListenerDiscovery,
  WorktreeRecord
} from '@treeport/shared'
import { and, asc, desc, eq, ne } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import type { TreeportDatabase } from '../../database'
import {
  browserPanels,
  webPanels,
  webPanelStorage
} from '../../database-schema'
import { DomainError } from '../../domain'
import type { ProductEventBus } from '../../events'
import type { GitAdapter } from '../../git'
import type { NetworkListenerAdapter } from '../../network-listeners'
import type { PackageSystem } from '../../package-system'
import type { TerminalSessionBackend } from '../../terminal'
import type {
  ResolvedWebPanelSource,
  WebPanelAssetResolution,
  WebPanelViteRuntime
} from '../../web-panel-vite-runtime'
import { PanelDefinitionService } from './panel-definition-service'

const now = (): string => new Date().toISOString()
const id = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
const WEB_PANEL_STORAGE_MAX_ENTRIES = 256
const WEB_PANEL_STORAGE_MAX_TOTAL_BYTES = 1024 * 1024
const WEB_PANEL_STORAGE_MAX_VALUE_BYTES = 64 * 1024

export interface PanelServiceDependencies {
  readonly config: AppConfig
  readonly database: TreeportDatabase
  readonly git: GitAdapter
  readonly terminalHost: TerminalSessionBackend
  readonly events: ProductEventBus
  readonly packages: PackageSystem
  readonly networkListeners: NetworkListenerAdapter
  readonly webPanelRuntime: WebPanelViteRuntime
  readonly requireAvailableWorktree: (
    worktreeId: string,
    allowPrunable?: boolean
  ) => Promise<WorktreeRecord>
  readonly getProject: (projectId: string) => Promise<ProjectRecord>
  readonly getWorktree: (worktreeId: string) => Promise<WorktreeRecord>
  readonly getTerminalFromBindings: (
    terminalId: string
  ) => Promise<TerminalRecord>
  readonly invalidateProjectsSnapshot: () => void
}

export class PanelService {
  private readonly definitions: PanelDefinitionService

  constructor(private readonly host: PanelServiceDependencies) {
    this.definitions = new PanelDefinitionService({
      ...host,
      getWorktree: (worktreeId) => this.getWorktree(worktreeId),
      invalidateProjectsSnapshot: () => this.invalidateProjectsSnapshot()
    })
  }

  private get deps() {
    return this.host
  }

  private get events() {
    return this.host.events
  }

  private get packages() {
    return this.host.packages
  }

  private get networkListeners() {
    return this.host.networkListeners
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

  private getTerminalFromBindings(terminalId: string) {
    return this.host.getTerminalFromBindings(terminalId)
  }

  private invalidateProjectsSnapshot() {
    this.host.invalidateProjectsSnapshot()
  }

  async effectiveWebPanelDefinitions(
    worktreeId: string
  ): Promise<Array<WebPanelDefinition & ResolvedWebPanelSource>> {
    return this.definitions.effectiveWebPanelDefinitions(worktreeId)
  }

  async webPanelPermissionSourceKey(
    worktreeId: string,
    definition: WebPanelDefinition
  ): Promise<string> {
    return this.definitions.webPanelPermissionSourceKey(worktreeId, definition)
  }

  private webPanelPermissionsGranted(
    worktreeId: string,
    definition: WebPanelDefinition
  ): Promise<boolean> {
    return this.definitions.webPanelPermissionsGranted(worktreeId, definition)
  }

  listWebPanelDefinitions(worktreeId: string): Promise<WebPanelDefinition[]> {
    return this.definitions.listWebPanelDefinitions(worktreeId)
  }

  setWebPanelPermissionGrant(
    worktreeId: string,
    definitionId: string,
    granted: boolean,
    expectedPermissions: WebPanelPermission[]
  ): Promise<WebPanelDefinition> {
    return this.definitions.setWebPanelPermissionGrant(
      worktreeId,
      definitionId,
      granted,
      expectedPermissions
    )
  }

  private requireWebPanelPermissions(
    worktreeId: string,
    definition: WebPanelDefinition
  ): Promise<void> {
    return this.definitions.requireWebPanelPermissions(worktreeId, definition)
  }

  private normalizeWebPanelLaunch(
    worktree: WorktreeRecord,
    launch: WebPanelLaunch
  ) {
    return this.definitions.normalizeWebPanelLaunch(worktree, launch)
  }

  async createBrowserPanel(
    worktreeId: string,
    requestedUrl?: string
  ): Promise<BrowserPanel> {
    await this.requireAvailableWorktree(worktreeId)
    const parsedUrl = requestedUrl
      ? browserUrlSchema.safeParse(requestedUrl)
      : null
    if (parsedUrl && !parsedUrl.success) {
      throw new DomainError(
        'INVALID_BROWSER_URL',
        'Enter an absolute HTTP or HTTPS URL without credentials',
        400
      )
    }

    const url = parsedUrl ? new URL(parsedUrl.data).href : 'about:blank'
    const timestamp = now()
    const panel: BrowserPanel = {
      id: id('panel'),
      kind: 'browser',
      worktreeId,
      title: url === 'about:blank' ? 'Browser' : new URL(url).host,
      url,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    await this.deps.database.db.insert(browserPanels).values({
      id: panel.id,
      worktreeId: panel.worktreeId,
      title: panel.title,
      url: panel.url,
      createdAt: panel.createdAt,
      updatedAt: panel.updatedAt
    })
    this.invalidateProjectsSnapshot()
    this.events.publish('panel.created', { worktreeId, panelId: panel.id })
    return panel
  }

  async openBrowserPanel(
    worktreeId: string | null,
    requestedUrl?: string,
    sourceTerminalId: string | null = null,
    sourcePanelId: string | null = null
  ): Promise<OpenBrowserPanelResult> {
    if (sourceTerminalId) {
      const terminal = await this.getTerminalFromBindings(sourceTerminalId)
      if (worktreeId && terminal.worktreeId !== worktreeId) {
        throw new DomainError(
          'INVALID_PANEL_OPEN_SOURCE',
          'The source terminal does not belong to the target tree',
          400
        )
      }

      worktreeId ??= terminal.worktreeId
    }

    if (sourcePanelId) {
      const sourcePanel = await this.getBrowserPanel(sourcePanelId)
      if (worktreeId && sourcePanel.worktreeId !== worktreeId) {
        throw new DomainError(
          'INVALID_PANEL_OPEN_SOURCE',
          'The source Browser does not belong to the target tree',
          400
        )
      }

      worktreeId ??= sourcePanel.worktreeId
    }

    if (!worktreeId) {
      throw new DomainError(
        'INVALID_PANEL_OPEN_SOURCE',
        'A target tree or panel source is required',
        400
      )
    }

    const panel = await this.createBrowserPanel(worktreeId, requestedUrl)
    this.events.publish('panel.open_requested', {
      worktreeId,
      panelId: panel.id,
      panel,
      sourceTerminalId,
      sourcePanelId
    })
    return { panel }
  }

  async openBrowserPanelFromTerminal(
    terminalId: string,
    requestedUrl: string
  ): Promise<OpenBrowserPanelResult> {
    return this.openBrowserPanel(null, requestedUrl, terminalId, null)
  }

  async openBrowserPanelFromPanel(
    panelId: string,
    requestedUrl: string
  ): Promise<OpenBrowserPanelResult> {
    return this.openBrowserPanel(null, requestedUrl, null, panelId)
  }

  async getBrowserPanel(panelId: string): Promise<BrowserPanel> {
    const [row] = await this.deps.database.db
      .select()
      .from(browserPanels)
      .where(eq(browserPanels.id, panelId))
      .limit(1)
    if (!row) {
      throw new DomainError('PANEL_NOT_FOUND', 'Browser not found', 404)
    }

    await this.requireAvailableWorktree(row.worktreeId)
    return mapBrowserPanel(row)
  }

  async authorizeBrowserPanel(panelId: string): Promise<{
    panel: BrowserPanel
    worktreePath: string
  }> {
    const panel = await this.getBrowserPanel(panelId)
    const worktree = await this.getWorktree(panel.worktreeId)
    return { panel, worktreePath: worktree.path }
  }

  async updateBrowserPanelState(
    panelId: string,
    state: { url: string; title: string }
  ): Promise<BrowserPanel> {
    const panel = await this.getBrowserPanel(panelId)
    const parsedUrl =
      state.url === 'about:blank'
        ? { success: true as const, data: 'about:blank' }
        : browserUrlSchema.safeParse(state.url)
    if (!parsedUrl.success) {
      throw new DomainError(
        'INVALID_BROWSER_URL',
        'The hosted browser reported an unsupported URL',
        400
      )
    }

    const url =
      parsedUrl.data === 'about:blank'
        ? parsedUrl.data
        : new URL(parsedUrl.data).href
    const requestedTitle = state.title.trim().slice(0, 256)
    const title =
      requestedTitle ||
      (url === 'about:blank' ? 'Browser' : new URL(url).host || 'Browser')
    if (panel.url === url && panel.title === title) {
      return panel
    }

    const observedAt = now()
    const updatedAt =
      observedAt > panel.updatedAt
        ? observedAt
        : new Date(Date.parse(panel.updatedAt) + 1).toISOString()
    await this.deps.database.db
      .update(browserPanels)
      .set({ url, title, updatedAt })
      .where(eq(browserPanels.id, panelId))
    const updated = { ...panel, url, title, updatedAt }
    this.invalidateProjectsSnapshot()
    this.events.publish('panel.updated', {
      worktreeId: panel.worktreeId,
      panelId
    })
    return updated
  }

  async deleteBrowserPanel(panelId: string): Promise<void> {
    const [row] = await this.deps.database.db
      .select()
      .from(browserPanels)
      .where(eq(browserPanels.id, panelId))
      .limit(1)
    if (!row) {
      throw new DomainError('PANEL_NOT_FOUND', 'Browser not found', 404)
    }

    await this.deps.database.db
      .delete(browserPanels)
      .where(eq(browserPanels.id, panelId))
    this.invalidateProjectsSnapshot()
    this.events.publish('panel.removed', {
      worktreeId: row.worktreeId,
      panelId
    })
  }

  async deletePanel(panelId: string, discardStoredData = false): Promise<void> {
    const [browserPanel] = await this.deps.database.db
      .select({ id: browserPanels.id })
      .from(browserPanels)
      .where(eq(browserPanels.id, panelId))
      .limit(1)
    if (browserPanel) {
      return this.deleteBrowserPanel(panelId)
    }

    return this.deleteWebPanel(panelId, discardStoredData)
  }

  async createWebPanel(
    worktreeId: string,
    definitionId: string,
    launch: WebPanelLaunch = { input: null, cwd: null }
  ): Promise<WebPanel> {
    const worktree = await this.requireAvailableWorktree(worktreeId)
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

    await this.requireWebPanelPermissions(worktreeId, definition)
    const normalized = await this.normalizeWebPanelLaunch(worktree, launch)
    const timestamp = now()
    const panel: WebPanel = {
      id: id('panel'),
      kind: 'web',
      worktreeId,
      definitionId,
      title: definition.title,
      launch: normalized.launch,
      permissions: definition.permissions,
      sandbox: definition.sandbox,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    await this.deps.database.db.insert(webPanels).values({
      id: panel.id,
      worktreeId: panel.worktreeId,
      definitionId: panel.definitionId,
      title: panel.title,
      inputJson: normalized.inputJson,
      launchCwd: panel.launch.cwd,
      createdAt: panel.createdAt,
      updatedAt: panel.updatedAt
    })
    this.invalidateProjectsSnapshot()
    this.events.publish('panel.created', { worktreeId, panelId: panel.id })
    return panel
  }

  async openWebPanel(
    worktreeId: string,
    definitionId: string,
    launch: WebPanelLaunch = { input: null, cwd: null },
    newInstance = false,
    sourceTerminalId: string | null = null
  ): Promise<OpenWebPanelResult> {
    const worktree = await this.requireAvailableWorktree(worktreeId)
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

    await this.requireWebPanelPermissions(worktreeId, definition)
    const finish = (result: OpenWebPanelResult): OpenWebPanelResult => {
      this.events.publish('panel.open_requested', {
        worktreeId,
        panelId: result.panel.id,
        panel: result.panel,
        sourceTerminalId,
        sourcePanelId: null
      })
      return result
    }

    if (newInstance) {
      return finish({
        panel: await this.createWebPanel(worktreeId, definitionId, launch),
        created: true,
        reused: false
      })
    }

    const [existing] = await this.deps.database.db
      .select()
      .from(webPanels)
      .where(
        and(
          eq(webPanels.worktreeId, worktreeId),
          eq(webPanels.definitionId, definitionId)
        )
      )
      .orderBy(desc(webPanels.createdAt), desc(webPanels.id))
      .limit(1)
    if (!existing) {
      return finish({
        panel: await this.createWebPanel(worktreeId, definitionId, launch),
        created: true,
        reused: false
      })
    }

    const normalized = await this.normalizeWebPanelLaunch(worktree, launch)
    const observedAt = now()
    const updatedAt =
      observedAt > existing.updatedAt
        ? observedAt
        : new Date(Date.parse(existing.updatedAt) + 1).toISOString()
    await this.deps.database.db
      .update(webPanels)
      .set({
        title: definition.title,
        inputJson: normalized.inputJson,
        launchCwd: normalized.launch.cwd,
        updatedAt
      })
      .where(eq(webPanels.id, existing.id))
    const panel = mapWebPanel(
      {
        ...existing,
        title: definition.title,
        inputJson: normalized.inputJson,
        launchCwd: normalized.launch.cwd,
        updatedAt
      },
      definition.permissions,
      true
    )
    this.invalidateProjectsSnapshot()
    this.events.publish('panel.updated', { worktreeId, panelId: panel.id })
    return finish({ panel, created: false, reused: true })
  }

  async deleteWebPanel(
    panelId: string,
    discardStoredData = false
  ): Promise<void> {
    const [panel] = await this.deps.database.db
      .select()
      .from(webPanels)
      .where(eq(webPanels.id, panelId))
      .limit(1)
    if (!panel) {
      throw new DomainError('PANEL_NOT_FOUND', 'Panel not found', 404)
    }

    await this.requireAvailableWorktree(panel.worktreeId)
    const [storedValue] = await this.deps.database.db
      .select({ key: webPanelStorage.key })
      .from(webPanelStorage)
      .where(eq(webPanelStorage.panelId, panelId))
      .limit(1)
    if (!discardStoredData && storedValue) {
      throw new DomainError(
        'PANEL_HAS_STORED_DATA',
        'Closing this panel requires confirmation because its saved data will be deleted',
        409
      )
    }

    await this.deps.database.db
      .delete(webPanels)
      .where(eq(webPanels.id, panelId))
    this.invalidateProjectsSnapshot()
    this.events.publish('panel.removed', {
      worktreeId: panel.worktreeId,
      panelId
    })
  }

  async requireWebPanelTreeFiles(panelId: string) {
    const [panel] = await this.deps.database.db
      .select()
      .from(webPanels)
      .where(eq(webPanels.id, panelId))
      .limit(1)
    if (!panel) {
      throw new DomainError('PANEL_NOT_FOUND', 'Panel not found', 404)
    }

    const definition = (
      await this.effectiveWebPanelDefinitions(panel.worktreeId)
    ).find((candidate) => candidate.id === panel.definitionId)
    if (!definition) {
      throw new DomainError(
        'WEB_PANEL_DEFINITION_NOT_FOUND',
        'The definition for this panel is unavailable',
        404
      )
    }

    await this.requireWebPanelPermissions(panel.worktreeId, definition)
    if (!definition.permissions.includes('tree-files')) {
      throw new DomainError(
        'WEB_PANEL_TREE_FILES_REQUIRED',
        'This panel does not have permission to access tree files',
        403
      )
    }

    const worktree = await this.requireAvailableWorktree(panel.worktreeId)
    const project = await this.getProject(worktree.projectId)
    return { project, worktree }
  }

  async getWebPanelContext(panelId: string): Promise<WebPanelContext> {
    const [panelRow] = await this.deps.database.db
      .select()
      .from(webPanels)
      .where(eq(webPanels.id, panelId))
      .limit(1)
    if (!panelRow) {
      throw new DomainError('PANEL_NOT_FOUND', 'Panel not found', 404)
    }

    const definition = (
      await this.effectiveWebPanelDefinitions(panelRow.worktreeId)
    ).find((candidate) => candidate.id === panelRow.definitionId)
    const permissionsGranted = definition
      ? await this.webPanelPermissionsGranted(panelRow.worktreeId, definition)
      : false
    const panel = mapWebPanel(
      panelRow,
      definition?.permissions ?? [],
      permissionsGranted
    )
    const worktree = await this.getWorktree(panel.worktreeId)
    const project = await this.getProject(worktree.projectId)
    return {
      apiVersion: 1,
      panel,
      launch: panel.launch,
      project: {
        id: project.id,
        name: project.name,
        kind: project.kind,
        defaultBranch:
          project.kind === 'repository' ? project.defaultBranch : null
      },
      worktree: {
        id: worktree.id,
        name: worktree.name,
        kind: worktree.kind,
        branch: worktree.branch,
        head: worktree.kind === 'folder' ? null : worktree.head
      }
    }
  }

  async getWebPanelDiff(panelId: string) {
    const context = await this.getWebPanelContext(panelId)
    if (
      context.project.kind !== 'repository' ||
      !context.project.defaultBranch
    ) {
      throw new DomainError(
        'GIT_NOT_AVAILABLE',
        'Git diff is not available for a folder project',
        409
      )
    }

    const worktree = await this.getWorktree(context.panel.worktreeId)
    return this.deps.git.worktreeDiff(
      worktree.path,
      context.project.defaultBranch
    )
  }

  async getBrowserPanelListeners(
    panelId: string
  ): Promise<WorktreeListenerDiscovery> {
    const panel = await this.getBrowserPanel(panelId)
    const worktree = await this.getWorktree(panel.worktreeId)
    const terminalProcesses = await this.deps.terminalHost.listProcesses(
      worktree.id
    )
    return this.networkListeners.listeners({
      worktreePath: worktree.path,
      terminalProcesses
    })
  }

  async getPanelListeners(panelId: string): Promise<WorktreeListenerDiscovery> {
    const [browserPanel] = await this.deps.database.db
      .select({ id: browserPanels.id })
      .from(browserPanels)
      .where(eq(browserPanels.id, panelId))
      .limit(1)
    return browserPanel
      ? this.getBrowserPanelListeners(panelId)
      : this.getWebPanelListeners(panelId)
  }

  async getWebPanelListeners(
    panelId: string
  ): Promise<WorktreeListenerDiscovery> {
    const context = await this.getWebPanelContext(panelId)
    const worktree = await this.getWorktree(context.panel.worktreeId)
    const terminalProcesses = await this.deps.terminalHost.listProcesses(
      worktree.id
    )
    return this.networkListeners.listeners({
      worktreePath: worktree.path,
      terminalProcesses
    })
  }

  async hasWebPanelStorage(panelId: string): Promise<boolean> {
    await this.getWebPanelContext(panelId)
    const [row] = await this.deps.database.db
      .select({ key: webPanelStorage.key })
      .from(webPanelStorage)
      .where(eq(webPanelStorage.panelId, panelId))
      .limit(1)
    return row !== undefined
  }

  async getWebPanelStorage(
    panelId: string,
    key: string
  ): Promise<JsonValue | undefined> {
    await this.getWebPanelContext(panelId)
    const [row] = await this.deps.database.db
      .select({ valueJson: webPanelStorage.valueJson })
      .from(webPanelStorage)
      .where(
        and(eq(webPanelStorage.panelId, panelId), eq(webPanelStorage.key, key))
      )
      .limit(1)
    // SAFETY: The surrounding boundary contract establishes this asserted value.
    return row ? (JSON.parse(row.valueJson) as JsonValue) : undefined
  }

  async setWebPanelStorage(
    panelId: string,
    key: string,
    value: JsonValue
  ): Promise<void> {
    await this.getWebPanelContext(panelId)
    const valueJson = JSON.stringify(value)
    const valueBytes = Buffer.byteLength(valueJson)
    if (valueBytes > WEB_PANEL_STORAGE_MAX_VALUE_BYTES) {
      throw new DomainError(
        'WEB_PANEL_STORAGE_VALUE_TOO_LARGE',
        'Web panel storage values are limited to 64 KiB',
        413
      )
    }

    const storedValues = await this.deps.database.db
      .select({ valueJson: webPanelStorage.valueJson })
      .from(webPanelStorage)
      .where(
        and(eq(webPanelStorage.panelId, panelId), ne(webPanelStorage.key, key))
      )
    const storedBytes = storedValues.reduce(
      (total, row) => total + Buffer.byteLength(row.valueJson),
      0
    )
    if (
      storedValues.length >= WEB_PANEL_STORAGE_MAX_ENTRIES ||
      storedBytes + valueBytes > WEB_PANEL_STORAGE_MAX_TOTAL_BYTES
    ) {
      throw new DomainError(
        'WEB_PANEL_STORAGE_QUOTA_EXCEEDED',
        'Web panel storage is limited to 256 values and 1 MiB per panel',
        413
      )
    }

    const updatedAt = now()
    await this.deps.database.db
      .insert(webPanelStorage)
      .values({ panelId, key, valueJson, updatedAt })
      .onConflictDoUpdate({
        target: [webPanelStorage.panelId, webPanelStorage.key],
        set: { valueJson, updatedAt }
      })
  }

  async deleteWebPanelStorage(panelId: string, key: string): Promise<void> {
    await this.getWebPanelContext(panelId)
    await this.deps.database.db
      .delete(webPanelStorage)
      .where(
        and(eq(webPanelStorage.panelId, panelId), eq(webPanelStorage.key, key))
      )
  }

  async resolveWebPanelAsset(
    panelId: string,
    requestedPath: string
  ): Promise<WebPanelAssetResolution> {
    const [panel] = await this.deps.database.db
      .select()
      .from(webPanels)
      .where(eq(webPanels.id, panelId))
      .limit(1)
    if (!panel) {
      throw new DomainError('PANEL_NOT_FOUND', 'Panel not found', 404)
    }

    const definition = (
      await this.effectiveWebPanelDefinitions(panel.worktreeId)
    ).find((candidate) => candidate.id === panel.definitionId)
    if (!definition) {
      throw new DomainError(
        'WEB_PANEL_DEFINITION_NOT_FOUND',
        'The definition for this panel is unavailable',
        404
      )
    }

    await this.requireWebPanelPermissions(panel.worktreeId, definition)
    const encodedPanelId = encodeURIComponent(panelId)
    return this.webPanelRuntime.resolve(
      definition,
      requestedPath,
      `/api/web-panels/${encodedPanelId}/assets/`
    )
  }

  async listBrowserPanels(): Promise<BrowserPanel[]> {
    return this.deps.database.db
      .select()
      .from(browserPanels)
      .orderBy(asc(browserPanels.createdAt), asc(browserPanels.id))
      .then((rows) => rows.map(mapBrowserPanel))
  }

  async listWebPanels(): Promise<WebPanel[]> {
    const rows = await this.deps.database.db
      .select()
      .from(webPanels)
      .orderBy(asc(webPanels.createdAt), asc(webPanels.id))
    return Promise.all(
      rows.map(async (row) => {
        const definition = (
          await this.effectiveWebPanelDefinitions(row.worktreeId).catch(
            () => []
          )
        ).find((candidate) => candidate.id === row.definitionId)
        return mapWebPanel(
          row,
          definition?.permissions ?? [],
          definition
            ? await this.webPanelPermissionsGranted(row.worktreeId, definition)
            : false
        )
      })
    )
  }
}

function mapBrowserPanel(row: typeof browserPanels.$inferSelect): BrowserPanel {
  return {
    id: row.id,
    kind: 'browser',
    worktreeId: row.worktreeId,
    title: row.title,
    url: row.url,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function mapWebPanel(
  row: typeof webPanels.$inferSelect,
  permissions: WebPanelPermission[] = [],
  permissionsGranted = permissions.length === 0
): WebPanel {
  const parsedInput = webPanelInputSchema
    .nullable()
    .safeParse(JSON.parse(row.inputJson))
  if (!parsedInput.success) {
    throw new Error(`Web panel ${row.id} has invalid stored launch input`)
  }

  return {
    id: row.id,
    kind: 'web',
    worktreeId: row.worktreeId,
    definitionId: row.definitionId,
    title: row.title,
    launch: {
      input: parsedInput.data,
      cwd: row.launchCwd
    },
    permissions,
    sandbox: {
      allowSameOrigin: permissionsGranted && permissions.includes('same-origin')
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}
