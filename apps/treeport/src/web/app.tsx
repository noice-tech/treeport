import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import { z } from 'zod'
import type {
  BrowserPanel,
  ProductEventDataMap,
  ProjectRecord,
  RemovePreview,
  TerminalRecord,
  WebPanel,
  WebPanelDefinition,
  WebPanelInput,
  WorktreeRecord
} from '@treeport/shared'
import { NotificationCenter } from './features/notifications/notification-center'
import { TerminalBellAttention } from './features/notifications/terminal-bell-attention'
import { BrowserPanelWorkspace } from './features/browser-panels/browser-panel-workspace'
import { ClosePanelDialog } from './features/panels/close-panel-dialog'
import { WebPanelWorkspace } from './features/web-panels/web-panel-workspace'
import { parseResponse } from 'hono/client'
import { rpc } from './api'
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
import { NewPanelDialog } from './features/panels/new-panel-dialog'
import { useToolPicker } from './features/panels/tool-picker-context'
import { useWorkspaceSurfaceFocus } from './features/panels/workspace-surface-focus-context'
import {
  SidePanelToggle,
  WorktreeToolPane
} from './features/panels/worktree-tool-pane'
import {
  TerminalWorkspace,
  useTerminalWorkflows
} from './features/terminals/terminal-workspace'
import { CreateWorktreeDialog } from './features/worktrees/create-worktree-dialog'
import { RemoveWorktreeDialog } from './features/worktrees/remove-worktree-dialog'
import { useWorktreeWorkflows } from './features/worktrees/worktree-workflows'
import { useSidebar } from './components/ui/sidebar'
import { METADATA_DEGRADED_GRACE_MS } from './metadata-sync'
import { notifyError } from './features/notifications/error-notifications'
import { useProjectEventsBridge } from './project-events-bridge'
import {
  projectsQueryOptions,
  terminalPresetDefinitionsQueryOptions,
  terminalPresetsQueryOptions
} from './project-metadata'
import {
  LAST_PROJECT_TERMINAL_STORAGE_PREFIX,
  LAST_WORKSPACE_ROUTE_STORAGE_KEY,
  openRequestMatchesTerminal,
  openRequestMatchesWorkspace,
  resolveWorkspaceRoute,
  targetForProject,
  targetForPanel,
  targetForTerminal,
  targetForWorktree
} from './workspace-navigation'
import { useWorkspaceNavigate } from './workspace-router-navigation'
import { ForceSpecificCursor } from './force-specific-cursor'
import { errorDetails } from './error-message'
import { cn } from './lib/utils'

const webPanelPermissionErrorSchema = z.object({
  error: z.object({ message: z.string() })
})

type AppDialog =
  | { type: 'project' }
  | { type: 'worktree'; project: ProjectRecord }
  | { type: 'panel'; projectId: string; worktreeId: string | null }
  | { type: 'presets' }
  | { type: 'remove'; worktree: WorktreeRecord; preview: RemovePreview }
  | { type: 'close-panel'; panel: BrowserPanel | WebPanel }
  | null

