import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import type {
  BrowserTab,
  ProductEventDataMap,
  ProjectRecord,
  RemoveOperationRecord,
  RemovePreview,
  TerminalRecord,
  WebPanel,
  WebPanelDefinition,
  WebPanelInput,
  WorktreeRecord
} from '@treeport/shared'
import { registerBrowserOpen, traceBrowserOpen } from './browser-open-tracing'
import {
  beginWebPanelOpen,
  registerWebPanelOpen,
  traceWebPanelOpen
} from './web-panel-open-tracing'
import { NotificationCenter } from './features/notifications/notification-center'
import { TerminalBellAttention } from './features/notifications/terminal-bell-attention'
import { BrowserTabWorkspace } from './features/browser-tabs/browser-tab-workspace'
import { CloseTabDialog } from './features/tabs/close-tab-dialog'
import { WebPanelWorkspace } from './features/web-panels/web-panel-workspace'
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
import { NewTabDialog } from './features/tabs/new-tab-dialog'
import { useToolPicker } from './features/tabs/tool-picker-context'
import { useWorkspaceSurfaceFocus } from './features/tabs/workspace-surface-focus-context'
import {
  SidePanelToggle,
  WorktreeToolPane
} from './features/tabs/worktree-tool-pane'
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
  targetForTab,
  targetForTerminal,
  targetForWorktree
} from './workspace-navigation'
import { useWorkspaceNavigate } from './workspace-router-navigation'
import { ForceSpecificCursor } from './force-specific-cursor'
import { errorDetails } from './error-message'
import { cn } from './lib/utils'
import { browserTrace, newBrowserCorrelationId } from './agent-tracing'

const TOOL_PANE_OPEN_STORAGE_PREFIX = 'treeport-tool-pane-open:'

type CloseTabReason =
  | 'browser-before-unload'
  | 'stored-data'
  | 'unsaved-changes'

type AppDialog =
  | { type: 'project' }
  | { type: 'worktree'; project: ProjectRecord }
  | { type: 'tab'; projectId: string; worktreeId: string | null }
  | { type: 'presets' }
  | {
      type: 'remove'
      worktree: RemovalWorktree
      preview: RemovePreview
      operation: RemoveOperationRecord | null
      skipCleanup: boolean
    }
  | {
      type: 'close-tab'
      tab: BrowserTab | WebPanel
      reason: CloseTabReason
    }
  | null

