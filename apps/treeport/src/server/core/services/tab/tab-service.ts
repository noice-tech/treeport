import crypto from 'node:crypto'
import {
  browserUrlSchema,
  browserObservedUrlSchema,
  normalizeBrowserTitle,
  decodeUnknownOrNull,
  webPanelInputSchema
} from '@treeport/shared'
import type {
  BrowserTab,
  GitDiffImageRequest,
  JsonValue,
  OpenBrowserTabResult,
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
import * as Schema from 'effect/Schema'
import {
  browserTabs,
  webPanels,
  webPanelStorage,
  workspaceItemOrders
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
import { EventBusPort, TerminalHostPort } from '../infrastructure/ports'
import { DatabasePort } from '../../database'
import { GitPort } from '../../git'
import { NetworkListenerPort } from '../../network-listeners'
import { WebPanelRuntimePort } from '../../web-panel-vite-runtime'
import { ProjectStore } from '../project/project-store'
import { PanelDefinitionService } from './panel-definition-service'

const now = (): string => new Date().toISOString()
const id = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
const WEB_PANEL_STORAGE_MAX_ENTRIES = 256
const WEB_PANEL_STORAGE_MAX_TOTAL_BYTES = 1024 * 1024
const WEB_PANEL_STORAGE_MAX_VALUE_BYTES = 64 * 1024

type TabEffect<A> = Effect.Effect<A, DomainError<unknown>, ApplicationServices>

export class TabService {
  private readonly definitions = new PanelDefinitionService()

  private requireAvailableWorktree(
    worktreeId: string,
    allowPrunable = false
  ): TabEffect<WorktreeRecord> {
    return Effect.flatMap(ProjectObservationOperations, (observations) =>
      observations.requireAvailableWorktree(worktreeId, allowPrunable)
    ).pipe(Effect.withSpan('treeport.tab.verify_worktree'))
  }

  private requireBrowserWorktree(
    worktreeId: string
  ): TabEffect<WorktreeRecord> {
    return Effect.gen(function* () {
      const store = yield* ProjectStore
      const observations = yield* ProjectObservationOperations
      const worktree = yield* store.getWorktree(worktreeId)
      if (worktree.prunable) {
        return yield* Effect.fail(
          new DomainError(
            'WORKTREE_UNAVAILABLE',
            'Git reports this worktree as prunable',
            409
          )
        )
      }

      // Browser creation, owner tickets, and owner claims each reach this check.
      // Verify the target identity without reconciling every tree in the project
      // or waiting behind unrelated project observations. Do not cache authorization.
      return yield* observations.verifyWorktreeLaunchTarget(worktree)
    }).pipe(Effect.withSpan('treeport.browser.verify_worktree'))
  }

  private getProject(projectId: string): TabEffect<ProjectRecord> {
    return Effect.flatMap(ProjectStore, (store) => store.getProject(projectId))
  }

  private getWorktree(worktreeId: string): TabEffect<WorktreeRecord> {
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
  ): TabEffect<Array<WebPanelDefinition & ResolvedWebPanelSource>> {
    return this.definitions
      .effectiveWebPanelDefinitions(worktreeId)
      .pipe(Effect.withSpan('treeport.web_panel.definitions'))
  }

  webPanelPermissionSourceKey(
    worktreeId: string,
    definition: WebPanelDefinition
  ): TabEffect<string> {
    return this.definitions.webPanelPermissionSourceKey(worktreeId, definition)
  }

  private webPanelPermissionsGranted(
    worktreeId: string,
    definition: WebPanelDefinition
  ): TabEffect<boolean> {
    return this.definitions.webPanelPermissionsGranted(worktreeId, definition)
  }

  listWebPanelDefinitions(worktreeId: string): TabEffect<WebPanelDefinition[]> {
    return this.definitions.listWebPanelDefinitions(worktreeId)
  }

  setWebPanelPermissionGrant(
    worktreeId: string,
    definitionId: string,
    granted: boolean,
    expectedPermissions: WebPanelPermission[]
  ): TabEffect<WebPanelDefinition> {
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
  ): TabEffect<void> {
    return this.definitions
      .requireWebPanelPermissions(worktreeId, definition)
      .pipe(Effect.withSpan('treeport.web_panel.permissions'))
  }

  reorderTabs(worktreeId: string, tabIds: readonly string[]): TabEffect<void> {
    const requireAvailableWorktree = this.requireAvailableWorktree.bind(this)
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      yield* requireAvailableWorktree(worktreeId)
      const [browserRows, webRows] = yield* Effect.all(
        [
          database
            .execute('tab.service.186', (db) =>
              db
                .select({ id: browserTabs.id })
                .from(browserTabs)
                .where(eq(browserTabs.worktreeId, worktreeId))
            )
            .pipe(Effect.orDie),
          database
            .execute('tab.service.192', (db) =>
              db
                .select({ id: webPanels.id })
                .from(webPanels)
                .where(eq(webPanels.worktreeId, worktreeId))
            )
            .pipe(Effect.orDie)
        ],
        { concurrency: 'unbounded' }
      )
      const currentIds = new Set(
        [...browserRows, ...webRows].map((tab) => tab.id)
      )
      if (
        tabIds.length !== currentIds.size ||
        tabIds.some((tabId) => !currentIds.has(tabId))
      ) {
        return yield* Effect.fail(
          new DomainError(
            'STALE_WORKSPACE_ORDER',
            'Tool tabs changed before they could be reordered',
            409
          )
        )
      }

      yield* database
        .execute('tab.service.217', (db) =>
          db.transaction(async (tx) => {
            await tx
              .delete(workspaceItemOrders)
              .where(
                and(
                  eq(workspaceItemOrders.worktreeId, worktreeId),
                  eq(workspaceItemOrders.surface, 'tool')
                )
              )
            await tx.insert(workspaceItemOrders).values(
              tabIds.map((itemId, position) => ({
                worktreeId,
                surface: 'tool' as const,
                itemId,
                position
              }))
            )
          })
        )
        .pipe(Effect.orDie)
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('worktree.updated', { worktreeId })
      })
    })
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

  createBrowserTab(
    worktreeId: string,
    requestedUrl?: string
  ): TabEffect<BrowserTab> {
    const requireAvailableWorktree = this.requireBrowserWorktree.bind(this)
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      yield* requireAvailableWorktree(worktreeId)
      const parsedUrl = requestedUrl
        ? decodeUnknownOrNull(browserUrlSchema, requestedUrl)
        : null
      if (requestedUrl && !parsedUrl) {
        return yield* Effect.fail(
          new DomainError(
            'INVALID_BROWSER_URL',
            'Enter an absolute HTTP or HTTPS URL without credentials',
            400
          )
        )
      }

      const url = parsedUrl ? new URL(parsedUrl).href : 'about:blank'
      const timestamp = now()
      const tab: BrowserTab = {
        id: id('tab'),
        kind: 'browser',
        worktreeId,
        title: url === 'about:blank' ? 'Browser' : new URL(url).host,
        url,
        createdAt: timestamp,
        updatedAt: timestamp
      }
      yield* database
        .execute('tab.service.290', (db) =>
          db.insert(browserTabs).values({
            id: tab.id,
            worktreeId: tab.worktreeId,
            title: tab.title,
            url: tab.url,
            createdAt: tab.createdAt,
            updatedAt: tab.updatedAt
          })
        )
        .pipe(Effect.orDie)
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('tab.created', { worktreeId, tabId: tab.id })
      })
      return tab
    })
  }

  openBrowserTab(
    worktreeId: string | null,
    requestedUrl?: string,
    sourceTerminalId: string | null = null,
    sourceTabId: string | null = null,
    reuseExistingUrl = false,
    requestId: string | null = null
  ): TabEffect<OpenBrowserTabResult> {
    const getBrowserTab = this.getBrowserTab.bind(this)
    const createBrowserTab = this.createBrowserTab.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const terminals = yield* TerminalOperations
      let targetWorktreeId = worktreeId
      if (sourceTerminalId) {
        const terminal = yield* terminals
          .getTerminalFromBindings(sourceTerminalId)
          .pipe(Effect.withSpan('treeport.browser.open.resolve_terminal'))
        if (targetWorktreeId && terminal.worktreeId !== targetWorktreeId) {
          return yield* Effect.fail(
            new DomainError(
              'INVALID_TAB_OPEN_SOURCE',
              'The source terminal does not belong to the target tree',
              400
            )
          )
        }

        targetWorktreeId ??= terminal.worktreeId
      }

      if (sourceTabId) {
        const sourceTab = yield* getBrowserTab(sourceTabId)
        if (targetWorktreeId && sourceTab.worktreeId !== targetWorktreeId) {
          return yield* Effect.fail(
            new DomainError(
              'INVALID_TAB_OPEN_SOURCE',
              'The source Browser does not belong to the target tree',
              400
            )
          )
        }

        targetWorktreeId ??= sourceTab.worktreeId
      }

      if (!targetWorktreeId) {
        return yield* Effect.fail(
          new DomainError(
            'INVALID_TAB_OPEN_SOURCE',
            'A target tree or tab source is required',
            400
          )
        )
      }

      let existingTab: BrowserTab | null = null
      if (reuseExistingUrl && requestedUrl) {
        const parsedUrl = decodeUnknownOrNull(browserUrlSchema, requestedUrl)
        if (!parsedUrl) {
          return yield* Effect.fail(
            new DomainError(
              'INVALID_BROWSER_URL',
              'Enter an absolute HTTP or HTTPS URL without credentials',
              400
            )
          )
        }

        const url = new URL(parsedUrl).href
        const [existing] = yield* database
          .execute('tab.service.380', (db) =>
            db
              .select()
              .from(browserTabs)
              .where(
                and(
                  eq(browserTabs.worktreeId, targetWorktreeId),
                  eq(browserTabs.url, url)
                )
              )
              .orderBy(desc(browserTabs.createdAt), desc(browserTabs.id))
              .limit(1)
          )
          .pipe(Effect.orDie)
          .pipe(Effect.withSpan('treeport.browser.open.lookup_tab'))
        existingTab = existing ? mapBrowserTab(existing) : null
      }

      const tab =
        existingTab ??
        (yield* createBrowserTab(targetWorktreeId, requestedUrl).pipe(
          Effect.withSpan('treeport.browser.open.create_panel')
        ))
      yield* Effect.annotateCurrentSpan({
        'treeport.tab.id': tab.id,
        'treeport.browser.tab_reused': existingTab !== null
      })
      yield* Effect.sync(() =>
        events.publish('tab.open_requested', {
          worktreeId: targetWorktreeId,
          tabId: tab.id,
          tab,
          sourceTerminalId,
          sourceTabId,
          requestId
        })
      ).pipe(Effect.withSpan('treeport.browser.open.publish'))
      return { tab }
    }).pipe(Effect.withSpan('treeport.browser.open'))
  }

  openBrowserTabFromTerminal(
    terminalId: string,
    requestedUrl: string,
    requestId: string | null = null
  ): TabEffect<OpenBrowserTabResult> {
    return this.openBrowserTab(
      null,
      requestedUrl,
      terminalId,
      null,
      true,
      requestId
    )
  }

  openBrowserTabFromPanel(
    tabId: string,
    requestedUrl: string
  ): TabEffect<OpenBrowserTabResult> {
    return this.openBrowserTab(null, requestedUrl, null, tabId)
  }

  getBrowserTab(tabId: string): TabEffect<BrowserTab> {
    const requireAvailableWorktree = this.requireBrowserWorktree.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const [row] = yield* database
        .execute('tab.service.446', (db) =>
          db
            .select()
            .from(browserTabs)
            .where(eq(browserTabs.id, tabId))
            .limit(1)
        )
        .pipe(Effect.orDie)
      if (!row) {
        return yield* Effect.fail(
          new DomainError('TAB_NOT_FOUND', 'Browser not found', 404)
        )
      }

      yield* requireAvailableWorktree(row.worktreeId)
      return mapBrowserTab(row)
    })
  }

  authorizeBrowserTab(
    tabId: string
  ): TabEffect<{ tab: BrowserTab; worktreePath: string }> {
    const getBrowserTab = this.getBrowserTab.bind(this)
    const getWorktree = this.getWorktree.bind(this)

    return Effect.gen(function* () {
      const tab = yield* getBrowserTab(tabId)
      const worktree = yield* getWorktree(tab.worktreeId)
      return { tab, worktreePath: worktree.path }
    })
  }

  updateBrowserTabState(
    tabId: string,
    state: { url: string; title: string }
  ): TabEffect<BrowserTab> {
    const getBrowserTab = this.getBrowserTab.bind(this)
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const tab = yield* getBrowserTab(tabId)
      const parsedUrl =
        state.url === 'about:blank'
          ? 'about:blank'
          : decodeUnknownOrNull(browserObservedUrlSchema, state.url)
      if (!parsedUrl) {
        return yield* Effect.fail(
          new DomainError(
            'INVALID_BROWSER_URL',
            'The hosted browser reported an unsupported URL',
            400
          )
        )
      }

      const url =
        parsedUrl === 'about:blank' ? parsedUrl : new URL(parsedUrl).href
      const requestedTitle = normalizeBrowserTitle(state.title.trim())
      const title =
        requestedTitle ||
        (url === 'about:blank' ? 'Browser' : new URL(url).host || 'Browser')
      if (tab.url === url && tab.title === title) {
        return tab
      }

      const observedAt = now()
      const updatedAt =
        observedAt > tab.updatedAt
          ? observedAt
          : new Date(Date.parse(tab.updatedAt) + 1).toISOString()
      yield* database
        .execute('tab.service.518', (db) =>
          db
            .update(browserTabs)
            .set({ url, title, updatedAt })
            .where(eq(browserTabs.id, tabId))
        )
        .pipe(Effect.orDie)
      const updated = { ...tab, url, title, updatedAt }
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('tab.updated', {
          worktreeId: tab.worktreeId,
          tabId
        })
      })
      return updated
    })
  }

  deleteBrowserTab(tabId: string): TabEffect<void> {
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const [row] = yield* database
        .execute('tab.service.543', (db) =>
          db
            .select()
            .from(browserTabs)
            .where(eq(browserTabs.id, tabId))
            .limit(1)
        )
        .pipe(Effect.orDie)
        .pipe(Effect.withSpan('treeport.browser.remove.lookup'))
      if (!row) {
        return yield* Effect.fail(
          new DomainError('TAB_NOT_FOUND', 'Browser not found', 404)
        )
      }

      yield* Effect.annotateCurrentSpan({
        'treeport.worktree.id': row.worktreeId
      })
      yield* database
        .execute('tab.service.559', (db) =>
          db.delete(browserTabs).where(eq(browserTabs.id, tabId))
        )
        .pipe(Effect.orDie)
        .pipe(Effect.withSpan('treeport.browser.remove.persist'))
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('tab.removed', {
          worktreeId: row.worktreeId,
          tabId
        })
      })
    }).pipe(
      Effect.withSpan('treeport.browser.remove', {
        attributes: { 'treeport.tab.id': tabId }
      })
    )
  }

  deleteTab(tabId: string, discardStoredData = false): TabEffect<void> {
    const deleteBrowserTab = this.deleteBrowserTab.bind(this)
    const deleteWebPanel = this.deleteWebPanel.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const [browserTab] = yield* database
        .execute('tab.service.582', (db) =>
          db
            .select({ id: browserTabs.id })
            .from(browserTabs)
            .where(eq(browserTabs.id, tabId))
            .limit(1)
        )
        .pipe(Effect.orDie)
        .pipe(Effect.withSpan('treeport.tab.remove.resolve_kind'))
      yield* Effect.annotateCurrentSpan({
        'treeport.tab.kind': browserTab ? 'browser' : 'web'
      })
      return yield* browserTab
        ? deleteBrowserTab(tabId)
        : deleteWebPanel(tabId, discardStoredData)
    }).pipe(
      Effect.withSpan('treeport.tab.remove', {
        attributes: { 'treeport.tab.id': tabId }
      })
    )
  }

  createWebPanel(
    worktreeId: string,
    definitionId: string,
    launch: WebPanelLaunch = { input: null, cwd: null }
  ): TabEffect<WebPanel> {
    const requireAvailableWorktree = this.requireAvailableWorktree.bind(this)
    const effectiveWebPanelDefinitions =
      this.effectiveWebPanelDefinitions.bind(this)
    const requireWebPanelPermissions =
      this.requireWebPanelPermissions.bind(this)
    const createValidatedWebPanel = this.createValidatedWebPanel.bind(this)

    return Effect.gen(function* () {
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
      return yield* createValidatedWebPanel(worktree, definition, launch)
    })
  }

  // Only called after worktree availability, definition resolution, and permission
  // validation in this operation. Do not repeat project observation on creation.
  private createValidatedWebPanel(
    worktree: WorktreeRecord,
    definition: WebPanelDefinition,
    launch: WebPanelLaunch
  ): TabEffect<WebPanel> {
    const normalizeWebPanelLaunch = this.normalizeWebPanelLaunch.bind(this)
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const worktreeId = worktree.id
      const definitionId = definition.id
      const normalized = yield* normalizeWebPanelLaunch(worktree, launch)
      const timestamp = now()
      const tab: WebPanel = {
        id: id('tab'),
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
      yield* database
        .execute('tab.service.663', (db) =>
          db.insert(webPanels).values({
            id: tab.id,
            worktreeId: tab.worktreeId,
            definitionId: tab.definitionId,
            title: tab.title,
            inputJson: normalized.inputJson,
            launchCwd: tab.launch.cwd,
            createdAt: tab.createdAt,
            updatedAt: tab.updatedAt
          })
        )
        .pipe(Effect.orDie)
        .pipe(Effect.withSpan('treeport.web_panel.create.persist'))
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('tab.created', { worktreeId, tabId: tab.id })
      })
      yield* Effect.annotateCurrentSpan({ 'treeport.tab.id': tab.id })
      return tab
    }).pipe(Effect.withSpan('treeport.web_panel.create'))
  }

  openWebPanel(
    worktreeId: string,
    definitionId: string,
    launch: WebPanelLaunch = { input: null, cwd: null },
    newInstance = false,
    sourceTerminalId: string | null = null,
    requestId: string | null = null
  ): TabEffect<OpenWebPanelResult> {
    const requireAvailableWorktree = this.requireAvailableWorktree.bind(this)
    const effectiveWebPanelDefinitions =
      this.effectiveWebPanelDefinitions.bind(this)
    const requireWebPanelPermissions =
      this.requireWebPanelPermissions.bind(this)
    const createValidatedWebPanel = this.createValidatedWebPanel.bind(this)
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
        events.publish('tab.open_requested', {
          worktreeId,
          tabId: result.tab.id,
          tab: result.tab,
          sourceTerminalId,
          sourceTabId: null,
          requestId
        })
        return result
      }

      if (newInstance) {
        return finish({
          tab: yield* createValidatedWebPanel(worktree, definition, launch),
          created: true,
          reused: false
        })
      }

      const [existing] = yield* database
        .execute('tab.service.740', (db) =>
          db
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
        .pipe(Effect.orDie)
        .pipe(Effect.withSpan('treeport.web_panel.open.lookup'))
      if (!existing) {
        return finish({
          tab: yield* createValidatedWebPanel(worktree, definition, launch),
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
      yield* database
        .execute('tab.service.767', (db) =>
          db
            .update(webPanels)
            .set({
              title: definition.title,
              inputJson: normalized.inputJson,
              launchCwd: normalized.launch.cwd,
              updatedAt
            })
            .where(eq(webPanels.id, existing.id))
        )
        .pipe(Effect.orDie)
        .pipe(Effect.withSpan('treeport.web_panel.open.persist'))
      const tab = mapWebPanel(
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
        events.publish('tab.updated', { worktreeId, tabId: tab.id })
      })
      return finish({ tab, created: false, reused: true })
    }).pipe(
      Effect.tap((result) =>
        Effect.annotateCurrentSpan({
          'treeport.tab.id': result.tab.id,
          'treeport.worktree.id': worktreeId,
          'treeport.web_panel.reused': result.reused
        })
      ),
      Effect.withSpan('treeport.web_panel.open')
    )
  }

  deleteWebPanel(tabId: string, discardStoredData = false): TabEffect<void> {
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const [tab] = yield* database
        .execute('tab.service.816', (db) =>
          db.select().from(webPanels).where(eq(webPanels.id, tabId)).limit(1)
        )
        .pipe(Effect.orDie)
        .pipe(Effect.withSpan('treeport.web_panel.remove.lookup'))
      if (!tab) {
        return yield* Effect.fail(
          new DomainError('TAB_NOT_FOUND', 'Tab not found', 404)
        )
      }

      yield* Effect.annotateCurrentSpan({
        'treeport.worktree.id': tab.worktreeId
      })
      const [storedValue] = yield* database
        .execute('tab.service.832', (db) =>
          db
            .select({ key: webPanelStorage.key })
            .from(webPanelStorage)
            .where(eq(webPanelStorage.tabId, tabId))
            .limit(1)
        )
        .pipe(Effect.orDie)
        .pipe(Effect.withSpan('treeport.web_panel.remove.storage_check'))
      if (!discardStoredData && storedValue) {
        return yield* Effect.fail(
          new DomainError(
            'TAB_HAS_STORED_DATA',
            'Closing this tab requires confirmation because its saved data will be deleted',
            409
          )
        )
      }

      yield* database
        .execute('tab.service.849', (db) =>
          db.delete(webPanels).where(eq(webPanels.id, tabId))
        )
        .pipe(Effect.orDie)
        .pipe(Effect.withSpan('treeport.web_panel.remove.persist'))
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('tab.removed', {
          worktreeId: tab.worktreeId,
          tabId
        })
      })
    }).pipe(
      Effect.withSpan('treeport.web_panel.remove', {
        attributes: { 'treeport.tab.id': tabId }
      })
    )
  }

  requireWebPanelTreeFiles(
    tabId: string
  ): TabEffect<{ project: ProjectRecord; worktree: WorktreeRecord }> {
    const effectiveWebPanelDefinitions =
      this.effectiveWebPanelDefinitions.bind(this)
    const requireWebPanelPermissions =
      this.requireWebPanelPermissions.bind(this)
    const requireAvailableWorktree = this.requireAvailableWorktree.bind(this)
    const getProject = this.getProject.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const [tab] = yield* database
        .execute('tab.service.878', (db) =>
          db.select().from(webPanels).where(eq(webPanels.id, tabId)).limit(1)
        )
        .pipe(Effect.orDie)
      if (!tab) {
        return yield* Effect.fail(
          new DomainError('TAB_NOT_FOUND', 'Tab not found', 404)
        )
      }

      const definition = (yield* effectiveWebPanelDefinitions(
        tab.worktreeId
      )).find((candidate) => candidate.id === tab.definitionId)
      if (!definition) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_PANEL_DEFINITION_NOT_FOUND',
            'The definition for this tab is unavailable',
            404
          )
        )
      }

      yield* requireWebPanelPermissions(tab.worktreeId, definition)
      if (!definition.permissions.includes('tree-files')) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_PANEL_TREE_FILES_REQUIRED',
            'This tab does not have permission to access tree files',
            403
          )
        )
      }

      const worktree = yield* requireAvailableWorktree(tab.worktreeId)
      const project = yield* getProject(worktree.projectId)
      return { project, worktree }
    })
  }

  getWebPanelContext(tabId: string): TabEffect<WebPanelContext> {
    const effectiveWebPanelDefinitions =
      this.effectiveWebPanelDefinitions.bind(this)
    const webPanelPermissionsGranted =
      this.webPanelPermissionsGranted.bind(this)
    const getWorktree = this.getWorktree.bind(this)
    const getProject = this.getProject.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const [panelRow] = yield* database
        .execute('tab.service.931', (db) =>
          db.select().from(webPanels).where(eq(webPanels.id, tabId)).limit(1)
        )
        .pipe(Effect.orDie)
      if (!panelRow) {
        return yield* Effect.fail(
          new DomainError('TAB_NOT_FOUND', 'Tab not found', 404)
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

  getWebPanelDiff(tabId: string) {
    const getWebPanelContext = this.getWebPanelContext.bind(this)
    const getWorktree = this.getWorktree.bind(this)

    return Effect.gen(function* () {
      const git = yield* GitPort
      const context = yield* getWebPanelContext(tabId)
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
      return yield* git
        .worktreeDiff(worktree.path, context.project.defaultBranch!)
        .pipe(
          Effect.mapError(
            (reason) =>
              new DomainError(
                'GIT_DIFF_UNAVAILABLE',
                reason.message || 'Could not inspect tree changes',
                422
              )
          )
        )
    })
  }

  getWebPanelFileDiff(tabId: string, filePath: string) {
    const getWebPanelContext = this.getWebPanelContext.bind(this)
    const getWorktree = this.getWorktree.bind(this)

    return Effect.gen(function* () {
      const git = yield* GitPort
      const context = yield* getWebPanelContext(tabId)
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
      return yield* git
        .worktreeFileDiff(
          worktree.path,
          context.project.defaultBranch,
          filePath
        )
        .pipe(
          Effect.mapError(
            (reason) =>
              new DomainError(
                'GIT_FILE_DIFF_UNAVAILABLE',
                reason.message || 'Could not inspect this file change',
                422
              )
          )
        )
    })
  }

  getWebPanelDiffImage(tabId: string, input: GitDiffImageRequest) {
    const getWebPanelContext = this.getWebPanelContext.bind(this)
    const requireAvailableWorktree = this.requireAvailableWorktree.bind(this)

    return Effect.gen(function* () {
      const git = yield* GitPort
      const context = yield* getWebPanelContext(tabId)
      if (context.project.kind !== 'repository') {
        return yield* Effect.fail(
          new DomainError(
            'GIT_NOT_AVAILABLE',
            'Git images are not available for a folder project',
            409
          )
        )
      }

      const worktree = yield* requireAvailableWorktree(context.panel.worktreeId)
      return yield* git
        .diffImage(worktree.path, input)
        .pipe(
          Effect.mapError(
            (reason) =>
              new DomainError(
                'GIT_IMAGE_UNAVAILABLE',
                reason.message || 'Could not read image',
                422
              )
          )
        )
    })
  }

  getBrowserTabListeners(tabId: string): TabEffect<WorktreeListenerDiscovery> {
    const getBrowserTab = this.getBrowserTab.bind(this)
    const getWorktree = this.getWorktree.bind(this)

    return Effect.gen(function* () {
      const terminalHost = yield* TerminalHostPort
      const networkListeners = yield* NetworkListenerPort
      const tab = yield* getBrowserTab(tabId)
      const worktree = yield* getWorktree(tab.worktreeId)
      const terminalProcesses = yield* terminalHost
        .listProcesses(worktree.id)
        .pipe(Effect.orDie)
      return yield* networkListeners
        .listeners({ worktreePath: worktree.path, terminalProcesses })
        .pipe(Effect.orDie)
    })
  }

  getPanelListeners(tabId: string): TabEffect<WorktreeListenerDiscovery> {
    const getBrowserTabListeners = this.getBrowserTabListeners.bind(this)
    const getWebPanelListeners = this.getWebPanelListeners.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const [browserTab] = yield* database
        .execute('tab.service.1065', (db) =>
          db
            .select({ id: browserTabs.id })
            .from(browserTabs)
            .where(eq(browserTabs.id, tabId))
            .limit(1)
        )
        .pipe(Effect.orDie)
      return yield* browserTab
        ? getBrowserTabListeners(tabId)
        : getWebPanelListeners(tabId)
    })
  }

  getWebPanelListeners(tabId: string): TabEffect<WorktreeListenerDiscovery> {
    const getWebPanelContext = this.getWebPanelContext.bind(this)
    const getWorktree = this.getWorktree.bind(this)

    return Effect.gen(function* () {
      const terminalHost = yield* TerminalHostPort
      const networkListeners = yield* NetworkListenerPort
      const context = yield* getWebPanelContext(tabId)
      const worktree = yield* getWorktree(context.panel.worktreeId)
      const terminalProcesses = yield* terminalHost
        .listProcesses(worktree.id)
        .pipe(Effect.orDie)
      return yield* networkListeners
        .listeners({ worktreePath: worktree.path, terminalProcesses })
        .pipe(Effect.orDie)
    })
  }

  hasWebPanelStorage(tabId: string): TabEffect<boolean> {
    const getWebPanelContext = this.getWebPanelContext.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      yield* getWebPanelContext(tabId)
      const [row] = yield* database
        .execute('tab.service.1107', (db) =>
          db
            .select({ key: webPanelStorage.key })
            .from(webPanelStorage)
            .where(eq(webPanelStorage.tabId, tabId))
            .limit(1)
        )
        .pipe(Effect.orDie)
      return row !== undefined
    })
  }

  getWebPanelStorage(
    tabId: string,
    key: string
  ): TabEffect<JsonValue | undefined> {
    const getWebPanelContext = this.getWebPanelContext.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      yield* getWebPanelContext(tabId)
      const [row] = yield* database
        .execute('tab.service.1127', (db) =>
          db
            .select({ valueJson: webPanelStorage.valueJson })
            .from(webPanelStorage)
            .where(
              and(
                eq(webPanelStorage.tabId, tabId),
                eq(webPanelStorage.key, key)
              )
            )
            .limit(1)
        )
        .pipe(Effect.orDie)
      // SAFETY: The surrounding boundary contract establishes this asserted value.
      return row ? (JSON.parse(row.valueJson) as JsonValue) : undefined
    })
  }

  setWebPanelStorage(
    tabId: string,
    key: string,
    value: JsonValue
  ): TabEffect<void> {
    const getWebPanelContext = this.getWebPanelContext.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      yield* getWebPanelContext(tabId)
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

      const storedValues = yield* database
        .execute('tab.service.1166', (db) =>
          db
            .select({ valueJson: webPanelStorage.valueJson })
            .from(webPanelStorage)
            .where(
              and(
                eq(webPanelStorage.tabId, tabId),
                ne(webPanelStorage.key, key)
              )
            )
        )
        .pipe(Effect.orDie)
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
            'Web panel storage is limited to 256 values and 1 MiB per tab',
            413
          )
        )
      }

      const updatedAt = now()
      yield* database
        .execute('tab.service.1195', (db) =>
          db
            .insert(webPanelStorage)
            .values({ tabId, key, valueJson, updatedAt })
            .onConflictDoUpdate({
              target: [webPanelStorage.tabId, webPanelStorage.key],
              set: { valueJson, updatedAt }
            })
        )
        .pipe(Effect.orDie)
    })
  }

  deleteWebPanelStorage(tabId: string, key: string): TabEffect<void> {
    const getWebPanelContext = this.getWebPanelContext.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      yield* getWebPanelContext(tabId)
      yield* database
        .execute('tab.service.1213', (db) =>
          db
            .delete(webPanelStorage)
            .where(
              and(
                eq(webPanelStorage.tabId, tabId),
                eq(webPanelStorage.key, key)
              )
            )
        )
        .pipe(Effect.orDie)
    })
  }

  resolveWebPanelAsset(
    tabId: string,
    requestedPath: string
  ): TabEffect<WebPanelAssetResolution> {
    const effectiveWebPanelDefinitions =
      this.effectiveWebPanelDefinitions.bind(this)
    const requireWebPanelPermissions =
      this.requireWebPanelPermissions.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const webPanelRuntime = yield* WebPanelRuntimePort
      yield* Effect.annotateCurrentSpan({ 'treeport.tab.id': tabId })
      const [tab] = yield* database
        .execute('tab.service.1239', (db) =>
          db.select().from(webPanels).where(eq(webPanels.id, tabId)).limit(1)
        )
        .pipe(Effect.orDie)
      if (!tab) {
        return yield* Effect.fail(
          new DomainError('TAB_NOT_FOUND', 'Tab not found', 404)
        )
      }

      const definition = (yield* effectiveWebPanelDefinitions(
        tab.worktreeId
      )).find((candidate) => candidate.id === tab.definitionId)
      if (!definition) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_PANEL_DEFINITION_NOT_FOUND',
            'The definition for this tab is unavailable',
            404
          )
        )
      }

      yield* requireWebPanelPermissions(tab.worktreeId, definition)
      const encodedTabId = encodeURIComponent(tabId)
      return yield* webPanelRuntime
        .resolve(
          definition,
          requestedPath,
          `/api/web-panels/${encodedTabId}/assets/`
        )
        .pipe(
          Effect.catchTag('WebPanelRuntimeError', Effect.die),
          Effect.tap((result) =>
            Effect.annotateCurrentSpan({
              'treeport.web_panel.development': result.development,
              'treeport.web_panel.resolution': result.kind
            })
          ),
          Effect.withSpan('treeport.web_panel.runtime.resolve')
        )
    }).pipe(Effect.withSpan('treeport.web_panel.asset'))
  }

  listBrowserTabs(): TabEffect<BrowserTab[]> {
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const rows = yield* database
        .execute('tab.service.1291', (db) =>
          db
            .select()
            .from(browserTabs)
            .orderBy(asc(browserTabs.createdAt), asc(browserTabs.id))
        )
        .pipe(Effect.orDie)
      return rows.map(mapBrowserTab)
    })
  }

  listWebPanels(): TabEffect<WebPanel[]> {
    const effectiveWebPanelDefinitions =
      this.effectiveWebPanelDefinitions.bind(this)
    const webPanelPermissionsGranted =
      this.webPanelPermissionsGranted.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const rows = yield* database
        .execute('tab.service.1309', (db) =>
          db
            .select()
            .from(webPanels)
            .orderBy(asc(webPanels.createdAt), asc(webPanels.id))
        )
        .pipe(Effect.orDie)
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

function mapBrowserTab(row: typeof browserTabs.$inferSelect): BrowserTab {
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
  const parsedInput = decodeUnknownOrNull(
    Schema.NullOr(webPanelInputSchema),
    JSON.parse(row.inputJson)
  )
  if (parsedInput === null && row.inputJson !== 'null') {
    throw new Error(`Web panel ${row.id} has invalid stored launch input`)
  }

  return {
    id: row.id,
    kind: 'web',
    worktreeId: row.worktreeId,
    definitionId: row.definitionId,
    title: row.title,
    launch: {
      input: parsedInput,
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
