import crypto from 'node:crypto'
import {
  browserUrlSchema,
  browserObservedUrlSchema,
  normalizeBrowserTitle,
  decodeUnknownOrNull,
  webAppInputSchema
} from '@treeport/shared'
import type {
  BrowserApp,
  GitDiffImageRequest,
  GitDiffRequest,
  JsonValue,
  OpenBrowserAppResult,
  OpenWebAppResult,
  ProjectRecord,
  WebApp,
  WebAppContext,
  WebAppDefinition,
  WebAppLaunch,
  WebAppPermission,
  WebAppStorageScope,
  WorktreeListenerDiscovery,
  WorktreeRecord
} from '@treeport/shared'
import { and, asc, desc, eq, ne } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import {
  browserApps,
  webApps,
  webAppStorage,
  workspaceItemOrders
} from '../../database-schema.ts'
import { DomainError } from '../../domain.ts'
import type {
  ResolvedWebAppSource,
  WebAppAssetResolution
} from '../../web-app-vite-runtime.ts'
import {
  ProjectObservationOperations,
  ProjectSnapshotOperations,
  TerminalOperations
} from '../domain-services.ts'
import type { ApplicationServices } from '../infrastructure/application-runtime.ts'
import { EventBusPort, TerminalHostPort } from '../infrastructure/ports.ts'
import { DatabasePort } from '../../database.ts'
import { GitPort } from '../../git.ts'
import { NetworkListenerPort } from '../../network-listeners.ts'
import { WebAppRuntimePort } from '../../web-app-vite-runtime.ts'
import { ProjectStore } from '../project/project-store.ts'
import { AppDefinitionService } from './app-definition-service.ts'

const now = (): string => new Date().toISOString()

