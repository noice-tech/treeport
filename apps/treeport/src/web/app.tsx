import type { DesktopBrowserPermissionPrompt } from '@treeport/desktop-bridge'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import type {
  BrowserApp,
  ProductEventDataMap,
  ProjectRecord,
  RemoveOperationRecord,
  RemovePreview,
  TerminalRecord,
  WebApp,
  WebAppDefinition,
  WebAppInput,
  WorktreeRecord
} from '@treeport/shared'
import { registerBrowserOpen, traceBrowserOpen } from './browser-open-tracing'
import {
  beginWebAppOpen,
  registerWebAppOpen,
  traceWebAppOpen
} from './web-app-open-tracing'
import { NotificationCenter } from './features/notifications/notification-center'
import { TerminalBellAttention } from './features/notifications/terminal-bell-attention'
import { CloseAppDialog } from './features/apps/close-app-dialog'
import { parseResponse, rpc } from './api'
import { OpenProjectDialog } from './features/projects/open-project-dialog'
import { useProjectWorkflows } from './features/projects/project-workflows'
import {
  ProjectSwitcher,
  ProjectSwitcherShortcut
} from './features/sidebar/project-switcher'
import {
  WorkspaceMobileHeader,
  WorkspaceSidebar
} from './features/sidebar/workspace-sidebar'
import { WorkspaceTree } from './features/sidebar/workspace-tree'
import {
  useProjectSwitcher,
  WorkspaceMain,
  WorkspaceShell
} from './features/sidebar/workspace-shell'
import { TerminalPresetsDialog } from './features/terminal-presets/terminal-presets-dialog'
import { UpdateControl } from './features/updates/update-control'
import { NewAppDialog } from './features/apps/new-app-dialog'
import { useToolPicker } from './features/apps/tool-picker-context'
import { useWorkspaceSurfaceFocus } from './features/apps/workspace-surface-focus-context'
import {
  AppsPanelToggle,
  WorktreeAppsPanel
} from './features/apps/worktree-apps-panel'
import {
  TerminalWorkspace,
  useTerminalWorkflows
} from './features/terminals/terminal-workspace'
import type { TerminalSplitDirection } from './features/terminals/terminal-workspace-layout'
import { CreateWorktreeDialog } from './features/worktrees/create-worktree-dialog'
import { RemoveWorktreeDialog } from './features/worktrees/remove-worktree-dialog'
import {
  useWorktreeWorkflows,
  type RemovalWorktree
} from './features/worktrees/worktree-workflows'
import { useWorktreeRemovals } from './features/worktrees/use-worktree-removals'
import { useSidebar } from './components/ui/sidebar'
import { METADATA_DEGRADED_GRACE_MS } from './metadata-sync'
import { notifyError } from './features/notifications/error-notifications'
import { useProjectEventsBridge } from './project-events-bridge'
import { useWorkspacePresence } from './features/presence/use-workspace-presence'
import { WorkspaceViewers } from './features/presence/workspace-viewers'
import {
  projectsQueryOptions,
  terminalPresetDefinitionsQueryOptions,
  terminalPresetsQueryOptions,
  treeContextFieldsQueryOptions
} from './project-metadata'
import {
  LAST_PROJECT_TERMINAL_STORAGE_PREFIX,
  LAST_WORKSPACE_ROUTE_STORAGE_KEY,
  openRequestMatchesTerminal,
  openRequestMatchesWorkspace,
  resolveWorkspaceRoute,
  targetForProject,
  targetForApp,
  targetForTerminal,
  targetForWorktree
} from './workspace-navigation'
import { useWorkspaceNavigate } from './workspace-router-navigation'
import { ForceSpecificCursor } from './force-specific-cursor'
import { terminalSessions } from './terminal-session'
import { WorkspaceWindowTitle } from './workspace-window-title'
import { errorDetails } from './error-message'
import { cn } from './lib/utils'
import { browserTrace, newBrowserCorrelationId } from './agent-tracing'

import { LoadingFallback } from './loading-fallback'

const BrowserAppWorkspace = lazy(() =>
  import('./features/browser-apps/browser-app-workspace').then((module) => ({
    default: module.BrowserAppWorkspace
  }))
)
const WebAppWorkspace = lazy(() =>
  import('./features/web-apps/web-app-workspace').then((module) => ({
    default: module.WebAppWorkspace
  }))
)

const APPS_PANEL_OPEN_STORAGE_PREFIX = 'treeport-tool-pane-open:'

type CloseAppReason =
  | 'browser-before-unload'
  | 'stored-data'
  | 'unsaved-changes'

type AppDialog =
  | { type: 'project' }
  | { type: 'worktree'; project: ProjectRecord }
  | { type: 'app'; projectId: string; worktreeId: string | null }
  | { type: 'presets' }
  | {
      type: 'remove'
      worktree: RemovalWorktree
      preview: RemovePreview
      operation: RemoveOperationRecord | null
      skipCleanup: boolean
    }
  | {
      type: 'close-app'
      app: BrowserApp | WebApp
      reason: CloseAppReason
    }
  | null

interface DeleteAppQuery {
  discardStoredData?: string
  force?: string
}

export default function App() {
  return (
    <>
      <WorkspaceShell>
        <WorkspaceApp />
      </WorkspaceShell>
      <ForceSpecificCursor />
    </>
  )
}