interface DeleteTabQuery {
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
  const selectedTab = workspaceResolution?.selection.tab ?? null
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
  const workspaceActionsBlocked =
    dialog !== null || projectSwitcherOpen || (isMobile && drawerOpen)
  const [retainedTabIds, setRetainedTabIds] = useState<Set<string>>(
    () => new Set()
  )
  const [toolPaneOpenByWorktree, setToolPaneOpenByWorktree] = useState<
    Record<string, boolean>
  >({})
  const setToolPaneOpen = useCallback((worktreeId: string, open: boolean) => {
    setToolPaneOpenByWorktree((current) =>
      current[worktreeId] === open
        ? current
        : { ...current, [worktreeId]: open }
    )
    localStorage.setItem(
      `${TOOL_PANE_OPEN_STORAGE_PREFIX}${worktreeId}`,
      String(open)
    )
  }, [])
  const toolPaneOpen = selectedWorktree
    ? (toolPaneOpenByWorktree[selectedWorktree.id] ??
      localStorage.getItem(
        `${TOOL_PANE_OPEN_STORAGE_PREFIX}${selectedWorktree.id}`
      ) === 'true')
    : false
  const [activeTabByWorktree, setActiveTabByWorktree] = useState<
    Record<string, string | null>
  >({})
  const [preserveTerminalFocusTabId, setPreserveTerminalFocusTabId] = useState<
    string | null
  >(null)
  const selectedWorktreeTools = useMemo(
    () =>
      selectedWorktree?.tabs.filter(
        (tab): tab is BrowserTab | WebPanel => tab.kind !== 'terminal'
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

              const panelsById = new Map(
                worktree.tabs.map((tab) => [tab.id, tab])
              )
              const orderedTools = itemIds.map((tabId) =>
                panelsById.get(tabId)!
              )
              let toolIndex = 0
              return {
                ...worktree,
                tabs: worktree.tabs.map((tab) =>
                  tab.kind === 'terminal' ? tab : orderedTools[toolIndex++]!
                )
              }
            })
          }))
      )
      void parseResponse(
        rpc.api.worktrees[':worktreeId'].tabs.order.$put({
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
  const rememberedActiveTab = selectedWorktreeTools.find(
    (tab) => tab.id === activeTabByWorktree[selectedWorktree?.id ?? '']
  )
  const activeTab =
    selectedTab ??
    rememberedActiveTab ??
    (toolPaneOpen ? selectedWorktreeTools.at(-1) : null) ??
    null
  const activeTabId = activeTab?.id ?? null
  const retainTab = useCallback((tabId: string) => {
    setRetainedTabIds((current) => {
      if (current.has(tabId)) {
        return current
      }

      const next = new Set(current)
      next.add(tabId)
      return next
    })
  }, [])
  const revealTool = useCallback(
    (tab: BrowserTab | WebPanel, preserveTerminalFocus: boolean) => {
      retainTab(tab.id)
      setActiveTabByWorktree((current) => ({
        ...current,
        [tab.worktreeId]: tab.id
      }))
      setToolPaneOpen(tab.worktreeId, true)
      setPreserveTerminalFocusTabId(preserveTerminalFocus ? tab.id : null)
    },
    [retainTab, setToolPaneOpen]
  )
  const [webPanelReloadRevisions, setWebPanelReloadRevisions] = useState<
    Record<string, number>
  >({})
  const [webPanelRuntimeTitles, setWebPanelRuntimeTitles] = useState<
    Record<string, string>
  >({})
  const [dirtyWebTabIds, setDirtyWebTabIds] = useState<Set<string>>(
    () => new Set()
  )
  const setWebPanelDirty = useCallback((tabId: string, dirty: boolean) => {
    setDirtyWebTabIds((current) => {
      if (current.has(tabId) === dirty) {
        return current
      }

      const next = new Set(current)
      if (dirty) {
        next.add(tabId)
      } else {
        next.delete(tabId)
      }

      return next
    })
  }, [])
  const [browserTabLoading, setBrowserTabLoading] = useState<
    Record<string, boolean>
  >({})
  const updateBrowserTabLoading = useCallback(
    (tabId: string, loading: boolean) => {
      setBrowserTabLoading((current) => {
        if (Boolean(current[tabId]) === loading) {
          return current
        }

        const next = { ...current }
        if (loading) {
          next[tabId] = true
        } else {
          delete next[tabId]
        }

        return next
      })
    },
    []
  )
  const setWebPanelRuntimeTitle = useCallback(
    (tabId: string, title: string | null) => {
      setWebPanelRuntimeTitles((current) => {
        if (title === null) {
          if (current[tabId] === undefined) {
            return current
          }

          const next = { ...current }
          delete next[tabId]
          return next
        }

        return current[tabId] === title
          ? current
          : { ...current, [tabId]: title }
      })
    },
    []
  )
  useEffect(() => {
    const tabs = projects.flatMap((project) =>
      project.worktrees.flatMap((worktree) => worktree.tabs)
    )
    const tabIds = new Set(tabs.map((tab) => tab.id))
    const webTabIds = new Set(
      tabs.filter((tab) => tab.kind === 'web').map((tab) => tab.id)
    )
    setWebPanelRuntimeTitles((current) => {
      const removedIds = Object.keys(current).filter(
        (tabId) => !webTabIds.has(tabId)
      )
      if (removedIds.length === 0) {
        return current
      }

      const next = { ...current }
      removedIds.forEach((tabId) => delete next[tabId])
      return next
    })
    setBrowserTabLoading((current) => {
      const removedIds = Object.keys(current).filter(
        (tabId) => !tabIds.has(tabId)
      )
      if (removedIds.length === 0) {
        return current
      }

      const next = { ...current }
      removedIds.forEach((tabId) => delete next[tabId])
      return next
    })
    setDirtyWebTabIds((current) => {
      const next = new Set([...current].filter((tabId) => webTabIds.has(tabId)))
      return next.size === current.size ? current : next
    })
  }, [projects])
  const tabDialogProject =
    dialog?.type === 'tab'
      ? (projects.find((project) => project.id === dialog.projectId) ?? null)
      : null
  const tabDialogWorktree =
    dialog?.type === 'tab' && dialog.worktreeId
      ? (tabDialogProject?.worktrees.find(
          (worktree) => worktree.id === dialog.worktreeId
        ) ?? null)
      : null
  const webPanelDefinitionsWorktree =
    tabDialogWorktree ?? (toolPaneOpen ? selectedWorktree : null)
  const presetDefinitionsContext =
    dialog?.type === 'worktree'
      ? { projectId: dialog.project.id }
      : tabDialogWorktree
        ? { worktreeId: tabDialogWorktree.id }
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
  const webPanelDefinitionsQuery = useQuery({
    queryKey: ['web-panel-definitions', webPanelDefinitionsWorktree?.id],
    queryFn: async () =>
      (
        await parseResponse(
          rpc.api.worktrees[':worktreeId']['web-panel-definitions'].$get({
            param: { worktreeId: webPanelDefinitionsWorktree!.id }
          })
        )
      ).definitions,
    enabled: Boolean(webPanelDefinitionsWorktree)
  })
  const createWebPanel = useMutation({
    mutationFn: ({
      worktree,
      definition,
      input
    }: {
      worktree: WorktreeRecord
      definition: WebPanelDefinition
      input: WebPanelInput | null
    }) =>
      (async () => {
        const requestId = beginWebPanelOpen()
        if (
          definition.permissions.length > 0 &&
          !definition.permissionsGranted
        ) {
          await parseResponse(
            rpc.api.worktrees[':worktreeId']['web-panel-definitions'][
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
          rpc.api.worktrees[':worktreeId'].tabs.open.$post(
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
          browserTrace('web_panel.open.request_failed', requestId)
          throw error
        })
        registerWebPanelOpen(result.tab.id, requestId)
        traceWebPanelOpen(result.tab.id, 'web_panel.open.response', {
          reused: result.reused
        })
        return result.tab
      })(),
    onSuccess: async (tab, { worktree }) => {
      traceWebPanelOpen(tab.id, 'web_panel.open.ui_requested')
      setDialog(null)
      revealTool(tab, false)
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
                    candidate.tabs.some((existing) => existing.id === tab.id)
                      ? candidate
                      : {
                          ...candidate,
                          tabs: [...candidate.tabs, tab]
                        }
                  )
                }
          )
      )
      const target = targetForTab(
        queryClient.getQueryData<ProjectRecord[]>(
          projectsQueryOptions.queryKey
        ) ?? projects,
        tab
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
        operation: `create web panel “${definition.title}” in tree “${worktree.name}”`
      })
    }
  })
  const createBrowserTab = useMutation({
    mutationFn: ({ worktree }: { worktree: WorktreeRecord }) =>
      parseResponse(
        rpc.api.worktrees[':worktreeId']['browser-tabs'].$post({
          param: { worktreeId: worktree.id },
          json: {}
        })
      ),
    onSuccess: async ({ tab }, { worktree }) => {
      setDialog(null)
      revealTool(tab, false)
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
                    candidate.tabs.some((existing) => existing.id === tab.id)
                      ? candidate
                      : {
                          ...candidate,
                          tabs: [...candidate.tabs, tab]
                        }
                  )
                }
          )
      )
      const target = targetForTab(
        queryClient.getQueryData<ProjectRecord[]>(
          projectsQueryOptions.queryKey
        ) ?? projects,
        tab
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
  const closeTab = useMutation({
    mutationFn: ({
      tab,
      discardStoredData = false,
      force = false,
      correlationId,
      requestedAt
    }: {
      tab: BrowserTab | WebPanel
      discardStoredData?: boolean
      force?: boolean
      trigger?: HTMLElement
      correlationId: string
      requestedAt: number
    }) => {
      const query: DeleteTabQuery = {}
      if (discardStoredData) {
        query.discardStoredData = 'true'
      }

      if (force) {
        query.force = 'true'
      }

      browserTrace('tab.remove.request.started', correlationId, {
        elapsedMs: Number((performance.now() - requestedAt).toFixed(3)),
        tabId: tab.id,
        panelKind: tab.kind
      })
      return parseResponse(
        rpc.api.tabs[':tabId'].$delete(
          {
            param: { tabId: tab.id },
            query
          },
          { headers: { 'x-request-id': correlationId } }
        )
      )
    },
    onSuccess: async (_, { tab, correlationId, requestedAt }) => {
      browserTrace('tab.remove.response.received', correlationId, {
        elapsedMs: Number((performance.now() - requestedAt).toFixed(3)),
        tabId: tab.id,
        panelKind: tab.kind
      })
      setWebPanelRuntimeTitle(tab.id, null)
      setWebPanelDirty(tab.id, false)
      setPreserveTerminalFocusTabId((current) =>
        current === tab.id ? null : current
      )
      setRetainedTabIds((current) => {
        if (!current.has(tab.id)) {
          return current
        }

        const next = new Set(current)
        next.delete(tab.id)
        return next
      })
      setDialog((current) =>
        current?.type === 'close-tab' && current.tab.id === tab.id
          ? null
          : current
      )
      const worktree = projects
        .flatMap((project) => project.worktrees)
        .find((candidate) => candidate.id === tab.worktreeId)
      const tools =
        worktree?.tabs.filter(
          (candidate): candidate is BrowserTab | WebPanel =>
            candidate.kind !== 'terminal'
        ) ?? []
      const closedIndex = tools.findIndex(
        (candidate) => candidate.id === tab.id
      )
      const remainingTools = tools.filter(
        (candidate) => candidate.id !== tab.id
      )
      const nextTool =
        remainingTools[closedIndex] ?? remainingTools[closedIndex - 1] ?? null
      setActiveTabByWorktree((current) =>
        current[tab.worktreeId] === tab.id
          ? { ...current, [tab.worktreeId]: nextTool?.id ?? null }
          : current
      )
      queryClient.setQueryData<ProjectRecord[]>(
        projectsQueryOptions.queryKey,
        (current) =>
          current?.map((project) => ({
            ...project,
            worktrees: project.worktrees.map((worktree) =>
              worktree.id === tab.worktreeId
                ? {
                    ...worktree,
                    tabs: worktree.tabs.filter(
                      (candidate) => candidate.id !== tab.id
                    )
                  }
                : worktree
            )
          }))
      )
      browserTrace('tab.remove.cache.updated', correlationId, {
        tabId: tab.id
      })
      if (selectedTab?.id === tab.id) {
        const target = nextTool
          ? targetForTab(projects, nextTool)
          : worktree
            ? targetForWorktree(projects, worktree, selectedTerminalId)
            : null
        if (target) {
          browserTrace('tab.remove.navigation.started', correlationId, {
            tabId: tab.id
          })
          await navigateToWorkspace(target, true)
          browserTrace('tab.remove.navigation.finished', correlationId, {
            tabId: tab.id
          })
        }
      }

      if (!nextTool) {
        restoreEmptyToolFocus()
      }

      browserTrace('tab.remove.settled', correlationId, {
        elapsedMs: Number((performance.now() - requestedAt).toFixed(3)),
        failed: false,
        tabId: tab.id
      })
      void queryClient.invalidateQueries({
        queryKey: projectsQueryOptions.queryKey
      })
    },
    onError: (error, request) => {
      const { tab, trigger, correlationId, requestedAt } = request
      if (
        tab.kind === 'browser' &&
        errorDetails(error).code === 'BROWSER_BEFORE_UNLOAD'
      ) {
        browserTrace('tab.remove.confirmation.required', correlationId, {
          elapsedMs: Number((performance.now() - requestedAt).toFixed(3)),
          tabId: tab.id,
          reason: 'browser-before-unload'
        })
        openDialog(
          { type: 'close-tab', tab, reason: 'browser-before-unload' },
          trigger
        )
        return
      }

      browserTrace('tab.remove.failed', correlationId, {
        elapsedMs: Number((performance.now() - requestedAt).toFixed(3)),
        tabId: tab.id,
        panelKind: tab.kind
      })
      notifyError(error, { operation: `close tab “${tab.title}”` })
    }
  })
  const startTabClose = (
    tab: BrowserTab | WebPanel,
    options: { discardStoredData?: boolean; force?: boolean } = {},
    trigger?: HTMLElement
  ) => {
    const correlationId = newBrowserCorrelationId()
    const requestedAt = performance.now()
    browserTrace('tab.remove.command.admitted', correlationId, {
      tabId: tab.id,
      panelKind: tab.kind,
      worktreeId: tab.worktreeId
    })
    const request = { tab, ...options, correlationId, requestedAt }
    closeTab.mutate(trigger ? { ...request, trigger } : request)
  }
  const requestCloseTab = (
    tab: BrowserTab | WebPanel,
    trigger?: HTMLElement
  ) => {
    if (tab.kind === 'browser') {
      startTabClose(tab, {}, trigger)
      return
    }

    if (dirtyWebTabIds.has(tab.id)) {
      openDialog({ type: 'close-tab', tab, reason: 'unsaved-changes' }, trigger)
      return
    }

    void parseResponse(
      rpc.api.tabs[':tabId'].storage.$get({
        param: { tabId: tab.id }
      })
    ).then(
      ({ hasData }) => {
        if (hasData) {
          openDialog({ type: 'close-tab', tab, reason: 'stored-data' }, trigger)
        } else {
          startTabClose(tab)
        }
      },
      (error) => {
        notifyError(error, {
          operation: `check stored data for web panel “${tab.title}”`
        })
      }
    )
  }
  const navigatePanelOpenRequest = useCallback(
    (request: ProductEventDataMap['tab.open_requested']) => {
      const webPanel = request.tab.kind === 'web'
      if (request.requestId) {
        browserTrace(
          webPanel
            ? 'web_panel.open.event_received'
            : 'browser.open.event_received',
          request.requestId,
          {
            tabId: request.tabId
          }
        )
      }

      if (
        !openRequestMatchesWorkspace(
          request.sourceTerminalId,
          request.sourceTabId,
          selectedTerminalId,
          activeTabId
        )
      ) {
        return
      }

      if (request.requestId) {
        if (webPanel) {
          registerWebPanelOpen(request.tabId, request.requestId)
          traceWebPanelOpen(request.tabId, 'web_panel.open.ui_requested')
        } else {
          registerBrowserOpen(request.tabId, request.requestId)
          traceBrowserOpen(request.tabId, 'browser.open.ui_requested')
        }
      }

      revealTool(
        request.tab,
        request.sourceTerminalId !== null &&
          request.sourceTerminalId === selectedTerminalId
      )
      setWebPanelReloadRevisions((current) => ({
        ...current,
        [request.tabId]: (current[request.tabId] ?? 0) + 1
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
                    tabs: worktree.tabs.some((tab) => tab.id === request.tabId)
                      ? worktree.tabs.map((tab) =>
                          tab.id === request.tabId ? request.tab : tab
                        )
                      : [...worktree.tabs, request.tab]
                  }
            )
          }))
      )
      const currentProjects =
        queryClient.getQueryData<ProjectRecord[]>(
          projectsQueryOptions.queryKey
        ) ?? []
      const target = targetForTab(currentProjects, request.tab)
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
              const freshTarget = targetForTab(freshProjects, request.tab)
              if (freshTarget) {
                await navigateToWorkspace(freshTarget)
              }
            })
      void navigation
        .then(() => {
          if (request.requestId) {
            browserTrace(
              webPanel
                ? 'web_panel.open.workspace_navigated'
                : 'browser.open.workspace_navigated',
              request.requestId,
              {
                tabId: request.tabId
              }
            )
          }
        })
        .catch((error) => {
          notifyError(error, { operation: 'open tab' })
        })
    },
    [
      activeTabId,
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
      : toolPaneOpen && focusedSurface === 'tool'
        ? activeTabId
        : (selectedWorktree?.tabs.find(
            (tab) =>
              tab.kind === 'terminal' && tab.terminalId === selectedTerminalId
          )?.id ?? null)
  )
  const eventsDisconnected = useProjectEventsBridge(
    projectsQuery.data,
    navigatePanelOpenRequest,
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
    if (!workspaceResolution?.canonical || !selectedTab) {
      return
    }

    retainTab(selectedTab.id)
    setActiveTabByWorktree((current) =>
      current[selectedTab.worktreeId] === selectedTab.id
        ? current
        : { ...current, [selectedTab.worktreeId]: selectedTab.id }
    )
    setToolPaneOpen(selectedTab.worktreeId, true)
  }, [retainTab, selectedTab, setToolPaneOpen, workspaceResolution?.canonical])

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

  const activeProjectTerminals = useMemo(
    () =>
      activeProject?.worktrees.flatMap((worktree) => worktree.terminals) ?? [],
    [activeProject]
  )
  const retainedTabs = useMemo(
    () =>
      projects
        .flatMap((project) => project.worktrees)
        .flatMap((worktree) => worktree.tabs)
        .filter(
          (tab): tab is BrowserTab | WebPanel =>
            tab.kind !== 'terminal' &&
            (retainedTabIds.has(tab.id) || tab.id === activeTabId)
        ),
    [activeTabId, projects, retainedTabIds]
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
      focusSurface('terminal')
      setDesktopNotificationsOpen(false)
      setMobileNotificationsOpen(false)
      navigateToTerminal(terminal)
    },
    [focusSurface, navigateToTerminal]
  )
  const selectTab = useCallback(
    (tab: BrowserTab | WebPanel) => {
      focusSurface('tool')
      revealTool(tab, false)

      const target = targetForTab(projects, tab)
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

      if (toolPaneOpen && focusedSurfaceRef.current === 'tool') {
        const tab = selectedWorktreeTools[index]
        if (!tab) {
          return false
        }

        selectTab(tab)
        return true
      }

      return selectWorkspaceByIndex(index)
    },
    [
      selectedWorktree,
      selectTab,
      selectedWorktreeTools,
      selectWorkspaceByIndex,
      toolPaneOpen,
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

  const panelLaunchDisabled =
    !tabDialogProject ||
    !tabDialogWorktree ||
    tabDialogProject.availability.state === 'unavailable' ||
    Boolean(tabDialogWorktree.prunable) ||
    Boolean(pendingRemovals[tabDialogWorktree.id])
  const toolLaunchDisabled =
    !selectedProject ||
    !selectedWorktree ||
    selectedProject.availability.state === 'unavailable' ||
    Boolean(selectedWorktree.prunable) ||
    Boolean(pendingRemovals[selectedWorktree.id])
  const toggleToolPane = useCallback(() => {
    if (!selectedWorktree) {
      return
    }

    if (toolPaneOpen) {
      setToolPaneOpen(selectedWorktree.id, false)
      focusSurface('terminal')
      return
    }

    const tab = activeTab ?? selectedWorktreeTools.at(-1) ?? null
    if (tab) {
      retainTab(tab.id)
      setActiveTabByWorktree((current) => ({
        ...current,
        [tab.worktreeId]: tab.id
      }))
    }

    setToolPaneOpen(selectedWorktree.id, true)
  }, [
    activeTab,
    focusSurface,
    retainTab,
    selectedWorktree,
    selectedWorktreeTools,
    setToolPaneOpen,
    toolPaneOpen
  ])
  const focusToolSurface = useCallback(() => {
    focusSurface('tool')
    setPreserveTerminalFocusTabId(null)
  }, [focusSurface])

  useEffect(() => {
    if (desktopBridge) {
      return
    }

    const usesMacKeyboard = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
    const keydown = (event: KeyboardEvent) => {
      const modifierPressed = usesMacKeyboard
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey
      if (
        event.isComposing ||
        !event.altKey ||
        event.shiftKey ||
        !modifierPressed
      ) {
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
        toggleToolPane()
      } else {
        return
      }

      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener('keydown', keydown, true)
    return () => document.removeEventListener('keydown', keydown, true)
  }, [
    createSplitTerminal,
    desktopBridge,
    selectedWorktree,
    toggleToolPane,
    workspaceActionsBlocked
  ])

  useEffect(() => {
    if (!desktopBridge) {
      return
    }

    return desktopBridge.onCommand((command) => {
      if (command === 'reload') {
        if (!(toolPaneOpen && activeTab?.kind === 'browser')) {
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
        toolPaneOpen && focusedSurfaceRef.current === 'tool'
      const selectedTabIndex = command.startsWith('select-tab-')
        ? Number(command.at(-1)) - 1
        : null
      // SAFETY: DesktopCommand only has the four TerminalSplitDirection suffixes.
      const splitDirection = command.startsWith('split-terminal-')
        ? (command.slice('split-terminal-'.length) as TerminalSplitDirection)
        : null
      if (selectedTabIndex !== null) {
        selectFocusedSurfaceByIndex(selectedTabIndex)
      } else if (command === 'toggle-side-panel') {
        toggleToolPane()
      } else if (command === 'new-terminal') {
        if (toolSurfaceHasFocus) {
          if (!toolLaunchDisabled && !createBrowserTab.isPending) {
            createBrowserTab.mutate({ worktree: selectedWorktree })
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
      } else if (command === 'new-tab') {
        openDialog({
          type: 'tab',
          projectId: selectedProject.id,
          worktreeId: selectedWorktree.id
        })
      } else if (command === 'close-tab') {
        if (toolSurfaceHasFocus && activeTab) {
          requestCloseTab(activeTab)
        } else if (selectedTerminal) {
          terminalWorkflows.requestCloseTerminal(selectedTerminal)
        }
      }
    })
  }, [
    activeProject,
    activeTab,
    selectedProject,
    selectedTerminal,
    selectedWorktree,
    createBrowserTab.isPending,
    createBrowserTab.mutate,
    selectFocusedSurfaceByIndex,
    selectWorktree,
    toggleToolPane,
    toolLaunchDisabled,
    toolPaneOpen,
    workspaceActionsBlocked
  ])

  return (
    <>
      <TerminalBellAttention
        projects={projects}
        selectedTerminalId={selectedTerminalId}
      />
      <ProjectSwitcherShortcut blocked={dialog !== null} />
      <WorkspaceMobileHeader
        selectedTerminalId={selectedTerminalId}
        terminals={activeProjectTerminals}
        onSelectTerminal={selectTerminal}
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
          onOpenTabDialog={(project, worktree, trigger) =>
            openDialog(
              {
                type: 'tab',
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
          <SidePanelToggle
            open={toolPaneOpen}
            disabled={!selectedProject || !selectedWorktree}
            onToggle={toggleToolPane}
          />
          <div
            className={cn(
              'relative grid min-h-0 min-w-0 grid-cols-1',
              toolPaneOpen && 'min-[701px]:grid-cols-[minmax(0,1fr)_auto]'
            )}
          >
            <div
              className={cn(
                'relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)]',
                toolPaneOpen && 'max-[700px]:hidden'
              )}
              role="group"
              aria-label="Terminal tab group"
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
              <WorktreeToolPane
                worktreeName={selectedWorktree.name}
                visible={toolPaneOpen}
                tools={selectedWorktreeTools}
                activeTabId={activeTabId}
                webPanelRuntimeTitles={webPanelRuntimeTitles}
                browserTabLoading={browserTabLoading}
                definitions={webPanelDefinitionsQuery.data ?? []}
                definitionsLoading={
                  toolPaneOpen && webPanelDefinitionsQuery.isPending
                }
                definitionsError={webPanelDefinitionsQuery.isError}
                launchDisabled={
                  toolLaunchDisabled ||
                  createWebPanel.isPending ||
                  createBrowserTab.isPending
                }
                onSelectTab={selectTab}
                onCloseTab={requestCloseTab}
                onReorderTabs={reorderTools}
                onCreateBrowserTab={() =>
                  createBrowserTab.mutate({ worktree: selectedWorktree })
                }
                onOpenWebPanel={(definition) =>
                  createWebPanel.mutate({
                    worktree: selectedWorktree,
                    definition,
                    input: null
                  })
                }
                onFocusSurface={focusToolSurface}
              >
                {retainedTabs.map((tab) => {
                  const active = tab.id === activeTabId && toolPaneOpen
                  const autoFocusBlocked =
                    workspaceActionsBlocked ||
                    preserveTerminalFocusTabId === tab.id
                  return tab.kind === 'browser' ? (
                    <BrowserTabWorkspace
                      key={tab.id}
                      tab={tab}
                      active={active}
                      autoFocusBlocked={autoFocusBlocked}
                      inputBlocked={workspaceActionsBlocked}
                      onLoadingChange={updateBrowserTabLoading}
                      onFocusSurface={focusToolSurface}
                    />
                  ) : (
                    <WebPanelWorkspace
                      key={tab.id}
                      tab={tab}
                      active={active}
                      title={webPanelRuntimeTitles[tab.id] ?? tab.title}
                      reloadRevision={webPanelReloadRevisions[tab.id] ?? 0}
                      autoFocusBlocked={autoFocusBlocked}
                      onTitleChange={setWebPanelRuntimeTitle}
                      onDirtyChange={setWebPanelDirty}
                      onSelectWorkspace={selectWorkspaceByIndex}
                      onFocusSurface={focusToolSurface}
                    />
                  )
                })}
              </WorktreeToolPane>
            ) : null}
          </div>
        </div>
      </WorkspaceMain>
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
      <NewTabDialog
        open={dialog?.type === 'tab'}
        onOpenChange={(open) => !open && setDialog(null)}
        restoreFocusTo={dialogTriggerRef.current}
        worktreeName={tabDialogWorktree?.name ?? null}
        presets={availablePresets}
        presetDiagnostics={presetDiagnostics}
        presetsLoading={presetDefinitionsQuery.isPending}
        presetsError={presetDefinitionsQuery.isError}
        webPanelDefinitions={webPanelDefinitionsQuery.data ?? []}
        webPanelDefinitionsLoading={
          Boolean(tabDialogWorktree) && webPanelDefinitionsQuery.isPending
        }
        webPanelDefinitionsError={webPanelDefinitionsQuery.isError}
        launchDisabled={
          panelLaunchDisabled ||
          createWebPanel.isPending ||
          createBrowserTab.isPending
        }
        onCreateTerminal={(input) => {
          if (!tabDialogProject || !tabDialogWorktree) {
            return
          }

          setDialog(null)
          terminalWorkflows.createTerminalInWorktree(
            tabDialogProject,
            tabDialogWorktree,
            input
          )
        }}
        onCreateBrowserTab={() => {
          if (tabDialogWorktree) {
            createBrowserTab.mutate({ worktree: tabDialogWorktree })
          }
        }}
        onCreateWebPanel={(definition) => {
          if (!tabDialogWorktree) {
            return
          }

          createWebPanel.mutate({
            worktree: tabDialogWorktree,
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
      <CloseTabDialog
        tab={dialog?.type === 'close-tab' ? dialog.tab : null}
        reason={dialog?.type === 'close-tab' ? dialog.reason : null}
        busy={closeTab.isPending}
        onOpenChange={(open) => !open && setDialog(null)}
        restoreFocusTo={dialogTriggerRef.current}
        onConfirm={(tab) => {
          startTabClose(
            tab,
            tab.kind === 'browser'
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
