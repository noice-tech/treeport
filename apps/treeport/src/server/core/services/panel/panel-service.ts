import crypto from 'node:crypto'
import { browserUrlSchema, webPanelInputSchema } from '@treeport/shared'
import type {
  BrowserPanel,
  JsonValue,
  OpenBrowserPanelResult,
  OpenWebPanelResult,
  ProjectRecord,
  WebPanel,
  WebPanelContext,
  WebPanelDefinition,
  WebPanelLaunch,
  WebPanelPermission,
  WorktreeListenerDiscovery,
  WorktreeRecord
} from '@treeport/shared'
import { and, asc, desc, eq, ne } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import {
  browserPanels,
  webPanels,
  webPanelStorage
} from '../../database-schema'
import { DomainError } from '../../domain'
import type {
  ResolvedWebPanelSource,
  WebPanelAssetResolution
} from '../../web-panel-vite-runtime'
import {
  ProjectObservationOperations,
  ProjectSnapshotOperations,
  TerminalOperations
} from '../domain-services'
import type { ApplicationServices } from '../infrastructure/application-runtime'
import {
  DatabasePort,
  EventBusPort,
  GitPort,
  NetworkListenerPort,
  TerminalHostPort,
  WebPanelRuntimePort
} from '../infrastructure/ports'
import { ProjectStore } from '../project/project-store'
import { PanelDefinitionService } from './panel-definition-service'

const now = (): string => new Date().toISOString()
const id = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
const WEB_PANEL_STORAGE_MAX_ENTRIES = 256
const WEB_PANEL_STORAGE_MAX_TOTAL_BYTES = 1024 * 1024
const WEB_PANEL_STORAGE_MAX_VALUE_BYTES = 64 * 1024

type PanelEffect<A> = Effect.Effect<
  A,
  DomainError<unknown>,
  ApplicationServices
>

export class PanelService {
  private readonly definitions = new PanelDefinitionService()

  private requireAvailableWorktree(
    worktreeId: string,
    allowPrunable = false
  ): PanelEffect<WorktreeRecord> {
    return Effect.flatMap(ProjectObservationOperations, (observations) =>
      observations.requireAvailableWorktree(worktreeId, allowPrunable)
    )
  }

  private getProject(projectId: string): PanelEffect<ProjectRecord> {
    return Effect.flatMap(ProjectStore, (store) => store.getProject(projectId))
  }

  private getWorktree(worktreeId: string): PanelEffect<WorktreeRecord> {
    return Effect.flatMap(ProjectStore, (store) =>
      store.getWorktree(worktreeId)
    )
  }

  private invalidateProjectsSnapshot() {
    return Effect.flatMap(ProjectSnapshotOperations, (snapshots) =>
      Effect.sync(() => snapshots.invalidate())
    )
  }

  effectiveWebPanelDefinitions(
    worktreeId: string
  ): PanelEffect<Array<WebPanelDefinition & ResolvedWebPanelSource>> {
    return this.definitions.effectiveWebPanelDefinitions(worktreeId)
  }

  webPanelPermissionSourceKey(
    worktreeId: string,
    definition: WebPanelDefinition
  ): PanelEffect<string> {
    return this.definitions.webPanelPermissionSourceKey(worktreeId, definition)
  }

  private webPanelPermissionsGranted(
    worktreeId: string,
    definition: WebPanelDefinition
  ): PanelEffect<boolean> {
    return this.definitions.webPanelPermissionsGranted(worktreeId, definition)
  }

  listWebPanelDefinitions(
    worktreeId: string
  ): PanelEffect<WebPanelDefinition[]> {
    return this.definitions.listWebPanelDefinitions(worktreeId)
  }

  setWebPanelPermissionGrant(
    worktreeId: string,
    definitionId: string,
    granted: boolean,
    expectedPermissions: WebPanelPermission[]
  ): PanelEffect<WebPanelDefinition> {
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
  ): PanelEffect<void> {
    return this.definitions.requireWebPanelPermissions(worktreeId, definition)
  }