interface DeletePanelQuery {
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
  const { dismiss: dismissToolPicker, setOpen: setToolPickerOpen } =
    useToolPicker()
  const { focusedSurfaceRef, focusSurface, restoreEmptyToolFocus } =
    useWorkspaceSurfaceFocus()
  const desktopBridge = window.treeportDesktop
  const navigateToWorkspace = useWorkspaceNavigate()
  const queryClient = useQueryClient()
  const location = useLocation()
  const projectsQuery = useQuery(projectsQueryOptions)
  const projects = projectsQuery.data ?? []
  const presetsQuery = useQuery(terminalPresetsQueryOptions)
  const presets = presetsQuery.data ?? []
  const storedResumePath = localStorage.getItem(
    LAST_WORKSPACE_ROUTE_STORAGE_KEY
  )
  const workspaceResolution = projectsQuery.data
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
  const selectedPanel = workspaceResolution?.selection.panel ?? null
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
  const [retainedPanelIds, setRetainedPanelIds] = useState<Set<string>>(
    () => new Set()
  )
  const [toolPaneOpen, setToolPaneOpen] = useState(false)
  const [activePanelByWorktree, setActivePanelByWorktree] = useState<
    Record<string, string | null>
  >({})
  const [preserveTerminalFocusPanelId, setPreserveTerminalFocusPanelId] =
    useState<string | null>(null)
  const selectedWorktreeTools = useMemo(
    () =>
      selectedWorktree?.panels.filter(
        (panel): panel is BrowserPanel | WebPanel => panel.kind !== 'terminal'
      ) ?? [],
    [selectedWorktree]
  )
  const rememberedActivePanel = selectedWorktreeTools.find(
    (panel) => panel.id === activePanelByWorktree[selectedWorktree?.id ?? '']
  )
  const activePanel =
    selectedPanel ??
    rememberedActivePanel ??
    (toolPaneOpen ? selectedWorktreeTools.at(-1) : null) ??
    null
  const activePanelId = activePanel?.id ?? null
  const retainPanel = useCallback((panelId: string) => {
    setRetainedPanelIds((current) => {
      if (current.has(panelId)) {
        return current
      }

      const next = new Set(current)
      next.add(panelId)
      return next
    })
  }, [])
  const revealTool = useCallback(
    (panel: BrowserPanel | WebPanel, preserveTerminalFocus: boolean) => {
      retainPanel(panel.id)
      setActivePanelByWorktree((current) => ({
        ...current,
        [panel.worktreeId]: panel.id
      }))
      setToolPaneOpen(true)
      setPreserveTerminalFocusPanelId(preserveTerminalFocus ? panel.id : null)
    },
    [retainPanel]
  )
  const [webPanelReloadRevisions, setWebPanelReloadRevisions] = useState<
    Record<string, number>
  >({})
  const [webPanelRuntimeTitles, setWebPanelRuntimeTitles] = useState<
    Record<string, string>
  >({})
  const [browserPanelLoading, setBrowserPanelLoading] = useState<
    Record<string, boolean>
  >({})
  const updateBrowserPanelLoading = useCallback(
    (panelId: string, loading: boolean) => {
      setBrowserPanelLoading((current) => {
        if (Boolean(current[panelId]) === loading) {
          return current
        }

        const next = { ...current }
        if (loading) {
          next[panelId] = true
        } else {
          delete next[panelId]
        }

        return next
      })
    },
    []
  )
  const setWebPanelRuntimeTitle = useCallback(
    (panelId: string, title: string | null) => {
      setWebPanelRuntimeTitles((current) => {
        if (title === null) {
          if (current[panelId] === undefined) {
            return current
          }

          const next = { ...current }
          delete next[panelId]
          return next
        }

        return current[panelId] === title
          ? current
          : { ...current, [panelId]: title }
      })
    },
    []
  )
  useEffect(() => {
    const panels = projects.flatMap((project) =>
      project.worktrees.flatMap((worktree) => worktree.panels)
    )
    const panelIds = new Set(panels.map((panel) => panel.id))
    const webPanelIds = new Set(
      panels.filter((panel) => panel.kind === 'web').map((panel) => panel.id)
    )
    setWebPanelRuntimeTitles((current) => {
      const removedIds = Object.keys(current).filter(
        (panelId) => !webPanelIds.has(panelId)
      )
      if (removedIds.length === 0) {
        return current
      }

      const next = { ...current }
      removedIds.forEach((panelId) => delete next[panelId])
      return next
    })
    setBrowserPanelLoading((current) => {
      const removedIds = Object.keys(current).filter(
        (panelId) => !panelIds.has(panelId)
      )
      if (removedIds.length === 0) {
        return current
      }

      const next = { ...current }
      removedIds.forEach((panelId) => delete next[panelId])
      return next
    })
  }, [projects])
  const panelDialogProject =
    dialog?.type === 'panel'
      ? (projects.find((project) => project.id === dialog.projectId) ?? null)
      : null
  const panelDialogWorktree =
    dialog?.type === 'panel' && dialog.worktreeId
      ? (panelDialogProject?.worktrees.find(
          (worktree) => worktree.id === dialog.worktreeId
        ) ?? null)
      : null
  const webPanelDefinitionsWorktree =
    panelDialogWorktree ?? (toolPaneOpen ? selectedWorktree : null)
  const presetDefinitionsContext =
    dialog?.type === 'worktree'
      ? { projectId: dialog.project.id }
      : panelDialogWorktree
        ? { worktreeId: panelDialogWorktree.id }
        : selectedWorktree
          ? { worktreeId: selectedWorktree.id }
          : selectedProject
            ? { projectId: selectedProject.id }
            : undefined
  const presetDefinitionsQuery = useQuery(
    terminalPresetDefinitionsQueryOptions(presetDefinitionsContext)
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
        if (
          definition.permissions.length > 0 &&
          !definition.permissionsGranted
        ) {
          const response = await fetch(
            `/api/worktrees/${encodeURIComponent(
              worktree.id
            )}/web-panel-definitions/${encodeURIComponent(
              definition.id
            )}/permission-grant`,
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                granted: true,
                permissions: definition.permissions
              })
            }
          )
          if (!response.ok) {
            const result = webPanelPermissionErrorSchema.safeParse(
              await response.json().catch(() => null)
            )
            throw new Error(
              result.success
                ? result.data.error.message
                : 'Could not grant web panel permission'
            )
          }
        }

        return (
          await parseResponse(
            rpc.api.worktrees[':worktreeId'].panels.open.$post({
              param: { worktreeId: worktree.id },
              json: {
                definitionId: definition.id,
                input,
                launchCwd: null
              }
            })
          )
        ).panel
      })(),
    onSuccess: async (panel, { worktree }) => {
      setDialog(null)
      revealTool(panel, false)
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
                    candidate.panels.some(
                      (existing) => existing.id === panel.id
                    )
                      ? candidate
                      : {
                          ...candidate,
                          panels: [...candidate.panels, panel]
                        }
                  )
                }
          )
      )
      const target = targetForPanel(
        queryClient.getQueryData<ProjectRecord[]>(
          projectsQueryOptions.queryKey
        ) ?? projects,
        panel
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
  const createBrowserPanel = useMutation({
    mutationFn: ({ worktree }: { worktree: WorktreeRecord }) =>
      parseResponse(
        rpc.api.worktrees[':worktreeId']['browser-panels'].$post({
          param: { worktreeId: worktree.id },
          json: {}
        })
      ),
    onSuccess: async ({ panel }, { worktree }) => {
      setDialog(null)
      revealTool(panel, false)
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
                    candidate.panels.some(
                      (existing) => existing.id === panel.id
                    )
                      ? candidate
                      : {
                          ...candidate,
                          panels: [...candidate.panels, panel]
                        }
                  )
                }
          )
      )
      const target = targetForPanel(
        queryClient.getQueryData<ProjectRecord[]>(
          projectsQueryOptions.queryKey
        ) ?? projects,
        panel
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
  const closePanel = useMutation({
    mutationFn: ({
      panel,
      discardStoredData = false,
      force = false
    }: {
      panel: BrowserPanel | WebPanel
      discardStoredData?: boolean
      force?: boolean
      trigger?: HTMLElement
    }) => {
      const query: DeletePanelQuery = {}
      if (discardStoredData) {
        query.discardStoredData = 'true'
      }

      if (force) {
        query.force = 'true'
      }

      return parseResponse(
        rpc.api.panels[':panelId'].$delete({
          param: { panelId: panel.id },
          query
        })
      )
    },
    onSuccess: async (_, { panel }) => {
      setWebPanelRuntimeTitle(panel.id, null)
      setPreserveTerminalFocusPanelId((current) =>
        current === panel.id ? null : current
      )
      setRetainedPanelIds((current) => {
        if (!current.has(panel.id)) {
          return current
        }

        const next = new Set(current)
        next.delete(panel.id)
        return next
      })
      setDialog((current) =>
        current?.type === 'close-panel' && current.panel.id === panel.id
          ? null
          : current
      )
      const worktree = projects
        .flatMap((project) => project.worktrees)
        .find((candidate) => candidate.id === panel.worktreeId)
      const tools =
        worktree?.panels.filter(
          (candidate): candidate is BrowserPanel | WebPanel =>
            candidate.kind !== 'terminal'
        ) ?? []
      const closedIndex = tools.findIndex(
        (candidate) => candidate.id === panel.id
      )
      const remainingTools = tools.filter(
        (candidate) => candidate.id !== panel.id
      )
      const nextTool =
        remainingTools[closedIndex] ?? remainingTools[closedIndex - 1] ?? null
      setActivePanelByWorktree((current) =>
        current[panel.worktreeId] === panel.id
          ? { ...current, [panel.worktreeId]: nextTool?.id ?? null }
          : current
      )
      queryClient.setQueryData<ProjectRecord[]>(
        projectsQueryOptions.queryKey,
        (current) =>
          current?.map((project) => ({
            ...project,
            worktrees: project.worktrees.map((worktree) =>
              worktree.id === panel.worktreeId
                ? {
                    ...worktree,
                    panels: worktree.panels.filter(
                      (candidate) => candidate.id !== panel.id
                    )
                  }
                : worktree
            )
          }))
      )
      if (selectedPanel?.id === panel.id) {
        const target = worktree
          ? targetForWorktree(projects, worktree, selectedTerminalId)
          : null
        if (target) {
          await navigateToWorkspace(target, true)
        }
      }

      if (!nextTool) {
        restoreEmptyToolFocus()
      }

      void queryClient.invalidateQueries({
        queryKey: projectsQueryOptions.queryKey
      })
    },
    onError: (error, { panel, trigger }) => {
      if (
        panel.kind === 'browser' &&
        errorDetails(error).code === 'BROWSER_BEFORE_UNLOAD'
      ) {
        openDialog({ type: 'close-panel', panel }, trigger)
        return
      }

      notifyError(error, { operation: `close panel “${panel.title}”` })
    }
  })
  const requestClosePanel = (
    panel: BrowserPanel | WebPanel,
    trigger?: HTMLElement
  ) => {
    if (panel.kind === 'browser') {
      closePanel.mutate(trigger ? { panel, trigger } : { panel })
      return
    }

    void parseResponse(
      rpc.api.panels[':panelId'].storage.$get({
        param: { panelId: panel.id }
      })
    ).then(
      ({ hasData }) => {
        if (hasData) {
          openDialog({ type: 'close-panel', panel }, trigger)
        } else {
          closePanel.mutate({ panel })
        }
      },
      (error) => {
        notifyError(error, {
          operation: `check stored data for web panel “${panel.title}”`
        })
      }
    )
  }
  const navigatePanelOpenRequest = useCallback(
    (request: ProductEventDataMap['panel.open_requested']) => {
      if (
        !openRequestMatchesWorkspace(
          request.sourceTerminalId,
          request.sourcePanelId,
          selectedTerminalId,
          activePanelId
        )
      ) {
        return
      }

      revealTool(
        request.panel,
        request.sourceTerminalId !== null &&
          request.sourceTerminalId === selectedTerminalId
      )
      setWebPanelReloadRevisions((current) => ({
        ...current,
        [request.panelId]: (current[request.panelId] ?? 0) + 1
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
                    panels: worktree.panels.some(
                      (panel) => panel.id === request.panelId
                    )
                      ? worktree.panels.map((panel) =>
                          panel.id === request.panelId ? request.panel : panel
                        )
                      : [...worktree.panels, request.panel]
                  }
            )
          }))
      )
      const currentProjects =
        queryClient.getQueryData<ProjectRecord[]>(
          projectsQueryOptions.queryKey
        ) ?? []
      const target = targetForPanel(currentProjects, request.panel)
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
              const freshTarget = targetForPanel(freshProjects, request.panel)
              if (freshTarget) {
                await navigateToWorkspace(freshTarget)
              }
            })
      void navigation.catch((error) => {
        notifyError(error, { operation: 'open panel' })
      })
    },
    [
      activePanelId,
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
  const eventsDisconnected = useProjectEventsBridge(
    projectsQuery.data,
    navigatePanelOpenRequest,
    navigateWorkspaceOpenRequest
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
    if (!workspaceResolution?.canonical || !selectedPanel) {
      return
    }

    retainPanel(selectedPanel.id)
    setActivePanelByWorktree((current) =>
      current[selectedPanel.worktreeId] === selectedPanel.id
        ? current
        : { ...current, [selectedPanel.worktreeId]: selectedPanel.id }
    )
    setToolPaneOpen(true)
  }, [retainPanel, selectedPanel, workspaceResolution?.canonical])

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
  const retainedPanels = useMemo(
    () =>
      projects
        .flatMap((project) => project.worktrees)
        .flatMap((worktree) => worktree.panels)
        .filter(
          (panel): panel is BrowserPanel | WebPanel =>
            panel.kind !== 'terminal' &&
            (retainedPanelIds.has(panel.id) || panel.id === activePanelId)
        ),
    [activePanelId, projects, retainedPanelIds]
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

  const selectWorktree = (worktree: WorktreeRecord) => {
    focusSurface('terminal')
    const target = targetForWorktree(projects, worktree, selectedTerminalId)
    if (target) {
      void navigateToWorkspace(target)
    }

    closeDrawerAfterNavigation()
  }

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
    confirmRemoval
  } = useWorktreeWorkflows({
    projects,
    setDrawerOpen: (open) => {
      if (open) {
        setDrawerOpen(true)
      } else {
        closeDrawerAfterNavigation()
      }
    },
    onWorktreeSubmitted: () => setDialog(null),
    onRemovalNeedsConfirmation: (worktree, preview, trigger) =>
      openDialog({ type: 'remove', worktree, preview }, trigger),
    onRemovalCompleted: (worktreeId) =>
      setDialog((current) =>
        current?.type === 'remove' && current.worktree.id === worktreeId
          ? null
          : current
      ),
    selectedTerminalId
  })
  const terminalWorkflows = useTerminalWorkflows({
    projects,
    selectedWorktree,
    selectedTerminal
  })
  const selectTerminal = useCallback(
    (terminal: TerminalRecord) => {
      focusSurface('terminal')
      setDesktopNotificationsOpen(false)
      setMobileNotificationsOpen(false)
      terminalWorkflows.clearPendingTerminalSelection()
      navigateToTerminal(terminal)
    },
    [
      focusSurface,
      navigateToTerminal,
      terminalWorkflows.clearPendingTerminalSelection
    ]
  )
  const selectPanel = useCallback(
    (panel: BrowserPanel | WebPanel) => {
      terminalWorkflows.clearPendingTerminalSelection()
      focusSurface('tool')
      revealTool(panel, false)

      const target = targetForPanel(projects, panel)
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
      revealTool,
      terminalWorkflows.clearPendingTerminalSelection
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

      const pendingTerminal = terminalWorkflows.pendingTerminals.filter(
        (candidate) => candidate.worktreeId === selectedWorktree.id
      )[index - selectedWorktree.terminals.length]
      if (!pendingTerminal) {
        return false
      }

      focusSurface('terminal')
      terminalWorkflows.selectPendingTerminal(pendingTerminal.id)
      return true
    },
    [
      focusSurface,
      selectedWorktree,
      selectTerminal,
      terminalWorkflows.pendingTerminals,
      terminalWorkflows.selectPendingTerminal,
      workspaceActionsBlocked
    ]
  )

  const selectFocusedSurfaceByIndex = useCallback(
    (index: number) => {
      if (workspaceActionsBlocked || !selectedWorktree) {
        return false
      }

      if (
        toolPaneOpen &&
        !terminalWorkflows.selectedPendingTerminal &&
        focusedSurfaceRef.current === 'tool'
      ) {
        const panel = selectedWorktreeTools[index]
        if (!panel) {
          return false
        }

        selectPanel(panel)
        return true
      }

      return selectWorkspaceByIndex(index)
    },
    [
      selectedWorktree,
      selectPanel,
      selectedWorktreeTools,
      selectWorkspaceByIndex,
      terminalWorkflows.selectedPendingTerminal,
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
    !panelDialogProject ||
    !panelDialogWorktree ||
    panelDialogProject.availability.state === 'unavailable' ||
    Boolean(panelDialogWorktree.prunable) ||
    Boolean(pendingRemovals[panelDialogWorktree.id])
  const toolLaunchDisabled =
    !selectedProject ||
    !selectedWorktree ||
    selectedProject.availability.state === 'unavailable' ||
    Boolean(selectedWorktree.prunable) ||
    Boolean(pendingRemovals[selectedWorktree.id])
  const toggleToolPane = useCallback(() => {
    if (toolPaneOpen) {
      setToolPaneOpen(false)
      focusSurface('terminal')
      return
    }

    const panel = activePanel ?? selectedWorktreeTools.at(-1) ?? null
    if (panel) {
      retainPanel(panel.id)
      setActivePanelByWorktree((current) => ({
        ...current,
        [panel.worktreeId]: panel.id
      }))
    }

    setToolPaneOpen(true)
  }, [
    activePanel,
    focusSurface,
    retainPanel,
    selectedWorktreeTools,
    toolPaneOpen
  ])
  const focusToolSurface = useCallback(() => {
    focusSurface('tool')
    setPreserveTerminalFocusPanelId(null)
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
        event.key.toLocaleLowerCase() !== 'b' ||
        !event.altKey ||
        event.shiftKey ||
        !modifierPressed ||
        workspaceActionsBlocked ||
        !selectedWorktree
      ) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      toggleToolPane()
    }
    document.addEventListener('keydown', keydown, true)
    return () => document.removeEventListener('keydown', keydown, true)
  }, [desktopBridge, selectedWorktree, toggleToolPane, workspaceActionsBlocked])

  useEffect(() => {
    if (!desktopBridge) {
      return
    }

    return desktopBridge.onCommand((command) => {
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

      const toolSurfaceHasFocus =
        toolPaneOpen && focusedSurfaceRef.current === 'tool'
      const selectedTabIndex = command.startsWith('select-tab-')
        ? Number(command.at(-1)) - 1
        : null
      if (selectedTabIndex !== null) {
        selectFocusedSurfaceByIndex(selectedTabIndex)
      } else if (command === 'toggle-side-panel') {
        toggleToolPane()
      } else if (command === 'new-terminal') {
        if (toolSurfaceHasFocus) {
          if (selectedWorktreeTools.length > 0) {
            setToolPickerOpen(true)
          }
        } else {
          terminalWorkflows.createTerminalInWorktree(
            selectedProject,
            selectedWorktree,
            { name: 'Shell' }
          )
        }
      } else if (command === 'new-panel') {
        openDialog({
          type: 'panel',
          projectId: selectedProject.id,
          worktreeId: selectedWorktree.id
        })
      } else if (command === 'close-panel') {
        if (toolSurfaceHasFocus && activePanel) {
          requestClosePanel(activePanel)
        } else if (
          !terminalWorkflows.selectedPendingTerminal &&
          selectedTerminal
        ) {
          terminalWorkflows.requestCloseTerminal(selectedTerminal)
        }
      }
    })
  }, [
    activeProject,
    activePanel,
    selectedProject,
    selectedTerminal,
    selectedWorktree,
    selectedWorktreeTools.length,
    selectFocusedSurfaceByIndex,
    setToolPickerOpen,
    terminalWorkflows.selectedPendingTerminal,
    toggleToolPane,
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
        selectedTerminalId={
          terminalWorkflows.selectedPendingTerminal ? null : selectedTerminalId
        }
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
          selectedTerminalId={
            terminalWorkflows.selectedPendingTerminal
              ? null
              : selectedTerminalId
          }
          selectedPendingTerminalId={
            terminalWorkflows.selectedPendingTerminal?.id ?? null
          }
          pendingTerminals={terminalWorkflows.pendingTerminals}
          pendingWorktrees={pendingWorktrees}
          pendingRemovals={pendingRemovals}
          onRetryProjects={() => void projectsQuery.refetch()}
          onSelectTerminal={selectTerminal}
          onSelectPendingTerminal={(pendingTerminalId) => {
            focusSurface('terminal')
            terminalWorkflows.selectPendingTerminal(pendingTerminalId)
          }}
          onCloseTerminal={terminalWorkflows.requestCloseTerminal}
          onSelectWorktree={selectWorktree}
          onPrepareRemoval={prepareRemoval}
          onOpenPanelDialog={(project, worktree, trigger) =>
            openDialog(
              {
                type: 'panel',
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
      <WorkspaceMain>
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
                selectedPendingTerminal={
                  terminalWorkflows.selectedPendingTerminal
                }
                pendingTerminals={terminalWorkflows.pendingTerminals}
                loading={projectsQuery.isPending}
                dialogOpen={dialog !== null}
              />
            </div>
            {selectedWorktree ? (
              <WorktreeToolPane
                worktreeName={selectedWorktree.name}
                visible={toolPaneOpen}
                tools={selectedWorktreeTools}
                activePanelId={activePanelId}
                webPanelRuntimeTitles={webPanelRuntimeTitles}
                browserPanelLoading={browserPanelLoading}
                definitions={webPanelDefinitionsQuery.data ?? []}
                definitionsLoading={
                  toolPaneOpen && webPanelDefinitionsQuery.isPending
                }
                definitionsError={webPanelDefinitionsQuery.isError}
                launchDisabled={
                  toolLaunchDisabled ||
                  createWebPanel.isPending ||
                  createBrowserPanel.isPending
                }
                onSelectPanel={selectPanel}
                onClosePanel={requestClosePanel}
                onCreateBrowserPanel={() =>
                  createBrowserPanel.mutate({ worktree: selectedWorktree })
                }
                onOpenWebPanel={(definition) =>
                  createWebPanel.mutate({
                    worktree: selectedWorktree,
                    definition,
                    input: null
                  })
                }
              >
                {retainedPanels.map((panel) => {
                  const active = panel.id === activePanelId && toolPaneOpen
                  const autoFocusBlocked =
                    workspaceActionsBlocked ||
                    preserveTerminalFocusPanelId === panel.id
                  return panel.kind === 'browser' ? (
                    <BrowserPanelWorkspace
                      key={panel.id}
                      panel={panel}
                      active={active}
                      autoFocusBlocked={autoFocusBlocked}
                      onLoadingChange={updateBrowserPanelLoading}
                      onFocusSurface={focusToolSurface}
                    />
                  ) : (
                    <WebPanelWorkspace
                      key={panel.id}
                      panel={panel}
                      active={active}
                      title={webPanelRuntimeTitles[panel.id] ?? panel.title}
                      reloadRevision={webPanelReloadRevisions[panel.id] ?? 0}
                      autoFocusBlocked={autoFocusBlocked}
                      onTitleChange={setWebPanelRuntimeTitle}
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
        onSubmit={submitWorktreeCreation}
      />
      <NewPanelDialog
        open={dialog?.type === 'panel'}
        onOpenChange={(open) => !open && setDialog(null)}
        restoreFocusTo={dialogTriggerRef.current}
        worktreeName={panelDialogWorktree?.name ?? null}
        presets={availablePresets}
        presetDiagnostics={presetDiagnostics}
        presetsLoading={presetDefinitionsQuery.isPending}
        presetsError={presetDefinitionsQuery.isError}
        webPanelDefinitions={webPanelDefinitionsQuery.data ?? []}
        webPanelDefinitionsLoading={
          Boolean(panelDialogWorktree) && webPanelDefinitionsQuery.isPending
        }
        webPanelDefinitionsError={webPanelDefinitionsQuery.isError}
        launchDisabled={
          panelLaunchDisabled ||
          createWebPanel.isPending ||
          createBrowserPanel.isPending
        }
        onCreateTerminal={(input) => {
          if (!panelDialogProject || !panelDialogWorktree) {
            return
          }

          setDialog(null)
          terminalWorkflows.createTerminalInWorktree(
            panelDialogProject,
            panelDialogWorktree,
            input
          )
        }}
        onCreateBrowserPanel={() => {
          if (panelDialogWorktree) {
            createBrowserPanel.mutate({ worktree: panelDialogWorktree })
          }
        }}
        onCreateWebPanel={(definition) => {
          if (!panelDialogWorktree) {
            return
          }

          createWebPanel.mutate({
            worktree: panelDialogWorktree,
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
      <ClosePanelDialog
        panel={dialog?.type === 'close-panel' ? dialog.panel : null}
        busy={closePanel.isPending}
        onOpenChange={(open) => !open && setDialog(null)}
        restoreFocusTo={dialogTriggerRef.current}
        onConfirm={(panel) => {
          closePanel.mutate(
            panel.kind === 'browser'
              ? { panel, force: true }
              : { panel, discardStoredData: true }
          )
        }}
      />
      <RemoveWorktreeDialog
        worktree={dialog?.type === 'remove' ? dialog.worktree : null}
        preview={dialog?.type === 'remove' ? dialog.preview : null}
        busy={
          dialog?.type === 'remove' &&
          pendingRemovals[dialog.worktree.id] !== undefined
        }
        onOpenChange={(open) => !open && setDialog(null)}
        restoreFocusTo={dialogTriggerRef.current}
        onConfirm={confirmRemoval}
      />
    </>
  )
}
