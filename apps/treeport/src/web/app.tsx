import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import type {
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
import { CloseWebPanelDialog } from './features/web-panels/close-web-panel-dialog'
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
import { NewPanelDialog } from './features/panels/new-panel-dialog'
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
  panelOpenRequestMatchesTerminal,
  resolveWorkspaceRoute,
  targetForProject,
  targetForTerminal,
  targetForWebPanel,
  targetForWorktree
} from './workspace-navigation'
import { useWorkspaceNavigate } from './workspace-router-navigation'
import { ForceSpecificCursor } from './force-specific-cursor'

type AppDialog =
  | { type: 'project' }
  | { type: 'worktree'; project: ProjectRecord }
  | { type: 'panel'; projectId: string; worktreeId: string | null }
  | { type: 'presets' }
  | { type: 'remove'; worktree: WorktreeRecord; preview: RemovePreview }
  | { type: 'close-web-panel'; panel: WebPanel }
  | null

interface DeletePanelQuery {
  discardStoredData?: string
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
  const selectedTerminal = workspaceResolution?.selection.terminal ?? null
  const selectedTerminalId = selectedTerminal?.id ?? null
  const selectedWebPanel = workspaceResolution?.selection.panel ?? null
  const selectedWebPanelId = selectedWebPanel?.id ?? null
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
  const [retainedWebPanelIds, setRetainedWebPanelIds] = useState<Set<string>>(
    () => new Set()
  )
  const [webPanelReloadRevisions, setWebPanelReloadRevisions] = useState<
    Record<string, number>
  >({})
  const [webPanelRuntimeTitles, setWebPanelRuntimeTitles] = useState<
    Record<string, string>
  >({})
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
    const panelIds = new Set(
      projects.flatMap((project) =>
        project.worktrees.flatMap((worktree) =>
          worktree.panels
            .filter((panel) => panel.kind === 'web')
            .map((panel) => panel.id)
        )
      )
    )
    setWebPanelRuntimeTitles((current) => {
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
    queryKey: ['web-panel-definitions', panelDialogWorktree?.id],
    queryFn: async () =>
      (
        await parseResponse(
          rpc.api.worktrees[':worktreeId']['web-panel-definitions'].$get({
            param: { worktreeId: panelDialogWorktree!.id }
          })
        )
      ).definitions,
    enabled: Boolean(panelDialogWorktree)
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
      parseResponse(
        rpc.api.worktrees[':worktreeId'].panels.$post({
          param: { worktreeId: worktree.id },
          json: {
            definitionId: definition.id,
            input,
            launchCwd: null
          }
        })
      ).then((result) => result.panel),
    onSuccess: async (panel) => {
      setDialog(null)
      await queryClient.invalidateQueries({
        queryKey: projectsQueryOptions.queryKey
      })
      const target = targetForWebPanel(
        queryClient.getQueryData<ProjectRecord[]>(
          projectsQueryOptions.queryKey
        ) ?? projects,
        panel
      )
      if (target) {
        await navigateToWorkspace(target)
      }
    },
    onError: (error, { worktree, definition }) => {
      notifyError(error, {
        operation: `create web panel “${definition.title}” in worktree “${worktree.name}”`
      })
    }
  })
  const closeWebPanel = useMutation({
    mutationFn: ({
      panel,
      discardStoredData = false
    }: {
      panel: WebPanel
      discardStoredData?: boolean
    }) => {
      const query: DeletePanelQuery = {}
      if (discardStoredData) {
        query.discardStoredData = 'true'
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
      setDialog((current) =>
        current?.type === 'close-web-panel' && current.panel.id === panel.id
          ? null
          : current
      )
      if (selectedWebPanel?.id === panel.id) {
        const worktree = projects
          .flatMap((project) => project.worktrees)
          .find((candidate) => candidate.id === panel.worktreeId)
        const target = worktree ? targetForWorktree(projects, worktree) : null
        if (target) {
          await navigateToWorkspace(target, true)
        }
      }

      await queryClient.invalidateQueries({
        queryKey: projectsQueryOptions.queryKey
      })
    },
    onError: (error, { panel }) => {
      notifyError(error, { operation: `close web panel “${panel.title}”` })
    }
  })
  const requestCloseWebPanel = (panel: WebPanel, trigger?: HTMLElement) => {
    void parseResponse(
      rpc.api.panels[':panelId'].storage.$get({
        param: { panelId: panel.id }
      })
    ).then(
      ({ hasData }) => {
        if (hasData) {
          openDialog({ type: 'close-web-panel', panel }, trigger)
        } else {
          closeWebPanel.mutate({ panel })
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
      setWebPanelReloadRevisions((current) => ({
        ...current,
        [request.panelId]: (current[request.panelId] ?? 0) + 1
      }))
      if (
        !panelOpenRequestMatchesTerminal(
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
          const panel = freshProjects
            .flatMap((project) => project.worktrees)
            .find((worktree) => worktree.id === request.worktreeId)
            ?.panels.find(
              (candidate): candidate is WebPanel =>
                candidate.kind === 'web' && candidate.id === request.panelId
            )
          const target = panel ? targetForWebPanel(freshProjects, panel) : null
          if (target) {
            await navigateToWorkspace(target)
          }
        })
        .catch((error) => {
          notifyError(error, { operation: 'open web panel' })
        })
    },
    [navigateToWorkspace, queryClient, selectedTerminalId]
  )
  const eventsDisconnected = useProjectEventsBridge(
    projectsQuery.data,
    navigatePanelOpenRequest
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
    if (!selectedWebPanelId) {
      return
    }

    setRetainedWebPanelIds((current) => {
      if (current.has(selectedWebPanelId)) {
        return current
      }

      const next = new Set(current)
      next.add(selectedWebPanelId)
      return next
    })
  }, [selectedWebPanelId])

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
  const retainedWebPanels = useMemo(
    () =>
      projects
        .flatMap((project) => project.worktrees)
        .flatMap((worktree) => worktree.panels)
        .filter(
          (panel): panel is WebPanel =>
            panel.kind === 'web' &&
            (retainedWebPanelIds.has(panel.id) ||
              panel.id === selectedWebPanelId)
        ),
    [projects, retainedWebPanelIds, selectedWebPanelId]
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
      setDesktopNotificationsOpen(false)
      setMobileNotificationsOpen(false)
      terminalWorkflows.clearPendingTerminalSelection()
      navigateToTerminal(terminal)
    },
    [navigateToTerminal, terminalWorkflows.clearPendingTerminalSelection]
  )
  const selectWebPanel = useCallback(
    (panel: WebPanel) => {
      terminalWorkflows.clearPendingTerminalSelection()

      const target = targetForWebPanel(projects, panel)
      if (target) {
        void navigateToWorkspace(target)
      }

      closeDrawerAfterNavigation()
    },
    [
      closeDrawerAfterNavigation,
      navigateToWorkspace,
      projects,
      terminalWorkflows.clearPendingTerminalSelection
    ]
  )
  const selectWorkspaceByIndex = useCallback(
    (index: number) => {
      if (
        dialog ||
        projectSwitcherOpen ||
        (isMobile && drawerOpen) ||
        !selectedWorktree
      ) {
        return false
      }

      const terminal = selectedWorktree.terminals[index]
      if (terminal) {
        selectTerminal(terminal)
        return true
      }

      const webPanels = selectedWorktree.panels.filter(
        (panel): panel is WebPanel => panel.kind === 'web'
      )
      const panel = webPanels[index - selectedWorktree.terminals.length]
      if (panel) {
        selectWebPanel(panel)
        return true
      }

      const pendingTerminal = terminalWorkflows.pendingTerminals.filter(
        (candidate) => candidate.worktreeId === selectedWorktree.id
      )[index - selectedWorktree.terminals.length - webPanels.length]
      if (!pendingTerminal) {
        return false
      }

      terminalWorkflows.selectPendingTerminal(pendingTerminal.id)
      return true
    },
    [
      dialog,
      drawerOpen,
      isMobile,
      projectSwitcherOpen,
      selectedWorktree,
      selectTerminal,
      selectWebPanel,
      terminalWorkflows.pendingTerminals,
      terminalWorkflows.selectPendingTerminal
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

      if (!selectWorkspaceByIndex(index)) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener('keydown', keydown, true)
    return () => document.removeEventListener('keydown', keydown, true)
  }, [selectWorkspaceByIndex])

  const panelLaunchDisabled =
    !panelDialogProject ||
    !panelDialogWorktree ||
    panelDialogProject.availability.state === 'unavailable' ||
    Boolean(panelDialogWorktree.prunable) ||
    Boolean(pendingRemovals[panelDialogWorktree.id])

  useEffect(() => {
    if (!desktopBridge) {
      return
    }

    return desktopBridge.onCommand((command) => {
      if (dialog || projectSwitcherOpen || (isMobile && drawerOpen)) {
        return
      }

      if (command === 'new-worktree') {
        if (
          activeProject &&
          activeProject.availability.state !== 'unavailable'
        ) {
          openDialog({ type: 'worktree', project: activeProject })
        }

        return
      }

      if (!selectedProject || !selectedWorktree) {
        return
      }

      if (command === 'new-terminal') {
        terminalWorkflows.createTerminalInWorktree(
          selectedProject,
          selectedWorktree,
          { name: 'Shell' }
        )
      } else if (command === 'new-panel') {
        openDialog({
          type: 'panel',
          projectId: selectedProject.id,
          worktreeId: selectedWorktree.id
        })
      } else if (command === 'close-panel') {
        if (selectedWebPanel) {
          requestCloseWebPanel(selectedWebPanel)
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
    dialog,
    drawerOpen,
    isMobile,
    projectSwitcherOpen,
    selectedProject,
    selectedTerminal,
    selectedWebPanel,
    selectedWorktree,
    terminalWorkflows.selectedPendingTerminal
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
          terminalWorkflows.selectedPendingTerminal || selectedWebPanel
            ? null
            : selectedTerminalId
        }
        terminals={activeProjectTerminals}
        onSelectTerminal={selectTerminal}
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
            terminalWorkflows.selectedPendingTerminal || selectedWebPanel
              ? null
              : selectedTerminalId
          }
          selectedWebPanelId={
            terminalWorkflows.selectedPendingTerminal
              ? null
              : (selectedWebPanel?.id ?? null)
          }
          webPanelRuntimeTitles={webPanelRuntimeTitles}
          selectedPendingTerminalId={
            terminalWorkflows.selectedPendingTerminal?.id ?? null
          }
          pendingTerminals={terminalWorkflows.pendingTerminals}
          pendingWorktrees={pendingWorktrees}
          pendingRemovals={pendingRemovals}
          onRetryProjects={() => void projectsQuery.refetch()}
          onSelectTerminal={selectTerminal}
          onSelectPendingTerminal={terminalWorkflows.selectPendingTerminal}
          onCloseTerminal={terminalWorkflows.requestCloseTerminal}
          onSelectWebPanel={selectWebPanel}
          onCloseWebPanel={requestCloseWebPanel}
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
        {retainedWebPanels.map((panel) => {
          const active =
            panel.id === selectedWebPanelId &&
            !terminalWorkflows.selectedPendingTerminal
          const title = webPanelRuntimeTitles[panel.id] ?? panel.title
          return (
            <WebPanelWorkspace
              key={panel.id}
              panel={panel}
              active={active}
              title={title}
              reloadRevision={webPanelReloadRevisions[panel.id] ?? 0}
              autoFocusBlocked={
                dialog !== null ||
                projectSwitcherOpen ||
                (isMobile && drawerOpen)
              }
              onTitleChange={setWebPanelRuntimeTitle}
              onSelectWorkspace={selectWorkspaceByIndex}
            />
          )
        })}
        {(!selectedWebPanel || terminalWorkflows.selectedPendingTerminal) && (
          <TerminalWorkspace
            selectedWorktree={selectedWorktree}
            selectedTerminal={selectedTerminal}
            selectedPendingTerminal={terminalWorkflows.selectedPendingTerminal}
            pendingTerminals={terminalWorkflows.pendingTerminals}
            loading={projectsQuery.isPending}
            dialogOpen={dialog !== null}
          />
        )}
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
        launchDisabled={panelLaunchDisabled || createWebPanel.isPending}
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
      <CloseWebPanelDialog
        panel={dialog?.type === 'close-web-panel' ? dialog.panel : null}
        busy={closeWebPanel.isPending}
        onOpenChange={(open) => !open && setDialog(null)}
        restoreFocusTo={dialogTriggerRef.current}
        onConfirm={(panel) =>
          closeWebPanel.mutate({ panel, discardStoredData: true })
        }
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