  private normalizeWebPanelLaunch(
    worktree: WorktreeRecord,
    launch: WebPanelLaunch
  ): Effect.Effect<
    { launch: WebPanelLaunch; inputJson: string },
    DomainError<unknown>
  > {
    return this.definitions.normalizeWebPanelLaunch(worktree, launch)
  }

  createBrowserPanel(
    worktreeId: string,
    requestedUrl?: string
  ): PanelEffect<BrowserPanel> {
    const requireAvailableWorktree = this.requireAvailableWorktree.bind(this)
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      yield* requireAvailableWorktree(worktreeId)
      const parsedUrl = requestedUrl
        ? browserUrlSchema.safeParse(requestedUrl)
        : null
      if (parsedUrl && !parsedUrl.success) {
        return yield* Effect.fail(
          new DomainError(
            'INVALID_BROWSER_URL',
            'Enter an absolute HTTP or HTTPS URL without credentials',
            400
          )
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
      yield* Effect.promise(() =>
        database.db.insert(browserPanels).values({
          id: panel.id,
          worktreeId: panel.worktreeId,
          title: panel.title,
          url: panel.url,
          createdAt: panel.createdAt,
          updatedAt: panel.updatedAt
        })
      )
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('panel.created', { worktreeId, panelId: panel.id })
      })
      return panel
    })
  }

  openBrowserPanel(
    worktreeId: string | null,
    requestedUrl?: string,
    sourceTerminalId: string | null = null,
    sourcePanelId: string | null = null,
    reuseExistingUrl = false
  ): PanelEffect<OpenBrowserPanelResult> {
    const getBrowserPanel = this.getBrowserPanel.bind(this)
    const createBrowserPanel = this.createBrowserPanel.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const terminals = yield* TerminalOperations
      let targetWorktreeId = worktreeId
      if (sourceTerminalId) {
        const terminal =
          yield* terminals.getTerminalFromBindings(sourceTerminalId)
        if (targetWorktreeId && terminal.worktreeId !== targetWorktreeId) {
          return yield* Effect.fail(
            new DomainError(
              'INVALID_PANEL_OPEN_SOURCE',
              'The source terminal does not belong to the target tree',
              400
            )
          )
        }

        targetWorktreeId ??= terminal.worktreeId
      }

      if (sourcePanelId) {
        const sourcePanel = yield* getBrowserPanel(sourcePanelId)
        if (targetWorktreeId && sourcePanel.worktreeId !== targetWorktreeId) {
          return yield* Effect.fail(
            new DomainError(
              'INVALID_PANEL_OPEN_SOURCE',
              'The source Browser does not belong to the target tree',
              400
            )
          )
        }

        targetWorktreeId ??= sourcePanel.worktreeId
      }

      if (!targetWorktreeId) {
        return yield* Effect.fail(
          new DomainError(
            'INVALID_PANEL_OPEN_SOURCE',
            'A target tree or panel source is required',
            400
          )
        )
      }

      let existingPanel: BrowserPanel | null = null
      if (reuseExistingUrl && requestedUrl) {
        const parsedUrl = browserUrlSchema.safeParse(requestedUrl)
        if (!parsedUrl.success) {
          return yield* Effect.fail(
            new DomainError(
              'INVALID_BROWSER_URL',
              'Enter an absolute HTTP or HTTPS URL without credentials',
              400
            )
          )
        }

        const url = new URL(parsedUrl.data).href
        const [existing] = yield* Effect.promise(() =>
          database.db
            .select()
            .from(browserPanels)
            .where(
              and(
                eq(browserPanels.worktreeId, targetWorktreeId),
                eq(browserPanels.url, url)
              )
            )
            .orderBy(desc(browserPanels.createdAt), desc(browserPanels.id))
            .limit(1)
        )
        existingPanel = existing ? mapBrowserPanel(existing) : null
      }

      const panel =
        existingPanel ??
        (yield* createBrowserPanel(targetWorktreeId, requestedUrl))
      yield* Effect.sync(() =>
        events.publish('panel.open_requested', {
          worktreeId: targetWorktreeId,
          panelId: panel.id,
          panel,
          sourceTerminalId,
          sourcePanelId
        })
      )
      return { panel }
    })
  }

  openBrowserPanelFromTerminal(
    terminalId: string,
    requestedUrl: string
  ): PanelEffect<OpenBrowserPanelResult> {
    return this.openBrowserPanel(null, requestedUrl, terminalId, null, true)
  }

  openBrowserPanelFromPanel(
    panelId: string,
    requestedUrl: string
  ): PanelEffect<OpenBrowserPanelResult> {
    return this.openBrowserPanel(null, requestedUrl, null, panelId)
  }

  getBrowserPanel(panelId: string): PanelEffect<BrowserPanel> {
    const requireAvailableWorktree = this.requireAvailableWorktree.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const [row] = yield* Effect.promise(() =>
        database.db
          .select()
          .from(browserPanels)
          .where(eq(browserPanels.id, panelId))
          .limit(1)
      )
      if (!row) {
        return yield* Effect.fail(
          new DomainError('PANEL_NOT_FOUND', 'Browser not found', 404)
        )
      }

      yield* requireAvailableWorktree(row.worktreeId)
      return mapBrowserPanel(row)
    })
  }

  authorizeBrowserPanel(
    panelId: string
  ): PanelEffect<{ panel: BrowserPanel; worktreePath: string }> {
    const getBrowserPanel = this.getBrowserPanel.bind(this)
    const getWorktree = this.getWorktree.bind(this)

    return Effect.gen(function* () {
      const panel = yield* getBrowserPanel(panelId)
      const worktree = yield* getWorktree(panel.worktreeId)
      return { panel, worktreePath: worktree.path }
    })
  }

  updateBrowserPanelState(
    panelId: string,
    state: { url: string; title: string }
  ): PanelEffect<BrowserPanel> {
    const getBrowserPanel = this.getBrowserPanel.bind(this)
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const panel = yield* getBrowserPanel(panelId)
      const parsedUrl =
        state.url === 'about:blank'
          ? { success: true as const, data: 'about:blank' }
          : browserUrlSchema.safeParse(state.url)
      if (!parsedUrl.success) {
        return yield* Effect.fail(
          new DomainError(
            'INVALID_BROWSER_URL',
            'The hosted browser reported an unsupported URL',
            400
          )
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
      yield* Effect.promise(() =>
        database.db
          .update(browserPanels)
          .set({ url, title, updatedAt })
          .where(eq(browserPanels.id, panelId))
      )
      const updated = { ...panel, url, title, updatedAt }
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('panel.updated', {
          worktreeId: panel.worktreeId,
          panelId
        })
      })
      return updated
    })
  }

  deleteBrowserPanel(panelId: string): PanelEffect<void> {
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const [row] = yield* Effect.promise(() =>
        database.db
          .select()
          .from(browserPanels)
          .where(eq(browserPanels.id, panelId))
          .limit(1)
      )
      if (!row) {
        return yield* Effect.fail(
          new DomainError('PANEL_NOT_FOUND', 'Browser not found', 404)
        )
      }

      yield* Effect.promise(() =>
        database.db.delete(browserPanels).where(eq(browserPanels.id, panelId))
      )
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('panel.removed', {
          worktreeId: row.worktreeId,
          panelId
        })
      })
    })
  }

  deletePanel(panelId: string, discardStoredData = false): PanelEffect<void> {
    const deleteBrowserPanel = this.deleteBrowserPanel.bind(this)
    const deleteWebPanel = this.deleteWebPanel.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const [browserPanel] = yield* Effect.promise(() =>
        database.db
          .select({ id: browserPanels.id })
          .from(browserPanels)
          .where(eq(browserPanels.id, panelId))
          .limit(1)
      )
      return yield* browserPanel
        ? deleteBrowserPanel(panelId)
        : deleteWebPanel(panelId, discardStoredData)
    })
  }

  createWebPanel(
    worktreeId: string,
    definitionId: string,
    launch: WebPanelLaunch = { input: null, cwd: null }
  ): PanelEffect<WebPanel> {
    const requireAvailableWorktree = this.requireAvailableWorktree.bind(this)
    const effectiveWebPanelDefinitions =
      this.effectiveWebPanelDefinitions.bind(this)
    const requireWebPanelPermissions =
      this.requireWebPanelPermissions.bind(this)
    const normalizeWebPanelLaunch = this.normalizeWebPanelLaunch.bind(this)
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const worktree = yield* requireAvailableWorktree(worktreeId)
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

      yield* requireWebPanelPermissions(worktreeId, definition)
      const normalized = yield* normalizeWebPanelLaunch(worktree, launch)
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
      yield* Effect.promise(() =>
        database.db.insert(webPanels).values({
          id: panel.id,
          worktreeId: panel.worktreeId,
          definitionId: panel.definitionId,
          title: panel.title,
          inputJson: normalized.inputJson,
          launchCwd: panel.launch.cwd,
          createdAt: panel.createdAt,
          updatedAt: panel.updatedAt
        })
      )
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('panel.created', { worktreeId, panelId: panel.id })
      })
      return panel
    })
  }

  openWebPanel(
    worktreeId: string,
    definitionId: string,
    launch: WebPanelLaunch = { input: null, cwd: null },
    newInstance = false,
    sourceTerminalId: string | null = null
  ): PanelEffect<OpenWebPanelResult> {
    const requireAvailableWorktree = this.requireAvailableWorktree.bind(this)
    const effectiveWebPanelDefinitions =
      this.effectiveWebPanelDefinitions.bind(this)
    const requireWebPanelPermissions =
      this.requireWebPanelPermissions.bind(this)
    const createWebPanel = this.createWebPanel.bind(this)
    const normalizeWebPanelLaunch = this.normalizeWebPanelLaunch.bind(this)
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const worktree = yield* requireAvailableWorktree(worktreeId)
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

      yield* requireWebPanelPermissions(worktreeId, definition)
      const finish = (result: OpenWebPanelResult): OpenWebPanelResult => {
        events.publish('panel.open_requested', {
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
          panel: yield* createWebPanel(worktreeId, definitionId, launch),
          created: true,
          reused: false
        })
      }

      const [existing] = yield* Effect.promise(() =>
        database.db
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
      )
      if (!existing) {
        return finish({
          panel: yield* createWebPanel(worktreeId, definitionId, launch),
          created: true,
          reused: false
        })
      }

      const normalized = yield* normalizeWebPanelLaunch(worktree, launch)
      const observedAt = now()
      const updatedAt =
        observedAt > existing.updatedAt
          ? observedAt
          : new Date(Date.parse(existing.updatedAt) + 1).toISOString()
      yield* Effect.promise(() =>
        database.db
          .update(webPanels)
          .set({
            title: definition.title,
            inputJson: normalized.inputJson,
            launchCwd: normalized.launch.cwd,
            updatedAt
          })
          .where(eq(webPanels.id, existing.id))
      )
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
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('panel.updated', { worktreeId, panelId: panel.id })
      })
      return finish({ panel, created: false, reused: true })
    })
  }

  deleteWebPanel(
    panelId: string,
    discardStoredData = false
  ): PanelEffect<void> {
    const requireAvailableWorktree = this.requireAvailableWorktree.bind(this)
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const [panel] = yield* Effect.promise(() =>
        database.db
          .select()
          .from(webPanels)
          .where(eq(webPanels.id, panelId))
          .limit(1)
      )
      if (!panel) {
        return yield* Effect.fail(
          new DomainError('PANEL_NOT_FOUND', 'Panel not found', 404)
        )
      }

      yield* requireAvailableWorktree(panel.worktreeId)
      const [storedValue] = yield* Effect.promise(() =>
        database.db
          .select({ key: webPanelStorage.key })
          .from(webPanelStorage)
          .where(eq(webPanelStorage.panelId, panelId))
          .limit(1)
      )
      if (!discardStoredData && storedValue) {
        return yield* Effect.fail(
          new DomainError(
            'PANEL_HAS_STORED_DATA',
            'Closing this panel requires confirmation because its saved data will be deleted',
            409
          )
        )
      }

      yield* Effect.promise(() =>
        database.db.delete(webPanels).where(eq(webPanels.id, panelId))
      )
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('panel.removed', {
          worktreeId: panel.worktreeId,
          panelId
        })
      })
    })
  }

  requireWebPanelTreeFiles(
    panelId: string
  ): PanelEffect<{ project: ProjectRecord; worktree: WorktreeRecord }> {
    const effectiveWebPanelDefinitions =
      this.effectiveWebPanelDefinitions.bind(this)
    const requireWebPanelPermissions =
      this.requireWebPanelPermissions.bind(this)
    const requireAvailableWorktree = this.requireAvailableWorktree.bind(this)
    const getProject = this.getProject.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const [panel] = yield* Effect.promise(() =>
        database.db
          .select()
          .from(webPanels)
          .where(eq(webPanels.id, panelId))
          .limit(1)
      )
      if (!panel) {
        return yield* Effect.fail(
          new DomainError('PANEL_NOT_FOUND', 'Panel not found', 404)
        )
      }

      const definition = (yield* effectiveWebPanelDefinitions(
        panel.worktreeId
      )).find((candidate) => candidate.id === panel.definitionId)
      if (!definition) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_PANEL_DEFINITION_NOT_FOUND',
            'The definition for this panel is unavailable',
            404
          )
        )
      }

      yield* requireWebPanelPermissions(panel.worktreeId, definition)
      if (!definition.permissions.includes('tree-files')) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_PANEL_TREE_FILES_REQUIRED',
            'This panel does not have permission to access tree files',
            403
          )
        )
      }

      const worktree = yield* requireAvailableWorktree(panel.worktreeId)
      const project = yield* getProject(worktree.projectId)
      return { project, worktree }
    })
  }

  getWebPanelContext(panelId: string): PanelEffect<WebPanelContext> {
    const effectiveWebPanelDefinitions =
      this.effectiveWebPanelDefinitions.bind(this)
    const webPanelPermissionsGranted =
      this.webPanelPermissionsGranted.bind(this)
    const getWorktree = this.getWorktree.bind(this)
    const getProject = this.getProject.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const [panelRow] = yield* Effect.promise(() =>
        database.db
          .select()
          .from(webPanels)
          .where(eq(webPanels.id, panelId))
          .limit(1)
      )
      if (!panelRow) {
        return yield* Effect.fail(
          new DomainError('PANEL_NOT_FOUND', 'Panel not found', 404)
        )
      }

      const definition = (yield* effectiveWebPanelDefinitions(
        panelRow.worktreeId
      )).find((candidate) => candidate.id === panelRow.definitionId)
      const permissionsGranted = definition
        ? yield* webPanelPermissionsGranted(panelRow.worktreeId, definition)
        : false
      const panel = mapWebPanel(
        panelRow,
        definition?.permissions ?? [],
        permissionsGranted
      )
      const worktree = yield* getWorktree(panel.worktreeId)
      const project = yield* getProject(worktree.projectId)
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
    })
  }

  getWebPanelDiff(panelId: string) {
    const getWebPanelContext = this.getWebPanelContext.bind(this)
    const getWorktree = this.getWorktree.bind(this)

    return Effect.gen(function* () {
      const git = yield* GitPort
      const context = yield* getWebPanelContext(panelId)
      if (
        context.project.kind !== 'repository' ||
        !context.project.defaultBranch
      ) {
        return yield* Effect.fail(
          new DomainError(
            'GIT_NOT_AVAILABLE',
            'Git diff is not available for a folder project',
            409
          )
        )
      }

      const worktree = yield* getWorktree(context.panel.worktreeId)
      return yield* Effect.promise(() =>
        git.worktreeDiff(worktree.path, context.project.defaultBranch!)
      )
    })
  }

  getBrowserPanelListeners(
    panelId: string
  ): PanelEffect<WorktreeListenerDiscovery> {
    const getBrowserPanel = this.getBrowserPanel.bind(this)
    const getWorktree = this.getWorktree.bind(this)

    return Effect.gen(function* () {
      const terminalHost = yield* TerminalHostPort
      const networkListeners = yield* NetworkListenerPort
      const panel = yield* getBrowserPanel(panelId)
      const worktree = yield* getWorktree(panel.worktreeId)
      const terminalProcesses = yield* Effect.promise(() =>
        terminalHost.listProcesses(worktree.id)
      )
      return yield* Effect.promise(() =>
        networkListeners.listeners({
          worktreePath: worktree.path,
          terminalProcesses
        })
      )
    })
  }

  getPanelListeners(panelId: string): PanelEffect<WorktreeListenerDiscovery> {
    const getBrowserPanelListeners = this.getBrowserPanelListeners.bind(this)
    const getWebPanelListeners = this.getWebPanelListeners.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const [browserPanel] = yield* Effect.promise(() =>
        database.db
          .select({ id: browserPanels.id })
          .from(browserPanels)
          .where(eq(browserPanels.id, panelId))
          .limit(1)
      )
      return yield* browserPanel
        ? getBrowserPanelListeners(panelId)
        : getWebPanelListeners(panelId)
    })
  }

  getWebPanelListeners(
    panelId: string
  ): PanelEffect<WorktreeListenerDiscovery> {
    const getWebPanelContext = this.getWebPanelContext.bind(this)
    const getWorktree = this.getWorktree.bind(this)

    return Effect.gen(function* () {
      const terminalHost = yield* TerminalHostPort
      const networkListeners = yield* NetworkListenerPort
      const context = yield* getWebPanelContext(panelId)
      const worktree = yield* getWorktree(context.panel.worktreeId)
      const terminalProcesses = yield* Effect.promise(() =>
        terminalHost.listProcesses(worktree.id)
      )
      return yield* Effect.promise(() =>
        networkListeners.listeners({
          worktreePath: worktree.path,
          terminalProcesses
        })
      )
    })
  }

  hasWebPanelStorage(panelId: string): PanelEffect<boolean> {
    const getWebPanelContext = this.getWebPanelContext.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      yield* getWebPanelContext(panelId)
      const [row] = yield* Effect.promise(() =>
        database.db
          .select({ key: webPanelStorage.key })
          .from(webPanelStorage)
          .where(eq(webPanelStorage.panelId, panelId))
          .limit(1)
      )
      return row !== undefined
    })
  }

  getWebPanelStorage(
    panelId: string,
    key: string
  ): PanelEffect<JsonValue | undefined> {
    const getWebPanelContext = this.getWebPanelContext.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      yield* getWebPanelContext(panelId)
      const [row] = yield* Effect.promise(() =>
        database.db
          .select({ valueJson: webPanelStorage.valueJson })
          .from(webPanelStorage)
          .where(
            and(
              eq(webPanelStorage.panelId, panelId),
              eq(webPanelStorage.key, key)
            )
          )
          .limit(1)
      )
      // SAFETY: The surrounding boundary contract establishes this asserted value.
      return row ? (JSON.parse(row.valueJson) as JsonValue) : undefined
    })
  }

  setWebPanelStorage(
    panelId: string,
    key: string,
    value: JsonValue
  ): PanelEffect<void> {
    const getWebPanelContext = this.getWebPanelContext.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      yield* getWebPanelContext(panelId)
      const valueJson = JSON.stringify(value)
      const valueBytes = Buffer.byteLength(valueJson)
      if (valueBytes > WEB_PANEL_STORAGE_MAX_VALUE_BYTES) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_PANEL_STORAGE_VALUE_TOO_LARGE',
            'Web panel storage values are limited to 64 KiB',
            413
          )
        )
      }

      const storedValues = yield* Effect.promise(() =>
        database.db
          .select({ valueJson: webPanelStorage.valueJson })
          .from(webPanelStorage)
          .where(
            and(
              eq(webPanelStorage.panelId, panelId),
              ne(webPanelStorage.key, key)
            )
          )
      )
      const storedBytes = storedValues.reduce(
        (total, row) => total + Buffer.byteLength(row.valueJson),
        0
      )
      if (
        storedValues.length >= WEB_PANEL_STORAGE_MAX_ENTRIES ||
        storedBytes + valueBytes > WEB_PANEL_STORAGE_MAX_TOTAL_BYTES
      ) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_PANEL_STORAGE_QUOTA_EXCEEDED',
            'Web panel storage is limited to 256 values and 1 MiB per panel',
            413
          )
        )
      }

      const updatedAt = now()
      yield* Effect.promise(() =>
        database.db
          .insert(webPanelStorage)
          .values({ panelId, key, valueJson, updatedAt })
          .onConflictDoUpdate({
            target: [webPanelStorage.panelId, webPanelStorage.key],
            set: { valueJson, updatedAt }
          })
      )
    })
  }

  deleteWebPanelStorage(panelId: string, key: string): PanelEffect<void> {
    const getWebPanelContext = this.getWebPanelContext.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      yield* getWebPanelContext(panelId)
      yield* Effect.promise(() =>
        database.db
          .delete(webPanelStorage)
          .where(
            and(
              eq(webPanelStorage.panelId, panelId),
              eq(webPanelStorage.key, key)
            )
          )
      )
    })
  }

  resolveWebPanelAsset(
    panelId: string,
    requestedPath: string
  ): PanelEffect<WebPanelAssetResolution> {
    const effectiveWebPanelDefinitions =
      this.effectiveWebPanelDefinitions.bind(this)
    const requireWebPanelPermissions =
      this.requireWebPanelPermissions.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const webPanelRuntime = yield* WebPanelRuntimePort
      const [panel] = yield* Effect.promise(() =>
        database.db
          .select()
          .from(webPanels)
          .where(eq(webPanels.id, panelId))
          .limit(1)
      )
      if (!panel) {
        return yield* Effect.fail(
          new DomainError('PANEL_NOT_FOUND', 'Panel not found', 404)
        )
      }

      const definition = (yield* effectiveWebPanelDefinitions(
        panel.worktreeId
      )).find((candidate) => candidate.id === panel.definitionId)
      if (!definition) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_PANEL_DEFINITION_NOT_FOUND',
            'The definition for this panel is unavailable',
            404
          )
        )
      }

      yield* requireWebPanelPermissions(panel.worktreeId, definition)
      const encodedPanelId = encodeURIComponent(panelId)
      return yield* Effect.promise(() =>
        webPanelRuntime.resolve(
          definition,
          requestedPath,
          `/api/web-panels/${encodedPanelId}/assets/`
        )
      )
    })
  }

  listBrowserPanels(): PanelEffect<BrowserPanel[]> {
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const rows = yield* Effect.promise(() =>
        database.db
          .select()
          .from(browserPanels)
          .orderBy(asc(browserPanels.createdAt), asc(browserPanels.id))
      )
      return rows.map(mapBrowserPanel)
    })
  }

  listWebPanels(): PanelEffect<WebPanel[]> {
    const effectiveWebPanelDefinitions =
      this.effectiveWebPanelDefinitions.bind(this)
    const webPanelPermissionsGranted =
      this.webPanelPermissionsGranted.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const rows = yield* Effect.promise(() =>
        database.db
          .select()
          .from(webPanels)
          .orderBy(asc(webPanels.createdAt), asc(webPanels.id))
      )
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const definitions = yield* Effect.catchAll(
            effectiveWebPanelDefinitions(row.worktreeId),
            () => Effect.succeed([])
          )
          const definition = definitions.find(
            (candidate) => candidate.id === row.definitionId
          )
          return mapWebPanel(
            row,
            definition?.permissions ?? [],
            definition
              ? yield* webPanelPermissionsGranted(row.worktreeId, definition)
              : false
          )
        })
      )
    })
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