const id = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`

const WEB_APP_STORAGE_MAX_ENTRIES = 256
const WEB_APP_STORAGE_MAX_TOTAL_BYTES = 1024 * 1024
const WEB_APP_STORAGE_MAX_VALUE_BYTES = 64 * 1024

type AppEffect<A> = Effect.Effect<A, DomainError<unknown>, ApplicationServices>

export class AppService {
  private readonly definitions = new AppDefinitionService()

  private requireAvailableWorktree(
    worktreeId: string,
    allowPrunable = false
  ): AppEffect<WorktreeRecord> {
    return Effect.flatMap(ProjectObservationOperations, (observations) =>
      observations.requireAvailableWorktree(worktreeId, allowPrunable)
    ).pipe(Effect.withSpan('treeport.app.verify_worktree'))
  }

  private requireBrowserWorktree(
    worktreeId: string
  ): AppEffect<WorktreeRecord> {
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

      return yield* observations.verifyWorktreeLaunchTarget(worktree)
    }).pipe(Effect.withSpan('treeport.browser.verify_worktree'))
  }

  private getProject(projectId: string): AppEffect<ProjectRecord> {
    return Effect.flatMap(ProjectStore, (store) => store.getProject(projectId))
  }

  private getWorktree(worktreeId: string): AppEffect<WorktreeRecord> {
    return Effect.flatMap(ProjectStore, (store) =>
      store.getWorktree(worktreeId)
    )
  }

  private invalidateProjectsSnapshot() {
    return Effect.flatMap(ProjectSnapshotOperations, (snapshots) =>
      Effect.sync(() => snapshots.invalidate())
    )
  }

  effectiveWebAppDefinitions(
    worktreeId: string
  ): AppEffect<Array<WebAppDefinition & ResolvedWebAppSource>> {
    return this.definitions
      .effectiveWebAppDefinitions(worktreeId)
      .pipe(Effect.withSpan('treeport.web_app.definitions'))
  }

  webAppPermissionSourceKey(
    worktreeId: string,
    definition: WebAppDefinition
  ): AppEffect<string> {
    return this.definitions.webAppPermissionSourceKey(worktreeId, definition)
  }

  private webAppPermissionsGranted(
    worktreeId: string,
    definition: WebAppDefinition
  ): AppEffect<boolean> {
    return this.definitions.webAppPermissionsGranted(worktreeId, definition)
  }

  listWebAppDefinitions(worktreeId: string): AppEffect<WebAppDefinition[]> {
    return this.definitions.listWebAppDefinitions(worktreeId)
  }

  setWebAppPermissionGrant(
    worktreeId: string,
    definitionId: string,
    granted: boolean,
    expectedPermissions: WebAppPermission[]
  ): AppEffect<WebAppDefinition> {
    return this.definitions.setWebAppPermissionGrant(
      worktreeId,
      definitionId,
      granted,
      expectedPermissions
    )
  }

  private requireWebAppPermissions(
    worktreeId: string,
    definition: WebAppDefinition
  ): AppEffect<void> {
    return this.definitions
      .requireWebAppPermissions(worktreeId, definition)
      .pipe(Effect.withSpan('treeport.web_app.permissions'))
  }

  reorderApps(worktreeId: string, appIds: readonly string[]): AppEffect<void> {
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
            .execute('app.service.186', (db) =>
              db
                .select({ id: browserApps.id })
                .from(browserApps)
                .where(eq(browserApps.worktreeId, worktreeId))
            )
            .pipe(Effect.orDie),
          database
            .execute('app.service.192', (db) =>
              db
                .select({ id: webApps.id })
                .from(webApps)
                .where(eq(webApps.worktreeId, worktreeId))
            )
            .pipe(Effect.orDie)
        ],
        { concurrency: 'unbounded' }
      )

      const currentIds = new Set(
        [...browserRows, ...webRows].map((app) => app.id)
      )

      if (
        appIds.length !== currentIds.size ||
        appIds.some((appId) => !currentIds.has(appId))
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
        .execute('app.service.217', (db) =>
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
              appIds.map((itemId, position) => ({
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

  private normalizeWebAppLaunch(
    worktree: WorktreeRecord,
    launch: WebAppLaunch
  ): Effect.Effect<
    { launch: WebAppLaunch; inputJson: string },
    DomainError<unknown>
  > {
    return this.definitions.normalizeWebAppLaunch(worktree, launch)
  }

  createBrowserApp(
    worktreeId: string,
    requestedUrl?: string
  ): AppEffect<BrowserApp> {
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
            'Enter an absolute HTTP, HTTPS, or local file URL without credentials',
            400
          )
        )
      }

      const url = parsedUrl ? new URL(parsedUrl).href : 'about:blank'
      const timestamp = now()

      const app: BrowserApp = {
        id: id('app'),
        kind: 'browser',
        worktreeId,
        title:
          url === 'about:blank' ? 'Browser' : new URL(url).host || 'Browser',
        url,
        createdAt: timestamp,
        updatedAt: timestamp
      }

      yield* database
        .execute('app.service.290', (db) =>
          db.insert(browserApps).values({
            id: app.id,
            worktreeId: app.worktreeId,
            title: app.title,
            url: app.url,
            createdAt: app.createdAt,
            updatedAt: app.updatedAt
          })
        )
        .pipe(Effect.orDie)
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('app.created', { worktreeId, appId: app.id })
      })

      return app
    })
  }

  openBrowserApp(
    worktreeId: string | null,
    requestedUrl?: string,
    sourceTerminalId: string | null = null,
    sourceAppId: string | null = null,
    reuseExistingUrl = false,
    requestId: string | null = null
  ): AppEffect<OpenBrowserAppResult> {
    const getBrowserApp = this.getBrowserApp.bind(this)
    const createBrowserApp = this.createBrowserApp.bind(this)

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
              'INVALID_APP_OPEN_SOURCE',
              'The source terminal does not belong to the target tree',
              400
            )
          )
        }

        targetWorktreeId ??= terminal.worktreeId
      }

      if (sourceAppId) {
        const sourceApp = yield* getBrowserApp(sourceAppId)

        if (targetWorktreeId && sourceApp.worktreeId !== targetWorktreeId) {
          return yield* Effect.fail(
            new DomainError(
              'INVALID_APP_OPEN_SOURCE',
              'The source Browser does not belong to the target tree',
              400
            )
          )
        }

        targetWorktreeId ??= sourceApp.worktreeId
      }

      if (!targetWorktreeId) {
        return yield* Effect.fail(
          new DomainError(
            'INVALID_APP_OPEN_SOURCE',
            'A target tree or app source is required',
            400
          )
        )
      }

      let existingApp: BrowserApp | null = null

      if (reuseExistingUrl && requestedUrl) {
        const parsedUrl = decodeUnknownOrNull(browserUrlSchema, requestedUrl)

        if (!parsedUrl) {
          return yield* Effect.fail(
            new DomainError(
              'INVALID_BROWSER_URL',
              'Enter an absolute HTTP, HTTPS, or local file URL without credentials',
              400
            )
          )
        }

        const url = new URL(parsedUrl).href

        const [existing] = yield* database
          .execute('app.service.380', (db) =>
            db
              .select()
              .from(browserApps)
              .where(
                and(
                  eq(browserApps.worktreeId, targetWorktreeId),
                  eq(browserApps.url, url)
                )
              )
              .orderBy(desc(browserApps.createdAt), desc(browserApps.id))
              .limit(1)
          )
          .pipe(Effect.orDie)
          .pipe(Effect.withSpan('treeport.browser.open.lookup_app'))

        existingApp = existing ? mapBrowserApp(existing) : null
      }

      const app =
        existingApp ??
        (yield* createBrowserApp(targetWorktreeId, requestedUrl).pipe(
          Effect.withSpan('treeport.browser.open.create_app')
        ))

      yield* Effect.annotateCurrentSpan({
        'treeport.app.id': app.id,
        'treeport.browser.app_reused': existingApp !== null
      })
      yield* Effect.sync(() =>
        events.publish('app.open_requested', {
          worktreeId: targetWorktreeId,
          appId: app.id,
          app,
          sourceTerminalId,
          sourceAppId,
          requestId
        })
      ).pipe(Effect.withSpan('treeport.browser.open.publish'))

      return { app }
    }).pipe(Effect.withSpan('treeport.browser.open'))
  }

  openBrowserAppFromTerminal(
    terminalId: string,
    requestedUrl: string,
    requestId: string | null = null
  ): AppEffect<OpenBrowserAppResult> {
    return this.openBrowserApp(
      null,
      requestedUrl,
      terminalId,
      null,
      true,
      requestId
    )
  }

  openBrowserAppFromApp(
    appId: string,
    requestedUrl: string
  ): AppEffect<OpenBrowserAppResult> {
    return this.openBrowserApp(null, requestedUrl, null, appId)
  }

  getBrowserApp(appId: string): AppEffect<BrowserApp> {
    const requireAvailableWorktree = this.requireBrowserWorktree.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort

      const [row] = yield* database
        .execute('app.service.446', (db) =>
          db
            .select()
            .from(browserApps)
            .where(eq(browserApps.id, appId))
            .limit(1)
        )
        .pipe(Effect.orDie)

      if (!row) {
        return yield* Effect.fail(
          new DomainError('APP_NOT_FOUND', 'Browser not found', 404)
        )
      }

      yield* requireAvailableWorktree(row.worktreeId)

      return mapBrowserApp(row)
    })
  }

  authorizeBrowserApp(
    appId: string
  ): AppEffect<{ app: BrowserApp; worktreePath: string }> {
    const getBrowserApp = this.getBrowserApp.bind(this)
    const getWorktree = this.getWorktree.bind(this)

    return Effect.gen(function* () {
      const app = yield* getBrowserApp(appId)
      const worktree = yield* getWorktree(app.worktreeId)

      return { app, worktreePath: worktree.path }
    })
  }

  updateBrowserAppState(
    appId: string,
    state: { url: string; title: string }
  ): AppEffect<BrowserApp> {
    const getBrowserApp = this.getBrowserApp.bind(this)

    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const app = yield* getBrowserApp(appId)

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

      if (app.url === url && app.title === title) {
        return app
      }

      const observedAt = now()

      const updatedAt =
        observedAt > app.updatedAt
          ? observedAt
          : new Date(Date.parse(app.updatedAt) + 1).toISOString()

      yield* database
        .execute('app.service.518', (db) =>
          db
            .update(browserApps)
            .set({ url, title, updatedAt })
            .where(eq(browserApps.id, appId))
        )
        .pipe(Effect.orDie)
      const updated = { ...app, url, title, updatedAt }
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('app.updated', {
          worktreeId: app.worktreeId,
          appId
        })
      })

      return updated
    })
  }

  deleteBrowserApp(appId: string): AppEffect<void> {
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort

      const [row] = yield* database
        .execute('app.service.543', (db) =>
          db
            .select()
            .from(browserApps)
            .where(eq(browserApps.id, appId))
            .limit(1)
        )
        .pipe(Effect.orDie)
        .pipe(Effect.withSpan('treeport.browser.remove.lookup'))

      if (!row) {
        return yield* Effect.fail(
          new DomainError('APP_NOT_FOUND', 'Browser not found', 404)
        )
      }

      yield* Effect.annotateCurrentSpan({
        'treeport.worktree.id': row.worktreeId
      })
      yield* database
        .execute('app.service.559', (db) =>
          db.delete(browserApps).where(eq(browserApps.id, appId))
        )
        .pipe(Effect.orDie)
        .pipe(Effect.withSpan('treeport.browser.remove.persist'))
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('app.removed', {
          worktreeId: row.worktreeId,
          appId
        })
      })
    }).pipe(
      Effect.withSpan('treeport.browser.remove', {
        attributes: { 'treeport.app.id': appId }
      })
    )
  }

  deleteApp(appId: string, discardStoredData = false): AppEffect<void> {
    const deleteBrowserApp = this.deleteBrowserApp.bind(this)
    const deleteWebApp = this.deleteWebApp.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort

      const [browserApp] = yield* database
        .execute('app.service.582', (db) =>
          db
            .select({ id: browserApps.id })
            .from(browserApps)
            .where(eq(browserApps.id, appId))
            .limit(1)
        )
        .pipe(Effect.orDie)
        .pipe(Effect.withSpan('treeport.app.remove.resolve_kind'))

      yield* Effect.annotateCurrentSpan({
        'treeport.app.kind': browserApp ? 'browser' : 'web'
      })

      return yield* browserApp
        ? deleteBrowserApp(appId)
        : deleteWebApp(appId, discardStoredData)
    }).pipe(
      Effect.withSpan('treeport.app.remove', {
        attributes: { 'treeport.app.id': appId }
      })
    )
  }

  createWebApp(
    worktreeId: string,
    definitionId: string,
    launch: WebAppLaunch = { input: null, cwd: null }
  ): AppEffect<WebApp> {
    const requireAvailableWorktree = this.requireAvailableWorktree.bind(this)

    const effectiveWebAppDefinitions =
      this.effectiveWebAppDefinitions.bind(this)

    const requireWebAppPermissions = this.requireWebAppPermissions.bind(this)
    const createValidatedWebApp = this.createValidatedWebApp.bind(this)

    return Effect.gen(function* () {
      const worktree = yield* requireAvailableWorktree(worktreeId)

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

      yield* requireWebAppPermissions(worktreeId, definition)

      return yield* createValidatedWebApp(worktree, definition, launch)
    })
  }

  private createValidatedWebApp(
    worktree: WorktreeRecord,
    definition: WebAppDefinition,
    launch: WebAppLaunch
  ): AppEffect<WebApp> {
    const normalizeWebAppLaunch = this.normalizeWebAppLaunch.bind(this)

    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const worktreeId = worktree.id
      const definitionId = definition.id
      const normalized = yield* normalizeWebAppLaunch(worktree, launch)
      const timestamp = now()

      const app: WebApp = {
        id: id('app'),
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
        .execute('app.service.663', (db) =>
          db.insert(webApps).values({
            id: app.id,
            worktreeId: app.worktreeId,
            definitionId: app.definitionId,
            title: app.title,
            inputJson: normalized.inputJson,
            launchCwd: app.launch.cwd,
            createdAt: app.createdAt,
            updatedAt: app.updatedAt
          })
        )
        .pipe(Effect.orDie)
        .pipe(Effect.withSpan('treeport.web_app.create.persist'))
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('app.created', { worktreeId, appId: app.id })
      })
      yield* Effect.annotateCurrentSpan({ 'treeport.app.id': app.id })

      return app
    }).pipe(Effect.withSpan('treeport.web_app.create'))
  }

  openWebApp(
    worktreeId: string,
    definitionId: string,
    launch: WebAppLaunch = { input: null, cwd: null },
    newInstance = false,
    sourceTerminalId: string | null = null,
    requestId: string | null = null
  ): AppEffect<OpenWebAppResult> {
    const requireAvailableWorktree = this.requireAvailableWorktree.bind(this)

    const effectiveWebAppDefinitions =
      this.effectiveWebAppDefinitions.bind(this)

    const requireWebAppPermissions = this.requireWebAppPermissions.bind(this)
    const createValidatedWebApp = this.createValidatedWebApp.bind(this)
    const normalizeWebAppLaunch = this.normalizeWebAppLaunch.bind(this)

    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const worktree = yield* requireAvailableWorktree(worktreeId)

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

      yield* requireWebAppPermissions(worktreeId, definition)

      const finish = (result: OpenWebAppResult): OpenWebAppResult => {
        events.publish('app.open_requested', {
          worktreeId,
          appId: result.app.id,
          app: result.app,
          sourceTerminalId,
          sourceAppId: null,
          requestId
        })

        return result
      }

      if (newInstance) {
        return finish({
          app: yield* createValidatedWebApp(worktree, definition, launch),
          created: true,
          reused: false
        })
      }

      const [existing] = yield* database
        .execute('app.service.740', (db) =>
          db
            .select()
            .from(webApps)
            .where(
              and(
                eq(webApps.worktreeId, worktreeId),
                eq(webApps.definitionId, definitionId)
              )
            )
            .orderBy(desc(webApps.createdAt), desc(webApps.id))
            .limit(1)
        )
        .pipe(Effect.orDie)
        .pipe(Effect.withSpan('treeport.web_app.open.lookup'))

      if (!existing) {
        return finish({
          app: yield* createValidatedWebApp(worktree, definition, launch),
          created: true,
          reused: false
        })
      }

      const normalized = yield* normalizeWebAppLaunch(worktree, launch)
      const observedAt = now()

      const updatedAt =
        observedAt > existing.updatedAt
          ? observedAt
          : new Date(Date.parse(existing.updatedAt) + 1).toISOString()

      yield* database
        .execute('app.service.767', (db) =>
          db
            .update(webApps)
            .set({
              title: definition.title,
              inputJson: normalized.inputJson,
              launchCwd: normalized.launch.cwd,
              updatedAt
            })
            .where(eq(webApps.id, existing.id))
        )
        .pipe(Effect.orDie)
        .pipe(Effect.withSpan('treeport.web_app.open.persist'))

      const app = mapWebApp(
        {
          ...existing,
          title: definition.title,
          inputJson: normalized.inputJson,
          launchCwd: normalized.launch.cwd,
          updatedAt
        },
        definition.permissions,
        true,
        definition.sandbox.enabled
      )

      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('app.updated', { worktreeId, appId: app.id })
      })

      return finish({ app, created: false, reused: true })
    }).pipe(
      Effect.tap((result) =>
        Effect.annotateCurrentSpan({
          'treeport.app.id': result.app.id,
          'treeport.worktree.id': worktreeId,
          'treeport.web_app.reused': result.reused
        })
      ),
      Effect.withSpan('treeport.web_app.open')
    )
  }

  deleteWebApp(appId: string, discardStoredData = false): AppEffect<void> {
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort

      const [app] = yield* database
        .execute('app.service.816', (db) =>
          db.select().from(webApps).where(eq(webApps.id, appId)).limit(1)
        )
        .pipe(Effect.orDie)
        .pipe(Effect.withSpan('treeport.web_app.remove.lookup'))

      if (!app) {
        return yield* Effect.fail(
          new DomainError('APP_NOT_FOUND', 'App not found', 404)
        )
      }

      yield* Effect.annotateCurrentSpan({
        'treeport.worktree.id': app.worktreeId
      })

      const [storedValue] = yield* database
        .execute('app.service.832', (db) =>
          db
            .select({ key: webAppStorage.key })
            .from(webAppStorage)
            .where(eq(webAppStorage.appId, appId))
            .limit(1)
        )
        .pipe(Effect.orDie)
        .pipe(Effect.withSpan('treeport.web_app.remove.storage_check'))

      if (!discardStoredData && storedValue) {
        return yield* Effect.fail(
          new DomainError(
            'APP_HAS_STORED_DATA',
            'Closing this app requires confirmation because its saved data will be deleted',
            409
          )
        )
      }

      yield* database
        .execute('app.service.849', (db) =>
          db.delete(webApps).where(eq(webApps.id, appId))
        )
        .pipe(Effect.orDie)
        .pipe(Effect.withSpan('treeport.web_app.remove.persist'))
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('app.removed', {
          worktreeId: app.worktreeId,
          appId
        })
      })
    }).pipe(
      Effect.withSpan('treeport.web_app.remove', {
        attributes: { 'treeport.app.id': appId }
      })
    )
  }

  requireWebAppTreeFiles(
    appId: string
  ): AppEffect<{ project: ProjectRecord; worktree: WorktreeRecord }> {
    const effectiveWebAppDefinitions =
      this.effectiveWebAppDefinitions.bind(this)

    const requireWebAppPermissions = this.requireWebAppPermissions.bind(this)
    const requireAvailableWorktree = this.requireAvailableWorktree.bind(this)
    const getProject = this.getProject.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort

      const [app] = yield* database
        .execute('app.service.878', (db) =>
          db.select().from(webApps).where(eq(webApps.id, appId)).limit(1)
        )
        .pipe(Effect.orDie)

      if (!app) {
        return yield* Effect.fail(
          new DomainError('APP_NOT_FOUND', 'App not found', 404)
        )
      }

      const definition = (yield* effectiveWebAppDefinitions(
        app.worktreeId
      )).find((candidate) => candidate.id === app.definitionId)

      if (!definition) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_APP_DEFINITION_NOT_FOUND',
            'The definition for this app is unavailable',
            404
          )
        )
      }

      yield* requireWebAppPermissions(app.worktreeId, definition)

      if (!definition.permissions.includes('tree-files')) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_APP_TREE_FILES_REQUIRED',
            'This app does not have permission to access tree files',
            403
          )
        )
      }

      const worktree = yield* requireAvailableWorktree(app.worktreeId)
      const project = yield* getProject(worktree.projectId)

      return { project, worktree }
    })
  }

  getWebAppServiceContext(
    appId: string
  ): AppEffect<{ packageRoot: string; treePath: string }> {
    return Effect.gen(this, function* () {
      const context = yield* this.getWebAppContext(appId)
      const worktree = yield* this.requireAvailableWorktree(context.worktree.id)

      const definition = (yield* this.effectiveWebAppDefinitions(
        worktree.id
      )).find((candidate) => candidate.id === context.app.definitionId)

      if (!definition) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_APP_DEFINITION_NOT_FOUND',
            'The definition for this app is unavailable',
            404
          )
        )
      }

      return { packageRoot: definition.packageRoot, treePath: worktree.path }
    })
  }

  getWebAppContext(appId: string): AppEffect<WebAppContext> {
    const effectiveWebAppDefinitions =
      this.effectiveWebAppDefinitions.bind(this)

    const webAppPermissionsGranted = this.webAppPermissionsGranted.bind(this)
    const getWorktree = this.getWorktree.bind(this)
    const getProject = this.getProject.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort

      const [appRow] = yield* database
        .execute('app.service.931', (db) =>
          db.select().from(webApps).where(eq(webApps.id, appId)).limit(1)
        )
        .pipe(Effect.orDie)

      if (!appRow) {
        return yield* Effect.fail(
          new DomainError('APP_NOT_FOUND', 'App not found', 404)
        )
      }

      const definition = (yield* effectiveWebAppDefinitions(
        appRow.worktreeId
      )).find((candidate) => candidate.id === appRow.definitionId)

      const permissionsGranted = definition
        ? yield* webAppPermissionsGranted(appRow.worktreeId, definition)
        : false

      const app = mapWebApp(
        appRow,
        definition?.permissions ?? [],
        permissionsGranted,
        definition?.sandbox.enabled ?? true
      )

      const worktree = yield* getWorktree(app.worktreeId)
      const project = yield* getProject(worktree.projectId)

      return {
        apiVersion: 1,
        app,
        launch: app.launch,
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

  getWebAppDiff(appId: string, scope?: GitDiffRequest['scope']) {
    const getWebAppContext = this.getWebAppContext.bind(this)
    const getWorktree = this.getWorktree.bind(this)

    return Effect.gen(function* () {
      const git = yield* GitPort
      const context = yield* getWebAppContext(appId)

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

      const worktree = yield* getWorktree(context.app.worktreeId)

      return yield* git
        .worktreeDiff(worktree.path, context.project.defaultBranch!, scope)
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

  getWebAppFileDiff(
    appId: string,
    filePath: string,
    scope?: GitDiffRequest['scope']
  ) {
    const getWebAppContext = this.getWebAppContext.bind(this)
    const getWorktree = this.getWorktree.bind(this)

    return Effect.gen(function* () {
      const git = yield* GitPort
      const context = yield* getWebAppContext(appId)

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

      const worktree = yield* getWorktree(context.app.worktreeId)

      return yield* git
        .worktreeFileDiff(
          worktree.path,
          context.project.defaultBranch,
          filePath,
          scope
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

  getWebAppDiffImage(appId: string, input: GitDiffImageRequest) {
    const getWebAppContext = this.getWebAppContext.bind(this)
    const requireAvailableWorktree = this.requireAvailableWorktree.bind(this)

    return Effect.gen(function* () {
      const git = yield* GitPort
      const context = yield* getWebAppContext(appId)

      if (context.project.kind !== 'repository') {
        return yield* Effect.fail(
          new DomainError(
            'GIT_NOT_AVAILABLE',
            'Git images are not available for a folder project',
            409
          )
        )
      }

      const worktree = yield* requireAvailableWorktree(context.app.worktreeId)

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

  getBrowserAppListeners(appId: string): AppEffect<WorktreeListenerDiscovery> {
    const getBrowserApp = this.getBrowserApp.bind(this)
    const getWorktree = this.getWorktree.bind(this)

    return Effect.gen(function* () {
      const terminalHost = yield* TerminalHostPort
      const networkListeners = yield* NetworkListenerPort
      const app = yield* getBrowserApp(appId)
      const worktree = yield* getWorktree(app.worktreeId)

      const terminalProcesses = yield* terminalHost
        .listProcesses(worktree.id)
        .pipe(Effect.orDie)

      return yield* networkListeners
        .listeners({ worktreePath: worktree.path, terminalProcesses })
        .pipe(Effect.orDie)
    })
  }

  getAppListeners(appId: string): AppEffect<WorktreeListenerDiscovery> {
    const getBrowserAppListeners = this.getBrowserAppListeners.bind(this)
    const getWebAppListeners = this.getWebAppListeners.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort

      const [browserApp] = yield* database
        .execute('app.service.1065', (db) =>
          db
            .select({ id: browserApps.id })
            .from(browserApps)
            .where(eq(browserApps.id, appId))
            .limit(1)
        )
        .pipe(Effect.orDie)

      return yield* browserApp
        ? getBrowserAppListeners(appId)
        : getWebAppListeners(appId)
    })
  }

  getWebAppListeners(appId: string): AppEffect<WorktreeListenerDiscovery> {
    const getWebAppContext = this.getWebAppContext.bind(this)
    const getWorktree = this.getWorktree.bind(this)

    return Effect.gen(function* () {
      const terminalHost = yield* TerminalHostPort
      const networkListeners = yield* NetworkListenerPort
      const context = yield* getWebAppContext(appId)
      const worktree = yield* getWorktree(context.app.worktreeId)

      const terminalProcesses = yield* terminalHost
        .listProcesses(worktree.id)
        .pipe(Effect.orDie)

      return yield* networkListeners
        .listeners({ worktreePath: worktree.path, terminalProcesses })
        .pipe(Effect.orDie)
    })
  }

  hasWebAppStorage(appId: string): AppEffect<boolean> {
    const getWebAppContext = this.getWebAppContext.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      yield* getWebAppContext(appId)

      const [row] = yield* database
        .execute('app.service.1107', (db) =>
          db
            .select({ key: webAppStorage.key })
            .from(webAppStorage)
            .where(eq(webAppStorage.appId, appId))
            .limit(1)
        )
        .pipe(Effect.orDie)

      return row !== undefined
    })
  }

  getWebAppStorage(
    appId: string,
    key: string,
    scope: WebAppStorageScope = 'instance'
  ): AppEffect<JsonValue | undefined> {
    const getWebAppContext = this.getWebAppContext.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const context = yield* getWebAppContext(appId)

      const owner =
        scope === 'definition'
          ? eq(webAppStorage.definitionId, context.app.definitionId)
          : eq(webAppStorage.appId, appId)

      const [row] = yield* database
        .execute('app.service.1127', (db) =>
          db
            .select({ valueJson: webAppStorage.valueJson })
            .from(webAppStorage)
            .where(and(owner, eq(webAppStorage.key, key)))
            .limit(1)
        )
        .pipe(Effect.orDie)

      // SAFETY: Storage writes only JSON.stringify a JsonValue into valueJson.
      return row ? (JSON.parse(row.valueJson) as JsonValue) : undefined
    })
  }

  setWebAppStorage(
    appId: string,
    key: string,
    value: JsonValue,
    scope: WebAppStorageScope = 'instance'
  ): AppEffect<void> {
    const getWebAppContext = this.getWebAppContext.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const context = yield* getWebAppContext(appId)

      const owner =
        scope === 'definition'
          ? eq(webAppStorage.definitionId, context.app.definitionId)
          : eq(webAppStorage.appId, appId)

      const valueJson = JSON.stringify(value)
      const valueBytes = Buffer.byteLength(valueJson)

      if (valueBytes > WEB_APP_STORAGE_MAX_VALUE_BYTES) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_APP_STORAGE_VALUE_TOO_LARGE',
            'Web app storage values are limited to 64 KiB',
            413
          )
        )
      }

      const storedValues = yield* database
        .execute('app.service.1166', (db) =>
          db
            .select({ valueJson: webAppStorage.valueJson })
            .from(webAppStorage)
            .where(and(owner, ne(webAppStorage.key, key)))
        )
        .pipe(Effect.orDie)

      const storedBytes = storedValues.reduce(
        (total, row) => total + Buffer.byteLength(row.valueJson),
        0
      )

      if (
        storedValues.length >= WEB_APP_STORAGE_MAX_ENTRIES ||
        storedBytes + valueBytes > WEB_APP_STORAGE_MAX_TOTAL_BYTES
      ) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_APP_STORAGE_QUOTA_EXCEEDED',
            'Web app storage is limited to 256 values and 1 MiB per scope',
            413
          )
        )
      }

      const updatedAt = now()
      yield* database
        .execute('app.service.1195', (db) =>
          db
            .insert(webAppStorage)
            .values({
              appId: scope === 'instance' ? appId : null,
              definitionId:
                scope === 'definition' ? context.app.definitionId : null,
              key,
              valueJson,
              updatedAt
            })
            .onConflictDoUpdate({
              target: [
                scope === 'definition'
                  ? webAppStorage.definitionId
                  : webAppStorage.appId,
                webAppStorage.key
              ],
              set: { valueJson, updatedAt }
            })
        )
        .pipe(Effect.orDie)
    })
  }

  deleteWebAppStorage(
    appId: string,
    key: string,
    scope: WebAppStorageScope = 'instance'
  ): AppEffect<void> {
    const getWebAppContext = this.getWebAppContext.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const context = yield* getWebAppContext(appId)

      const owner =
        scope === 'definition'
          ? eq(webAppStorage.definitionId, context.app.definitionId)
          : eq(webAppStorage.appId, appId)

      yield* database
        .execute('app.service.1213', (db) =>
          db.delete(webAppStorage).where(and(owner, eq(webAppStorage.key, key)))
        )
        .pipe(Effect.orDie)
    })
  }

  resolveWebAppAsset(
    appId: string,
    requestedPath: string
  ): AppEffect<WebAppAssetResolution> {
    const effectiveWebAppDefinitions =
      this.effectiveWebAppDefinitions.bind(this)

    const requireWebAppPermissions = this.requireWebAppPermissions.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const webAppRuntime = yield* WebAppRuntimePort
      yield* Effect.annotateCurrentSpan({ 'treeport.app.id': appId })

      const [app] = yield* database
        .execute('app.service.1239', (db) =>
          db.select().from(webApps).where(eq(webApps.id, appId)).limit(1)
        )
        .pipe(Effect.orDie)

      if (!app) {
        return yield* Effect.fail(
          new DomainError('APP_NOT_FOUND', 'App not found', 404)
        )
      }

      const definition = (yield* effectiveWebAppDefinitions(
        app.worktreeId
      )).find((candidate) => candidate.id === app.definitionId)

      if (!definition) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_APP_DEFINITION_NOT_FOUND',
            'The definition for this app is unavailable',
            404
          )
        )
      }

      yield* requireWebAppPermissions(app.worktreeId, definition)
      const encodedAppId = encodeURIComponent(appId)

      return yield* webAppRuntime
        .resolve(
          definition,
          requestedPath,
          `/api/web-apps/${encodedAppId}/assets/`
        )
        .pipe(
          Effect.catchTag('WebAppRuntimeError', Effect.die),
          Effect.tap((result) =>
            Effect.annotateCurrentSpan({
              'treeport.web_app.development': result.development,
              'treeport.web_app.resolution': result.kind
            })
          ),
          Effect.withSpan('treeport.web_app.runtime.resolve')
        )
    }).pipe(Effect.withSpan('treeport.web_app.asset'))
  }

  listBrowserApps(): AppEffect<BrowserApp[]> {
    return Effect.gen(function* () {
      const database = yield* DatabasePort

      const rows = yield* database
        .execute('app.service.1291', (db) =>
          db
            .select()
            .from(browserApps)
            .orderBy(asc(browserApps.createdAt), asc(browserApps.id))
        )
        .pipe(Effect.orDie)

      return rows.map(mapBrowserApp)
    })
  }

  listWebApps(): AppEffect<WebApp[]> {
    const effectiveWebAppDefinitions =
      this.effectiveWebAppDefinitions.bind(this)

    const webAppPermissionsGranted = this.webAppPermissionsGranted.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort

      const rows = yield* database
        .execute('app.service.1309', (db) =>
          db
            .select()
            .from(webApps)
            .orderBy(asc(webApps.createdAt), asc(webApps.id))
        )
        .pipe(Effect.orDie)

      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const definitions = yield* Effect.catchAll(
            effectiveWebAppDefinitions(row.worktreeId),
            () => Effect.succeed([])
          )

          const definition = definitions.find(
            (candidate) => candidate.id === row.definitionId
          )

          return mapWebApp(
            row,
            definition?.permissions ?? [],
            definition
              ? yield* webAppPermissionsGranted(row.worktreeId, definition)
              : false,
            definition?.sandbox.enabled ?? true
          )
        })
      )
    })
  }
}

function mapBrowserApp(row: typeof browserApps.$inferSelect): BrowserApp {
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

function mapWebApp(
  row: typeof webApps.$inferSelect,
  permissions: WebAppPermission[] = [],
  permissionsGranted = permissions.length === 0,
  sandboxEnabled = true
): WebApp {
  const parsedInput = decodeUnknownOrNull(
    Schema.NullOr(webAppInputSchema),
    JSON.parse(row.inputJson)
  )

  if (parsedInput === null && row.inputJson !== 'null') {
    throw new Error(`Web app ${row.id} has invalid stored launch input`)
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
      enabled: sandboxEnabled,
      allowSameOrigin:
        !sandboxEnabled ||
        (permissionsGranted && permissions.includes('same-origin'))
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}