function WorkspaceApp() {
  const { dismiss: dismissToolPicker } = useToolPicker()
  const {
    focusedSurface,
    focusedSurfaceRef,
    focusSurface,
    restoreEmptyToolFocus
  } = useWorkspaceSurfaceFocus()
  const desktopBridge = window.treeportDesktop
  const navigateToWorkspace = useWorkspaceNavigate()
  const queryClient = useQueryClient()
  const location = useLocation()
  const projectsQuery = useQuery(projectsQueryOptions)
  const removals = useWorktreeRemovals()
  const projects = useMemo(
    () =>
      (projectsQuery.data ?? []).map((project) => ({
        ...project,
        worktrees: project.worktrees.filter(
          (worktree) => !removals.hiddenWorktreeIds.has(worktree.id)
        )
      })),
    [projectsQuery.data, removals.hiddenWorktreeIds]
  )
  const presetsQuery = useQuery(terminalPresetsQueryOptions)
  const presets = presetsQuery.data ?? []
  const storedResumePath = localStorage.getItem(
    LAST_WORKSPACE_ROUTE_STORAGE_KEY
  )
  const workspaceResolution =
    projectsQuery.data && removals.ready
      ? resolveWorkspaceRoute(projects, location.pathname, storedResumePath)
      : null
  const selectedProject = workspaceResolution?.selection.project ?? null
  const selectedWorktree = workspaceResolution?.selection.worktree ?? null
  const selectedTerminal =
    workspaceResolution?.selection.terminal ??
    selectedWorktree?.terminals.find(
      (terminal) =>
        terminal.id ===
        localStorage.getItem(
          `${LAST_PROJECT_TERMINAL_STORAGE_PREFIX}${selectedProject?.id}`
        )
    ) ??
    selectedWorktree?.terminals[0] ??
    null
  const selectedTerminalId = selectedTerminal?.id ?? null
  const selectedApp = workspaceResolution?.selection.app ?? null
  const activeProject = selectedProject
  const {
    isMobile,
    openMobile: drawerOpen,
    setOpenMobile: setDrawerOpen,
    closeMobileWithoutFocusRestore: closeDrawerAfterNavigation
  } = useSidebar()
  const projectSwitcher = useProjectSwitcher()
  const projectSwitcherOpen = projectSwitcher.open
  const [dialog, setDialog] = useState<AppDialog>(null)
  const [desktopNotificationsOpen, setDesktopNotificationsOpen] =
    useState(false)
  const [mobileNotificationsOpen, setMobileNotificationsOpen] = useState(false)
  const [browserPermissionPrompt, setBrowserPermissionPrompt] =
    useState<DesktopBrowserPermissionPrompt | null>(null)
  useEffect(
    () =>
      desktopBridge?.onBrowserPermissionPrompt?.(setBrowserPermissionPrompt),
    [desktopBridge]
  )
  const workspaceActionsBlocked =
    dialog !== null || projectSwitcherOpen || (isMobile && drawerOpen)
  const [retainedAppIds, setRetainedAppIds] = useState<Set<string>>(
    () => new Set()
  )
  const [appsPanelOpenByWorktree, setAppsPanelOpenByWorktree] = useState<
    Record<string, boolean>
  >({})
  const [fullViewWorktreeId, setFullViewWorktreeId] = useState<string | null>(
    null
  )
  useEffect(() => {
    setFullViewWorktreeId(null)
  }, [selectedWorktree?.id])
  const setAppsPanelOpen = useCallback((worktreeId: string, open: boolean) => {
    if (!open) {
      setFullViewWorktreeId(null)
    }

    setAppsPanelOpenByWorktree((current) =>
      current[worktreeId] === open
        ? current
        : { ...current, [worktreeId]: open }
    )
    localStorage.setItem(
      `${APPS_PANEL_OPEN_STORAGE_PREFIX}${worktreeId}`,
      String(open)
    )
  }, [])
  const appsPanelOpen = selectedWorktree
    ? (appsPanelOpenByWorktree[selectedWorktree.id] ??
      localStorage.getItem(
        `${APPS_PANEL_OPEN_STORAGE_PREFIX}${selectedWorktree.id}`
      ) === 'true')
    : false
  const appsPanelFullView =
    appsPanelOpen &&
    selectedWorktree !== null &&
    fullViewWorktreeId === selectedWorktree.id
  const [activeAppByWorktree, setActiveAppByWorktree] = useState<
    Record<string, string | null>
  >({})
  const [preserveTerminalFocusAppId, setPreserveTerminalFocusAppId] = useState<
    string | null
  >(null)
  const selectedWorktreeTools = useMemo(
    () =>
      selectedWorktree?.workspaceItems.filter(
        (app): app is BrowserApp | WebApp => app.kind !== 'terminal'
      ) ?? [],
    [selectedWorktree]
  )
  const reorderTerminals = useCallback(
    (worktree: WorktreeRecord, itemIds: string[]) => {
      queryClient.setQueryData<ProjectRecord[]>(
        projectsQueryOptions.queryKey,
        (current) =>
          current?.map((project) => ({
            ...project,
            worktrees: project.worktrees.map((candidate) => {
              if (candidate.id !== worktree.id) {
                return candidate
              }

              const terminalsById = new Map(
                candidate.terminals.map((terminal) => [terminal.id, terminal])
              )
              return {
                ...candidate,
                terminals: itemIds.map((terminalId) =>
                  terminalsById.get(terminalId)!
                )
              }
            })
          }))
      )
      void parseResponse(
        rpc.api.worktrees[':worktreeId'].terminals.order.$put({
          param: { worktreeId: worktree.id },
          json: { itemIds }
        })
      ).then(
        () =>
          queryClient.invalidateQueries({
            queryKey: projectsQueryOptions.queryKey
          }),
        (error) => {
          notifyError(error, {
            operation: `reorder terminals in tree “${worktree.name}”`
          })
          return queryClient.invalidateQueries({
            queryKey: projectsQueryOptions.queryKey
          })
        }
      )
    },
    [queryClient]
  )
  const reorderTools = useCallback(
    (itemIds: string[]) => {
      if (!selectedWorktree) {
        return
      }

      queryClient.setQueryData<ProjectRecord[]>(
        projectsQueryOptions.queryKey,
        (current) =>
          current?.map((project) => ({
            ...project,
            worktrees: project.worktrees.map((worktree) => {
              if (worktree.id !== selectedWorktree.id) {
                return worktree
              }

              const appsById = new Map(
                worktree.workspaceItems.map((app) => [app.id, app])
              )
              const orderedTools = itemIds.map((appId) => appsById.get(appId)!)
              let toolIndex = 0
              return {
                ...worktree,
                workspaceItems: worktree.workspaceItems.map((app) =>
                  app.kind === 'terminal' ? app : orderedTools[toolIndex++]!
                )
              }
            })
          }))
      )
      void parseResponse(
        rpc.api.worktrees[':worktreeId'].apps.order.$put({
          param: { worktreeId: selectedWorktree.id },
          json: { itemIds }
        })
      ).then(
        () =>
          queryClient.invalidateQueries({
            queryKey: projectsQueryOptions.queryKey
          }),
        (error) => {
          notifyError(error, {
            operation: `reorder tools in tree “${selectedWorktree.name}”`
          })
          return queryClient.invalidateQueries({
            queryKey: projectsQueryOptions.queryKey
          })
        }
      )
    },
    [queryClient, selectedWorktree]
  )
  const rememberedActiveApp = selectedWorktreeTools.find(
    (app) => app.id === activeAppByWorktree[selectedWorktree?.id ?? '']
  )
  const activeApp =
    selectedApp ??
    rememberedActiveApp ??
    (appsPanelOpen ? selectedWorktreeTools.at(-1) : null) ??
    null
  const activeAppId = activeApp?.id ?? null
  const retainApp = useCallback((appId: string) => {
    setRetainedAppIds((current) => {
      if (current.has(appId)) {
        return current
      }

      const next = new Set(current)
      next.add(appId)
      return next
    })
  }, [])
  const revealTool = useCallback(
    (app: BrowserApp | WebApp, preserveTerminalFocus: boolean) => {
      retainApp(app.id)
      setActiveAppByWorktree((current) => ({
        ...current,
        [app.worktreeId]: app.id
      }))
      setAppsPanelOpen(app.worktreeId, true)
      setPreserveTerminalFocusAppId(preserveTerminalFocus ? app.id : null)
    },
    [retainApp, setAppsPanelOpen]
  )
  const [webAppReloadRevisions, setWebAppReloadRevisions] = useState<
    Record<string, number>
  >({})
  const [webAppRuntimeTitles, setWebAppRuntimeTitles] = useState<
    Record<string, string>
  >({})
  const [dirtyWebAppIds, setDirtyWebAppIds] = useState<Set<string>>(
    () => new Set()
  )
  const setWebAppDirty = useCallback((appId: string, dirty: boolean) => {
    setDirtyWebAppIds((current) => {
      if (current.has(appId) === dirty) {
        return current
      }

      const next = new Set(current)
      if (dirty) {
        next.add(appId)
      } else {
        next.delete(appId)
      }

      return next
    })
  }, [])
  const [browserAppFavicons, setBrowserAppFavicons] = useState<
    Record<string, string | null>
  >({})
  const updateBrowserAppFavicon = useCallback(
    (appId: string, faviconUrl: string | null) => {
      setBrowserAppFavicons((current) =>
        (current[appId] ?? null) === faviconUrl
          ? current
          : { ...current, [appId]: faviconUrl }
      )
    },
    []
  )
  const [browserAppLoading, setBrowserAppLoading] = useState<
    Record<string, boolean>
  >({})
  const updateBrowserAppLoading = useCallback(
    (appId: string, loading: boolean) => {
      setBrowserAppLoading((current) => {
        if (Boolean(current[appId]) === loading) {
          return current
        }

        const next = { ...current }
        if (loading) {
          next[appId] = true
        } else {
          delete next[appId]
        }

        return next
      })
    },
    []
  )
  const setWebAppRuntimeTitle = useCallback(
    (appId: string, title: string | null) => {
      setWebAppRuntimeTitles((current) => {
        if (title === null) {
          if (current[appId] === undefined) {
            return current
          }

          const next = { ...current }
          delete next[appId]
          return next
        }

        return current[appId] === title
          ? current
          : { ...current, [appId]: title }
      })
    },
    []
  )
  useEffect(() => {
    const apps = projects.flatMap((project) =>
      project.worktrees.flatMap((worktree) => worktree.workspaceItems)
    )
    const appIds = new Set(apps.map((app) => app.id))
    const webAppIds = new Set(
      apps.filter((app) => app.kind === 'web').map((app) => app.id)
    )
    setWebAppRuntimeTitles((current) => {
      const removedIds = Object.keys(current).filter(
        (appId) => !webAppIds.has(appId)
      )
      if (removedIds.length === 0) {
        return current
      }

      const next = { ...current }
      removedIds.forEach((appId) => delete next[appId])
      return next
    })
    setBrowserAppFavicons((current) => {
      const removedIds = Object.keys(current).filter(
        (appId) => !appIds.has(appId)
      )
      if (removedIds.length === 0) {
        return current
      }

      const next = { ...current }
      removedIds.forEach((appId) => delete next[appId])
      return next
    })
    setBrowserAppLoading((current) => {
      const removedIds = Object.keys(current).filter(
        (appId) => !appIds.has(appId)
      )
      if (removedIds.length === 0) {
        return current
      }

      const next = { ...current }
      removedIds.forEach((appId) => delete next[appId])
      return next
    })
    setDirtyWebAppIds((current) => {
      const next = new Set([...current].filter((appId) => webAppIds.has(appId)))
      return next.size === current.size ? current : next
    })
  }, [projects])
  const appDialogProject =
    dialog?.type === 'app'
      ? (projects.find((project) => project.id === dialog.projectId) ?? null)
      : null
  const appDialogWorktree =
    dialog?.type === 'app' && dialog.worktreeId
      ? (appDialogProject?.worktrees.find(
          (worktree) => worktree.id === dialog.worktreeId
        ) ?? null)
      : null
  const webAppDefinitionsWorktree =
    appDialogWorktree ?? (appsPanelOpen ? selectedWorktree : null)
  const presetDefinitionsContext =
    dialog?.type === 'worktree'
      ? { projectId: dialog.project.id }
      : appDialogWorktree
        ? { worktreeId: appDialogWorktree.id }
        : selectedWorktree
          ? { worktreeId: selectedWorktree.id }
          : selectedProject
            ? { projectId: selectedProject.id }
            : undefined
  const presetDefinitionsQuery = useQuery(
    terminalPresetDefinitionsQueryOptions(presetDefinitionsContext)
  )
  const treeContextFieldsQuery = useQuery(
    treeContextFieldsQueryOptions(
      dialog?.type === 'worktree' ? dialog.project.id : null
    )
  )
  const availablePresets = presetDefinitionsQuery.data?.definitions ?? []
  const presetDiagnostics = presetDefinitionsQuery.data?.diagnostics ?? []
  const webAppDefinitionsQuery = useQuery({
    queryKey: ['web-app-definitions', webAppDefinitionsWorktree?.id],
    queryFn: async () =>
      (
        await parseResponse(
          rpc.api.worktrees[':worktreeId']['web-app-definitions'].$get({
            param: { worktreeId: webAppDefinitionsWorktree!.id }
          })
        )
      ).definitions,
    enabled: Boolean(webAppDefinitionsWorktree)
  })
  const createWebApp = useMutation({
    mutationFn: ({
      worktree,
      definition,
      input
    }: {
      worktree: WorktreeRecord
      definition: WebAppDefinition
      input: WebAppInput | null
    }) =>
      (async () => {
        const requestId = beginWebAppOpen()
        if (
          definition.permissions.length > 0 &&
          !definition.permissionsGranted
        ) {
          await parseResponse(
            rpc.api.worktrees[':worktreeId']['web-app-definitions'][
              ':definitionId'
            ]['permission-grant'].$put({
              param: {
                worktreeId: worktree.id,
                definitionId: definition.id
              },
              json: {
                granted: true,
                permissions: definition.permissions
              }
            })
          )
        }

        const result = await parseResponse(
          rpc.api.worktrees[':worktreeId'].apps.open.$post(
            {
              param: { worktreeId: worktree.id },
              json: {
                definitionId: definition.id,
                input,
                launchCwd: null
              }
            },
            { init: { headers: { 'x-request-id': requestId } } }
          )
        ).catch((error) => {
          browserTrace('web_app.open.request_failed', requestId)
          throw error
        })
        registerWebAppOpen(result.app.id, requestId)
        traceWebAppOpen(result.app.id, 'web_app.open.response', {
          reused: result.reused
        })
        return result.app
      })(),
    onSuccess: async (app, { worktree }) => {
      traceWebAppOpen(app.id, 'web_app.open.ui_requested')
      setDialog(null)
      revealTool(app, false)
      queryClient.setQueryData<ProjectRecord[]>(
        projectsQueryOptions.queryKey,
        (current) =>
          current?.map((project) =>
            project.id !== worktree.projectId
              ? project
              : {
                  ...project,
                  worktrees: project.worktrees.map((candidate) =>
                    candidate.id !== worktree.id ||
                    candidate.workspaceItems.some(
                      (existing) => existing.id === app.id
                    )
                      ? candidate
                      : {
                          ...candidate,
                          workspaceItems: [...candidate.workspaceItems, app]
                        }
                  )
                }
          )
      )
      const target = targetForApp(
        queryClient.getQueryData<ProjectRecord[]>(
          projectsQueryOptions.queryKey
        ) ?? projects,
        app
      )
      const navigation = target
        ? navigateToWorkspace(target)
        : Promise.resolve()
      void queryClient.invalidateQueries({
        queryKey: projectsQueryOptions.queryKey
      })
      await navigation
    },
    onError: (error, { worktree, definition }) => {
      notifyError(error, {
        operation: `create web app “${definition.title}” in tree “${worktree.name}”`
      })
    }
  })
  const createBrowserApp = useMutation({
    mutationFn: ({ worktree }: { worktree: WorktreeRecord }) =>
      parseResponse(
        rpc.api.worktrees[':worktreeId']['browser-apps'].$post({
          param: { worktreeId: worktree.id },
          json: {}
        })
      ),
    onSuccess: async ({ app }, { worktree }) => {
      setDialog(null)
      revealTool(app, false)
      queryClient.setQueryData<ProjectRecord[]>(
        projectsQueryOptions.queryKey,
        (current) =>
          current?.map((project) =>
            project.id !== worktree.projectId
              ? project
              : {
                  ...project,
                  worktrees: project.worktrees.map((candidate) =>
                    candidate.id !== worktree.id ||
                    candidate.workspaceItems.some(
                      (existing) => existing.id === app.id
                    )
                      ? candidate
                      : {
                          ...candidate,
                          workspaceItems: [...candidate.workspaceItems, app]
                        }
                  )
                }
          )
      )
      const target = targetForApp(
        queryClient.getQueryData<ProjectRecord[]>(
          projectsQueryOptions.queryKey
        ) ?? projects,
        app
      )
      const navigation = target
        ? navigateToWorkspace(target)
        : Promise.resolve()
      void queryClient.invalidateQueries({
        queryKey: projectsQueryOptions.queryKey
      })
      await navigation
    },
    onError: (error, { worktree }) => {
      notifyError(error, {
        operation: `create Browser in tree “${worktree.name}”`
      })
    }
  })
  const closeApp = useMutation({
    mutationFn: ({
      app,
      discardStoredData = false,
      force = false,
      correlationId,
      requestedAt
    }: {
      app: BrowserApp | WebApp
      discardStoredData?: boolean
      force?: boolean
      trigger?: HTMLElement
      correlationId: string
      requestedAt: number
    }) => {
      const query: DeleteAppQuery = {}
      if (discardStoredData) {
        query.discardStoredData = 'true'
      }

      if (force) {
        query.force = 'true'
      }

      browserTrace('app.remove.request.started', correlationId, {
        elapsedMs: Number((performance.now() - requestedAt).toFixed(3)),
        appId: app.id,
        appKind: app.kind
      })
      return parseResponse(
        rpc.api.apps[':appId'].$delete(
          {
            param: { appId: app.id },
            query
          },
          { headers: { 'x-request-id': correlationId } }
        )
      )
    },
    onSuccess: async (_, { app, correlationId, requestedAt }) => {
      browserTrace('app.remove.response.received', correlationId, {
        elapsedMs: Number((performance.now() - requestedAt).toFixed(3)),
        appId: app.id,
        appKind: app.kind
      })
      setWebAppRuntimeTitle(app.id, null)
      setWebAppDirty(app.id, false)
      setPreserveTerminalFocusAppId((current) =>
        current === app.id ? null : current
      )
      setRetainedAppIds((current) => {
        if (!current.has(app.id)) {
          return current
        }

        const next = new Set(current)
        next.delete(app.id)
        return next
      })
      setDialog((current) =>
        current?.type === 'close-app' && current.app.id === app.id
          ? null
          : current
      )
      const worktree = projects
        .flatMap((project) => project.worktrees)
        .find((candidate) => candidate.id === app.worktreeId)
      const tools =
        worktree?.workspaceItems.filter(
          (candidate): candidate is BrowserApp | WebApp =>
            candidate.kind !== 'terminal'
        ) ?? []
      const closedIndex = tools.findIndex(
        (candidate) => candidate.id === app.id
      )
      const remainingTools = tools.filter(
        (candidate) => candidate.id !== app.id
      )
      const nextTool =
        remainingTools[closedIndex] ?? remainingTools[closedIndex - 1] ?? null
      setActiveAppByWorktree((current) =>
        current[app.worktreeId] === app.id
          ? { ...current, [app.worktreeId]: nextTool?.id ?? null }
          : current
      )
      queryClient.setQueryData<ProjectRecord[]>(
        projectsQueryOptions.queryKey,
        (current) =>
          current?.map((project) => ({
            ...project,
            worktrees: project.worktrees.map((worktree) =>
              worktree.id === app.worktreeId
                ? {
                    ...worktree,
                    workspaceItems: worktree.workspaceItems.filter(
                      (candidate) => candidate.id !== app.id
                    )
                  }
                : worktree
            )
          }))
      )
      browserTrace('app.remove.cache.updated', correlationId, {
        appId: app.id
      })
      if (selectedApp?.id === app.id) {
        const target = nextTool
          ? targetForApp(projects, nextTool)
          : worktree
            ? targetForWorktree(projects, worktree, selectedTerminalId)
            : null
        if (target) {
          browserTrace('app.remove.navigation.started', correlationId, {
            appId: app.id
          })
          await navigateToWorkspace(target, true)
          browserTrace('app.remove.navigation.finished', correlationId, {
            appId: app.id
          })
        }
      }

      if (!nextTool) {
        restoreEmptyToolFocus()
      }

      browserTrace('app.remove.settled', correlationId, {
        elapsedMs: Number((performance.now() - requestedAt).toFixed(3)),
        failed: false,
        appId: app.id
      })
      void queryClient.invalidateQueries({
        queryKey: projectsQueryOptions.queryKey
      })
    },
    onError: (error, request) => {
      const { app, trigger, correlationId, requestedAt } = request
      if (
        app.kind === 'browser' &&
        errorDetails(error).code === 'BROWSER_BEFORE_UNLOAD'
      ) {
        browserTrace('app.remove.confirmation.required', correlationId, {
          elapsedMs: Number((performance.now() - requestedAt).toFixed(3)),
          appId: app.id,
          reason: 'browser-before-unload'
        })
        openDialog(
          { type: 'close-app', app, reason: 'browser-before-unload' },
          trigger
        )
        return
      }

      browserTrace('app.remove.failed', correlationId, {
        elapsedMs: Number((performance.now() - requestedAt).toFixed(3)),
        appId: app.id,
        appKind: app.kind
      })
      notifyError(error, { operation: `close app “${app.title}”` })
    }
  })
  const startAppClose = (
    app: BrowserApp | WebApp,
    options: { discardStoredData?: boolean; force?: boolean } = {},
    trigger?: HTMLElement
  ) => {
    const correlationId = newBrowserCorrelationId()
    const requestedAt = performance.now()
    browserTrace('app.remove.command.admitted', correlationId, {
      appId: app.id,
      appKind: app.kind,
      worktreeId: app.worktreeId
    })
    const request = { app, ...options, correlationId, requestedAt }
    closeApp.mutate(trigger ? { ...request, trigger } : request)
  }
  const requestCloseApp = (app: BrowserApp | WebApp, trigger?: HTMLElement) => {
    if (app.kind === 'browser') {
      startAppClose(app, {}, trigger)
      return
    }

    if (dirtyWebAppIds.has(app.id)) {
      openDialog({ type: 'close-app', app, reason: 'unsaved-changes' }, trigger)
      return
    }

    void parseResponse(
      rpc.api.apps[':appId'].storage.$get({
        param: { appId: app.id }
      })
    ).then(
      ({ hasData }) => {
        if (hasData) {
          openDialog({ type: 'close-app', app, reason: 'stored-data' }, trigger)
        } else {
          startAppClose(app)
        }
      },
      (error) => {
        notifyError(error, {
          operation: `check stored data for web app “${app.title}”`
        })
      }
    )
  }
  const navigateAppOpenRequest = useCallback(
    (request: ProductEventDataMap['app.open_requested']) => {
      const webApp = request.app.kind === 'web'
      if (request.requestId) {
        browserTrace(
          webApp
            ? 'web_app.open.event_received'
            : 'browser.open.event_received',
          request.requestId,
          {
            appId: request.appId
          }
        )
      }

      if (
        !openRequestMatchesWorkspace(
          request.sourceTerminalId,
          request.sourceAppId,
          selectedTerminalId,
          activeAppId
        )
      ) {
        return
      }

      if (request.requestId) {
        if (webApp) {
          registerWebAppOpen(request.appId, request.requestId)
          traceWebAppOpen(request.appId, 'web_app.open.ui_requested')
        } else {
          registerBrowserOpen(request.appId, request.requestId)
          traceBrowserOpen(request.appId, 'browser.open.ui_requested')
        }
      }

      revealTool(
        request.app,
        request.sourceTerminalId !== null &&
          request.sourceTerminalId === selectedTerminalId
      )
      setWebAppReloadRevisions((current) => ({
        ...current,
        [request.appId]: (current[request.appId] ?? 0) + 1
      }))
      queryClient.setQueryData<ProjectRecord[]>(
        projectsQueryOptions.queryKey,
        (current) =>
          current?.map((project) => ({
            ...project,
            worktrees: project.worktrees.map((worktree) =>
              worktree.id !== request.worktreeId
                ? worktree
                : {
                    ...worktree,
                    workspaceItems: worktree.workspaceItems.some(
                      (app) => app.id === request.appId
                    )
                      ? worktree.workspaceItems.map((app) =>
                          app.id === request.appId ? request.app : app
                        )
                      : [...worktree.workspaceItems, request.app]
                  }
            )
          }))
      )
      const currentProjects =
        queryClient.getQueryData<ProjectRecord[]>(
          projectsQueryOptions.queryKey
        ) ?? []
      const target = targetForApp(currentProjects, request.app)
      const navigation = target
        ? navigateToWorkspace(target)
        : queryClient
            .invalidateQueries({
              queryKey: projectsQueryOptions.queryKey
            })
            .then(async () => {
              const freshProjects =
                queryClient.getQueryData<ProjectRecord[]>(
                  projectsQueryOptions.queryKey
                ) ?? []
              const freshTarget = targetForApp(freshProjects, request.app)
              if (freshTarget) {
                await navigateToWorkspace(freshTarget)
              }
            })
      void navigation
        .then(() => {
          if (request.requestId) {
            browserTrace(
              webApp
                ? 'web_app.open.workspace_navigated'
                : 'browser.open.workspace_navigated',
              request.requestId,
              {
                appId: request.appId
              }
            )
          }
        })
        .catch((error) => {
          notifyError(error, { operation: 'open app' })
        })
    },
    [
      activeAppId,
      navigateToWorkspace,
      queryClient,
      revealTool,
      selectedTerminalId
    ]
  )
  const navigateWorkspaceOpenRequest = useCallback(
    (request: ProductEventDataMap['workspace.open_requested']) => {
      if (
        !openRequestMatchesTerminal(
          request.sourceTerminalId,
          selectedTerminalId
        )
      ) {
        return
      }

      void queryClient
        .invalidateQueries({
          queryKey: projectsQueryOptions.queryKey
        })
        .then(async () => {
          const freshProjects =
            queryClient.getQueryData<ProjectRecord[]>(
              projectsQueryOptions.queryKey
            ) ?? []
          const worktree = freshProjects
            .flatMap((project) => project.worktrees)
            .find((candidate) => candidate.id === request.worktreeId)
          const target = worktree
            ? targetForWorktree(freshProjects, worktree)
            : null
          if (target) {
            await navigateToWorkspace(target)
          }
        })
        .catch((error) => {
          notifyError(error, { operation: 'open workspace' })
        })
    },
    [navigateToWorkspace, queryClient, selectedTerminalId]
  )
  const presence = useWorkspacePresence(
    selectedWorktree?.id ?? null,
    dialog !== null
      ? null
      : appsPanelOpen && focusedSurface === 'tool'
        ? activeAppId
        : (selectedWorktree?.workspaceItems.find(
            (app) =>
              app.kind === 'terminal' && app.terminalId === selectedTerminalId
          )?.id ?? null)
  )
  const eventsDisconnected = useProjectEventsBridge(
    projectsQuery.data,
    navigateAppOpenRequest,
    navigateWorkspaceOpenRequest,
    presence.setViewers
  )
  const [showSyncDegraded, setShowSyncDegraded] = useState(false)
  const dialogTriggerRef = useRef<HTMLElement | null>(null)
  const openDialog = (
    nextDialog: Exclude<AppDialog, null>,
    trigger?: HTMLElement
  ) => {
    dialogTriggerRef.current =
      // SAFETY: The component contract supplies the asserted browser value used here.
      trigger ?? (document.activeElement as HTMLElement | null)
    setDialog(nextDialog)
  }

  useEffect(() => {
    if (!workspaceResolution?.canonical || !selectedApp) {
      return
    }

    retainApp(selectedApp.id)
    setActiveAppByWorktree((current) =>
      current[selectedApp.worktreeId] === selectedApp.id
        ? current
        : { ...current, [selectedApp.worktreeId]: selectedApp.id }
    )
    setAppsPanelOpen(selectedApp.worktreeId, true)
  }, [retainApp, selectedApp, setAppsPanelOpen, workspaceResolution?.canonical])

  useEffect(() => {
    if (!workspaceResolution || workspaceResolution.canonical) {
      return
    }

    void navigateToWorkspace(workspaceResolution.target, true)
  }, [
    navigateToWorkspace,
    workspaceResolution?.canonical,
    workspaceResolution?.target.pathname
  ])

  useEffect(() => {
    if (!workspaceResolution?.canonical) {
      return
    }

    if (workspaceResolution.target.kind === 'root') {
      localStorage.removeItem(LAST_WORKSPACE_ROUTE_STORAGE_KEY)
    } else {
      localStorage.setItem(
        LAST_WORKSPACE_ROUTE_STORAGE_KEY,
        workspaceResolution.target.pathname
      )
    }

    if (workspaceResolution.target.kind === 'terminal') {
      localStorage.setItem(
        `${LAST_PROJECT_TERMINAL_STORAGE_PREFIX}${workspaceResolution.target.projectId}`,
        workspaceResolution.target.terminalId
      )
    }
  }, [workspaceResolution?.canonical, workspaceResolution?.target.pathname])

  useEffect(() => {
    const degraded =
      projectsQuery.data !== undefined &&
      (eventsDisconnected || projectsQuery.isRefetchError)
    if (!degraded) {
      setShowSyncDegraded(false)
      return
    }

    const timer = window.setTimeout(
      () => setShowSyncDegraded(true),
      METADATA_DEGRADED_GRACE_MS
    )
    return () => window.clearTimeout(timer)
  }, [eventsDisconnected, projectsQuery.data, projectsQuery.isRefetchError])

  const retainedApps = useMemo(
    () =>
      projects
        .flatMap((project) => project.worktrees)
        .flatMap((worktree) => worktree.workspaceItems)
        .filter(
          (app): app is BrowserApp | WebApp =>
            app.kind !== 'terminal' &&
            (retainedAppIds.has(app.id) || app.id === activeAppId)
        ),
    [activeAppId, projects, retainedAppIds]
  )
  const navigateToTerminal = useCallback(
    (terminal: TerminalRecord) => {
      const target = targetForTerminal(projects, terminal)
      if (target) {
        void navigateToWorkspace(target)
      }

      closeDrawerAfterNavigation()
    },
    [closeDrawerAfterNavigation, navigateToWorkspace, projects]
  )

  const selectWorktree = useCallback(
    (worktree: WorktreeRecord) => {
      setFullViewWorktreeId(null)
      focusSurface('terminal')
      const target = targetForWorktree(projects, worktree, selectedTerminalId)
      if (target) {
        void navigateToWorkspace(target)
      }

      closeDrawerAfterNavigation()
    },
    [
      closeDrawerAfterNavigation,
      focusSurface,
      navigateToWorkspace,
      projects,
      selectedTerminalId
    ]
  )

  const rememberedTargetForProject = (project: ProjectRecord) =>
    targetForProject(
      project,
      localStorage.getItem(
        `${LAST_PROJECT_TERMINAL_STORAGE_PREFIX}${project.id}`
      )
    )

  const selectProject = (project: ProjectRecord) => {
    setFullViewWorktreeId(null)
    focusSurface('terminal')
    const target = rememberedTargetForProject(project)
    projectSwitcher.dismissedIntoTerminalRef.current =
      !isMobile && target.kind === 'terminal'
    void navigateToWorkspace(target, false, !isMobile)
    projectSwitcher.setOpen(false)
    closeDrawerAfterNavigation()
  }

  const { closingProjectId, requestProjectClose, projectOpened } =
    useProjectWorkflows({
      projects,
      selectedProject,
      targetForProject: rememberedTargetForProject,
      projectSwitcherTriggerRef: projectSwitcher.triggerRef,
      closeProjectUi: () => projectSwitcher.setOpen(false),
      openedProjectUi: () => {
        projectSwitcher.setOpen(false)
        closeDrawerAfterNavigation()
        setDialog(null)
      }
    })
  const projectOpenedFromSwitcher = (project: ProjectRecord) => {
    focusSurface('terminal')
    const target = rememberedTargetForProject(project)
    projectSwitcher.dismissedIntoTerminalRef.current =
      !isMobile && target.kind === 'terminal'
    return projectOpened(project, !isMobile)
  }
  const {
    pendingWorktrees,
    pendingRemovals,
    submitWorktreeCreation,
    prepareRemoval,
    confirmRemoval,
    removeWithoutCleanup,
    retryRemoval
  } = useWorktreeWorkflows({
    projects,
    removals,
    setDrawerOpen: (open) => {
      if (open) {
        setDrawerOpen(true)
      } else {
        closeDrawerAfterNavigation()
      }
    },
    onWorktreeSubmitted: () => setDialog(null),
    onRemovalNeedsConfirmation: (
      worktree,
      preview,
      trigger,
      skipCleanup = false
    ) =>
      openDialog(
        { type: 'remove', worktree, preview, operation: null, skipCleanup },
        trigger
      ),
    onRemovalProgress: (worktree, preview, operation, open) =>
      setDialog((current) =>
        open ||
        (current?.type === 'remove' && current.worktree.id === worktree.id)
          ? {
              type: 'remove',
              worktree,
              preview,
              operation,
              skipCleanup: operation.request.skipCleanup
            }
          : current
      ),
    onRemovalDismiss: (worktreeId) =>
      setDialog((current) =>
        current?.type === 'remove' && current.worktree.id === worktreeId
          ? null
          : current
      ),
    selectedTerminalId
  })
  const terminalWorkflows = useTerminalWorkflows({
    projects,
    selectedTerminal
  })
  const createSplitTerminal = (direction: TerminalSplitDirection) => {
    if (!selectedProject || !selectedWorktree || !selectedTerminal) {
      return
    }

    terminalWorkflows.createTerminalInWorktree(
      selectedProject,
      selectedWorktree,
      { name: 'Shell' },
      { targetTerminalId: selectedTerminal.id, direction }
    )
  }
  const selectTerminal = useCallback(
    (terminal: TerminalRecord) => {
      setFullViewWorktreeId(null)
      focusSurface('terminal')
      setDesktopNotificationsOpen(false)
      setMobileNotificationsOpen(false)
      navigateToTerminal(terminal)
    },
    [focusSurface, navigateToTerminal]
  )
  const selectApp = useCallback(
    (app: BrowserApp | WebApp) => {
      focusSurface('tool')
      revealTool(app, false)

      const target = targetForApp(projects, app)
      if (target) {
        void navigateToWorkspace(target)
      }

      closeDrawerAfterNavigation()
    },
    [
      closeDrawerAfterNavigation,
      focusSurface,
      navigateToWorkspace,
      projects,
      revealTool
    ]
  )
  const selectWorkspaceByIndex = useCallback(
    (index: number) => {
      if (workspaceActionsBlocked || !selectedWorktree) {
        return false
      }

      const terminal = selectedWorktree.terminals[index]
      if (terminal) {
        selectTerminal(terminal)
        return true
      }

      return false
    },
    [selectedWorktree, selectTerminal, workspaceActionsBlocked]
  )

  const selectFocusedSurfaceByIndex = useCallback(
    (index: number) => {
      if (workspaceActionsBlocked || !selectedWorktree) {
        return false
      }

      if (appsPanelOpen && focusedSurfaceRef.current === 'tool') {
        const app = selectedWorktreeTools[index]
        if (!app) {
          return false
        }

        selectApp(app)
        return true
      }

      return selectWorkspaceByIndex(index)
    },
    [
      selectedWorktree,
      selectApp,
      selectedWorktreeTools,
      selectWorkspaceByIndex,
      appsPanelOpen,
      workspaceActionsBlocked
    ]
  )

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) {
        return
      }

      const index = Number(event.key) - 1
      if (!Number.isInteger(index) || index < 0 || index > 8) {
        return
      }

      if (!selectFocusedSurfaceByIndex(index)) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener('keydown', keydown, true)
    return () => document.removeEventListener('keydown', keydown, true)
  }, [selectFocusedSurfaceByIndex])

  const appLaunchDisabled =
    !appDialogProject ||
    !appDialogWorktree ||
    appDialogProject.availability.state === 'unavailable' ||
    Boolean(appDialogWorktree.prunable) ||
    Boolean(pendingRemovals[appDialogWorktree.id])
  const toolLaunchDisabled =
    !selectedProject ||
    !selectedWorktree ||
    selectedProject.availability.state === 'unavailable' ||
    Boolean(selectedWorktree.prunable) ||
    Boolean(pendingRemovals[selectedWorktree.id])
  const toggleAppsPanel = useCallback(() => {
    if (!selectedWorktree) {
      return
    }

    if (appsPanelOpen) {
      setAppsPanelOpen(selectedWorktree.id, false)
      focusSurface('terminal')
      return
    }

    const app = activeApp ?? selectedWorktreeTools.at(-1) ?? null
    if (app) {
      retainApp(app.id)
      setActiveAppByWorktree((current) => ({
        ...current,
        [app.worktreeId]: app.id
      }))
    }

    setAppsPanelOpen(selectedWorktree.id, true)
  }, [
    activeApp,
    focusSurface,
    retainApp,
    selectedWorktree,
    selectedWorktreeTools,
    setAppsPanelOpen,
    appsPanelOpen
  ])
  const focusToolSurface = useCallback(() => {
    focusSurface('tool')
    setPreserveTerminalFocusAppId(null)
  }, [focusSurface])

  useEffect(() => {
    if (desktopBridge?.onCommand) {
      return
    }

    const usesMacKeyboard = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
    const keydown = (event: KeyboardEvent) => {
      const modifierPressed = usesMacKeyboard
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey
      if (event.isComposing || event.shiftKey || !modifierPressed) {
        return
      }

      if (!event.altKey) {
        if (
          event.key.toLowerCase() !== 't' ||
          workspaceActionsBlocked ||
          !appsPanelOpen ||
          focusedSurfaceRef.current !== 'tool' ||
          !selectedWorktree
        ) {
          return
        }

        event.preventDefault()
        event.stopPropagation()
        if (
          !event.repeat &&
          !toolLaunchDisabled &&
          !createBrowserApp.isPending
        ) {
          dismissToolPicker()
          createBrowserApp.mutate({ worktree: selectedWorktree })
        }

        return
      }

      const direction =
        event.key === 'ArrowLeft'
          ? 'left'
          : event.key === 'ArrowRight'
            ? 'right'
            : event.key === 'ArrowUp'
              ? 'up'
              : event.key === 'ArrowDown'
                ? 'down'
                : null
      if (direction) {
        if (
          event.repeat ||
          workspaceActionsBlocked ||
          focusedSurfaceRef.current === 'tool' ||
          !selectedTerminal
        ) {
          return
        }

        createSplitTerminal(direction)
      } else if (
        event.key.toLocaleLowerCase() === 'b' &&
        !workspaceActionsBlocked &&
        selectedWorktree
      ) {
        toggleAppsPanel()
      } else {
        return
      }

      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener('keydown', keydown, true)
    return () => document.removeEventListener('keydown', keydown, true)
  }, [
    createBrowserApp.isPending,
    createBrowserApp.mutate,
    createSplitTerminal,
    desktopBridge,
    dismissToolPicker,
    selectedWorktree,
    toggleAppsPanel,
    toolLaunchDisabled,
    appsPanelOpen,
    workspaceActionsBlocked
  ])

  useEffect(() => {
    if (!desktopBridge?.onCommand) {
      return
    }

    return desktopBridge.onCommand((command) => {
      if (
        command === 'zoom-in' ||
        command === 'zoom-out' ||
        command === 'zoom-reset'
      ) {
        if (workspaceActionsBlocked || !terminalSessions.zoomFocused(command)) {
          desktopBridge.zoomPage?.(command)
        }

        return
      }

      if (command === 'reload') {
        if (!(appsPanelOpen && activeApp?.kind === 'browser')) {
          window.location.reload()
        }

        return
      }

      if (workspaceActionsBlocked) {
        return
      }

      if (command === 'new-worktree') {
        if (
          activeProject?.kind === 'repository' &&
          activeProject.availability.state !== 'unavailable'
        ) {
          openDialog({ type: 'worktree', project: activeProject })
        }

        return
      }

      if (!selectedProject || !selectedWorktree) {
        return
      }

      if (
        command === 'select-previous-worktree' ||
        command === 'select-next-worktree'
      ) {
        const worktrees = selectedProject.worktrees
        const selectedIndex = worktrees.findIndex(
          (worktree) => worktree.id === selectedWorktree.id
        )
        if (worktrees.length > 1 && selectedIndex !== -1) {
          const offset = command === 'select-previous-worktree' ? -1 : 1
          selectWorktree(
            worktrees[
              (selectedIndex + offset + worktrees.length) % worktrees.length
            ]!
          )
        }

        return
      }

      const toolSurfaceHasFocus =
        appsPanelOpen && focusedSurfaceRef.current === 'tool'
      const selectedTabIndex = command.startsWith('select-tab-')
        ? Number(command.at(-1)) - 1
        : null
      // SAFETY: DesktopCommand only has the four TerminalSplitDirection suffixes.
      const splitDirection = command.startsWith('split-terminal-')
        ? (command.slice('split-terminal-'.length) as TerminalSplitDirection)
        : null
      if (selectedTabIndex !== null) {
        selectFocusedSurfaceByIndex(selectedTabIndex)
      } else if (command === 'toggle-apps-panel') {
        toggleAppsPanel()
      } else if (command === 'new-terminal') {
        if (toolSurfaceHasFocus) {
          if (!toolLaunchDisabled && !createBrowserApp.isPending) {
            dismissToolPicker()
            createBrowserApp.mutate({ worktree: selectedWorktree })
          }
        } else {
          const correlationId = newBrowserCorrelationId()
          browserTrace('terminal.desktop_command.received', correlationId, {
            command: 'new-terminal',
            worktreeId: selectedWorktree.id
          })
          terminalWorkflows.createTerminalInWorktree(
            selectedProject,
            selectedWorktree,
            { name: 'Shell', correlationId }
          )
        }
      } else if (splitDirection && !toolSurfaceHasFocus) {
        createSplitTerminal(splitDirection)
      } else if (command === 'new-app') {
        openDialog({
          type: 'app',
          projectId: selectedProject.id,
          worktreeId: selectedWorktree.id
        })
      } else if (command === 'close-app') {
        if (toolSurfaceHasFocus && activeApp) {
          requestCloseApp(activeApp)
        } else if (selectedTerminal) {
          terminalWorkflows.requestCloseTerminal(selectedTerminal)
        }
      }
    })
  }, [
    activeProject,
    activeApp,
    selectedProject,
    selectedTerminal,
    selectedWorktree,
    createBrowserApp.isPending,
    createBrowserApp.mutate,
    dismissToolPicker,
    selectFocusedSurfaceByIndex,
    selectWorktree,
    toggleAppsPanel,
    toolLaunchDisabled,
    appsPanelOpen,
    workspaceActionsBlocked
  ])

  return (
    <>
      <WorkspaceWindowTitle
        projects={projects}
        selectedProject={selectedProject}
        selectedWorktree={selectedWorktree}
        disconnected={eventsDisconnected || projectsQuery.isRefetchError}
      />
      <TerminalBellAttention
        projects={projects}
        selectedTerminalId={selectedTerminalId}
      />
      <ProjectSwitcherShortcut blocked={dialog !== null} />
      <WorkspaceMobileHeader
        terminal={selectedTerminal}
        updateControl={<UpdateControl />}
        notificationCenter={
          <NotificationCenter
            projects={projects}
            navigateToWorkspace={navigateToWorkspace}
            open={mobileNotificationsOpen}
            onOpenChange={setMobileNotificationsOpen}
          />
        }
      />
      <WorkspaceSidebar
        updateControl={<UpdateControl />}
        notificationCenter={
          <NotificationCenter
            projects={projects}
            navigateToWorkspace={navigateToWorkspace}
            open={desktopNotificationsOpen}
            onOpenChange={setDesktopNotificationsOpen}
          />
        }
        projectSwitcher={
          <ProjectSwitcher
            projects={projects}
            activeProject={activeProject}
            closingProjectId={closingProjectId}
            onSelectProject={selectProject}
            onProjectOpened={projectOpenedFromSwitcher}
            onRequestProjectClose={requestProjectClose}
            onOpenProjectDialog={(trigger) =>
              openDialog({ type: 'project' }, trigger)
            }
          />
        }
      >
        <WorkspaceTree
          projects={projects}
          projectsPending={projectsQuery.isPending}
          projectsError={projectsQuery.isError}
          projectsLoaded={projectsQuery.data !== undefined}
          activeProject={activeProject}
          selectedWorktree={selectedWorktree}
          selectedTerminalId={selectedTerminalId}
          pendingWorktrees={pendingWorktrees}
          pendingRemovals={pendingRemovals}
          onRetryProjects={() => void projectsQuery.refetch()}
          onSelectTerminal={selectTerminal}
          onCloseTerminal={terminalWorkflows.requestCloseTerminal}
          onReorderTerminals={reorderTerminals}
          onSelectWorktree={selectWorktree}
          onPrepareRemoval={prepareRemoval}
          onOpenAppDialog={(project, worktree, trigger) =>
            openDialog(
              {
                type: 'app',
                projectId: project.id,
                worktreeId: worktree?.id ?? null
              },
              trigger
            )
          }
          onOpenWorktreeDialog={(project, trigger) =>
            openDialog({ type: 'worktree', project }, trigger)
          }
        />
      </WorkspaceSidebar>
      <WorkspaceMain
        presence={
          <WorkspaceViewers
            worktree={selectedWorktree}
            identity={presence.identity}
            viewers={presence.viewers}
          />
        }
      >
        <div className="relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)]">
          <AppsPanelToggle
            open={appsPanelOpen}
            fullView={appsPanelFullView}
            disabled={!selectedProject || !selectedWorktree}
            onToggle={toggleAppsPanel}
            onToggleFullView={() => {
              if (!selectedWorktree || !appsPanelOpen) {
                return
              }

              dismissToolPicker()
              focusToolSurface()
              setFullViewWorktreeId(
                appsPanelFullView ? null : selectedWorktree.id
              )
            }}
          />
          <div
            className={cn(
              'relative grid min-h-0 min-w-0 grid-cols-1',
              appsPanelOpen && 'min-[701px]:grid-cols-[minmax(0,1fr)_auto]'
            )}
          >
            <div
              className="relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)]"
              role="group"
              aria-label="Terminal tab group"
              aria-hidden={
                appsPanelOpen && (isMobile || appsPanelFullView)
                  ? true
                  : undefined
              }
              inert={
                appsPanelOpen && (isMobile || appsPanelFullView)
                  ? true
                  : undefined
              }
              onPointerDownCapture={() => {
                dismissToolPicker()
                focusSurface('terminal')
              }}
              onFocusCapture={() => {
                dismissToolPicker()
                focusSurface('terminal')
              }}
            >
              <TerminalWorkspace
                selectedWorktree={selectedWorktree}
                selectedTerminal={selectedTerminal}
                loading={projectsQuery.isPending}
                dialogOpen={dialog !== null}
                onSelectTerminal={selectTerminal}
              />
            </div>
            {selectedWorktree ? (
              <WorktreeAppsPanel
                worktreeName={selectedWorktree.name}
                visible={appsPanelOpen}
                fullView={appsPanelFullView}
                tools={selectedWorktreeTools}
                activeAppId={activeAppId}
                webAppRuntimeTitles={webAppRuntimeTitles}
                browserAppLoading={browserAppLoading}
                browserAppFavicons={browserAppFavicons}
                definitions={webAppDefinitionsQuery.data ?? []}
                definitionsLoading={
                  appsPanelOpen && webAppDefinitionsQuery.isPending
                }
                definitionsError={webAppDefinitionsQuery.isError}
                launchDisabled={
                  toolLaunchDisabled ||
                  createWebApp.isPending ||
                  createBrowserApp.isPending
                }
                onSelectApp={selectApp}
                onCloseApp={requestCloseApp}
                onReorderApps={reorderTools}
                onCreateBrowserApp={() =>
                  createBrowserApp.mutate({ worktree: selectedWorktree })
                }
                onOpenWebApp={(definition) =>
                  createWebApp.mutate({
                    worktree: selectedWorktree,
                    definition,
                    input: null
                  })
                }
                onFocusSurface={focusToolSurface}
              >
                {retainedApps.map((app) => {
                  const active = app.id === activeAppId && appsPanelOpen
                  const autoFocusBlocked =
                    workspaceActionsBlocked ||
                    preserveTerminalFocusAppId === app.id
                  return (
                    <Suspense
                      key={app.id}
                      fallback={active ? <LoadingFallback /> : null}
                    >
                      {app.kind === 'browser' ? (
                        <BrowserAppWorkspace
                          key={app.id}
                          app={app}
                          active={active}
                          autoFocusBlocked={autoFocusBlocked}
                          inputBlocked={workspaceActionsBlocked}
                          permissionPrompt={browserPermissionPrompt}
                          onLoadingChange={updateBrowserAppLoading}
                          onFaviconChange={updateBrowserAppFavicon}
                          onFocusSurface={focusToolSurface}
                        />
                      ) : (
                        <WebAppWorkspace
                          key={app.id}
                          app={app}
                          active={active}
                          title={webAppRuntimeTitles[app.id] ?? app.title}
                          reloadRevision={webAppReloadRevisions[app.id] ?? 0}
                          autoFocusBlocked={autoFocusBlocked}
                          onTitleChange={setWebAppRuntimeTitle}
                          onDirtyChange={setWebAppDirty}
                          onSelectWorkspace={selectWorkspaceByIndex}
                          onFocusSurface={focusToolSurface}
                        />
                      )}
                    </Suspense>
                  )
                })}
              </WorktreeAppsPanel>
            ) : null}
          </div>
        </div>
      </WorkspaceMain>
      {browserPermissionPrompt &&
      (browserPermissionPrompt.appId !== activeAppId || !appsPanelOpen) ? (
        <div
          className={cn(
            'fixed right-4 z-70 flex max-w-[min(30rem,calc(100vw-2rem))] items-center gap-3 rounded-lg bg-zinc-800 p-3 text-sm text-zinc-100 shadow-2xl ring-1 ring-white/10',
            showSyncDegraded ? 'bottom-20' : 'bottom-4'
          )}
          role="status"
        >
          <span className="min-w-0 break-all">
            {browserPermissionPrompt.origin} requests a website permission.
          </span>
          <button
            type="button"
            className="shrink-0 rounded px-2 py-1 text-cyan-300 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-cyan-300"
            onClick={() => {
              const app = retainedApps.find(
                (item) => item.id === browserPermissionPrompt.appId
              )
              if (app?.kind === 'browser') {
                selectApp(app)
              }
            }}
          >
            Review
          </button>
        </div>
      ) : null}
      {showSyncDegraded ? (
        <div
          className="fixed right-4 bottom-4 z-70 flex max-w-[min(30rem,calc(100vw-2rem))] items-center gap-3 rounded-lg bg-zinc-800 p-3 text-sm text-zinc-300 shadow-2xl ring-1 ring-white/10"
          role="status"
          inert={isMobile && drawerOpen ? true : undefined}
          aria-hidden={isMobile && drawerOpen ? true : undefined}
        >
          <span>Updates paused; showing the last known project state.</span>
        </div>
      ) : null}
      <OpenProjectDialog
        open={dialog?.type === 'project'}
        onOpenChange={(open) => !open && setDialog(null)}
        restoreFocusTo={dialogTriggerRef.current}
        onOpened={projectOpened}
      />
      <CreateWorktreeDialog
        project={dialog?.type === 'worktree' ? dialog.project : null}
        onOpenChange={(open) => !open && setDialog(null)}
        restoreFocusTo={dialogTriggerRef.current}
        presets={availablePresets}
        presetDiagnostics={presetDiagnostics}
        presetsLoading={presetDefinitionsQuery.isPending}
        presetsError={presetDefinitionsQuery.isError}
        onRetryPresets={() => void presetDefinitionsQuery.refetch()}
        contextFields={treeContextFieldsQuery.data?.fields ?? []}
        contextFieldDiagnostics={treeContextFieldsQuery.data?.diagnostics ?? []}
        contextFieldsLoading={treeContextFieldsQuery.isPending}
        contextFieldsError={treeContextFieldsQuery.isError}
        onRetryContextFields={() => void treeContextFieldsQuery.refetch()}
        onSubmit={submitWorktreeCreation}
      />
      <NewAppDialog
        open={dialog?.type === 'app'}
        onOpenChange={(open) => !open && setDialog(null)}
        restoreFocusTo={dialogTriggerRef.current}
        worktreeName={appDialogWorktree?.name ?? null}
        presets={availablePresets}
        presetDiagnostics={presetDiagnostics}
        presetsLoading={presetDefinitionsQuery.isPending}
        presetsError={presetDefinitionsQuery.isError}
        webAppDefinitions={webAppDefinitionsQuery.data ?? []}
        webAppDefinitionsLoading={
          Boolean(appDialogWorktree) && webAppDefinitionsQuery.isPending
        }
        webAppDefinitionsError={webAppDefinitionsQuery.isError}
        launchDisabled={
          appLaunchDisabled ||
          createWebApp.isPending ||
          createBrowserApp.isPending
        }
        onCreateTerminal={(input) => {
          if (!appDialogProject || !appDialogWorktree) {
            return
          }

          setDialog(null)
          terminalWorkflows.createTerminalInWorktree(
            appDialogProject,
            appDialogWorktree,
            input
          )
        }}
        onCreateBrowserApp={() => {
          if (appDialogWorktree) {
            createBrowserApp.mutate({ worktree: appDialogWorktree })
          }
        }}
        onCreateWebApp={(definition) => {
          if (!appDialogWorktree) {
            return
          }

          createWebApp.mutate({
            worktree: appDialogWorktree,
            definition,
            input: null
          })
        }}
        onManagePresets={() => setDialog({ type: 'presets' })}
      />
      <TerminalPresetsDialog
        open={dialog?.type === 'presets'}
        onOpenChange={(open) => !open && setDialog(null)}
        restoreFocusTo={dialogTriggerRef.current}
        presets={presets}
        loading={presetsQuery.isPending}
        loadError={presetsQuery.isError}
        onRetry={() => void presetsQuery.refetch()}
      />
      <CloseAppDialog
        app={dialog?.type === 'close-app' ? dialog.app : null}
        reason={dialog?.type === 'close-app' ? dialog.reason : null}
        busy={closeApp.isPending}
        onOpenChange={(open) => !open && setDialog(null)}
        restoreFocusTo={dialogTriggerRef.current}
        onConfirm={(app) => {
          startAppClose(
            app,
            app.kind === 'browser'
              ? { force: true }
              : { discardStoredData: true }
          )
        }}
      />
      <RemoveWorktreeDialog
        worktree={dialog?.type === 'remove' ? dialog.worktree : null}
        preview={dialog?.type === 'remove' ? dialog.preview : null}
        operation={dialog?.type === 'remove' ? dialog.operation : null}
        skipCleanup={dialog?.type === 'remove' ? dialog.skipCleanup : false}
        busy={
          dialog?.type === 'remove' &&
          pendingRemovals[dialog.worktree.id] !== undefined
        }
        onOpenChange={(open) => !open && setDialog(null)}
        restoreFocusTo={dialogTriggerRef.current}
        onConfirm={confirmRemoval}
        onSkipCleanup={removeWithoutCleanup}
        onRetry={(worktree) => void retryRemoval(worktree)}
      />
    </>
  )
}
