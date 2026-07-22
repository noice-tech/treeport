import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { io, type Socket } from 'socket.io-client'
import {
  ArrowDownIcon,
  ArrowPathIcon,
  ArrowUpIcon,
  Bars3Icon,
  CheckIcon,
  ChevronRightIcon,
  CommandLineIcon,
  FolderIcon,
  PencilIcon,
  PlusIcon,
  SwatchIcon,
  TrashIcon,
  XMarkIcon
} from '@heroicons/react/16/solid'
import {
  parseEventsSnapshot,
  parseProductEvent,
  parseTerminalRuntimeMetadata,
  SOCKET_IO_PATH,
  TERMINAL_ARGUMENT_MAX_LENGTH,
  TERMINAL_EXECUTABLE_MAX_LENGTH,
  TERMINAL_NAME_MAX_LENGTH,
  TERMINAL_PRESET_ARGUMENT_MAX_COUNT
} from '@tasktty/shared'
import type {
  EventsClientToServerEvents,
  EventsServerToClientEvents,
  ProjectColor,
  ProjectRecord,
  RecentProjectRecord,
  RemovePreview,
  TerminalPreset,
  TerminalRecord,
  WorktreeRecord
} from '@tasktty/shared'
import { ApiError, apiClient } from './api.js'
import { Button } from './components/ui/button.js'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from './components/ui/collapsible.js'
import { Input } from './components/ui/input.js'
import { Label } from './components/ui/label.js'
import { NativeSelect } from './components/ui/native-select.js'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from './components/ui/popover.js'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from './components/ui/tooltip.js'
import { cn } from './lib/utils.js'
import {
  createInvalidationCoalescer,
  METADATA_DEGRADED_GRACE_MS,
  METADATA_STALE_TIME_MS,
  metadataRetryDelay,
  shouldRetryMetadataQuery
} from './metadata-sync.js'
import {
  terminalProgressLabel,
  terminalSessions,
  type TerminalProgress
} from './terminal-session.js'
import { TerminalView } from './terminal-view.js'

const MIN_SIDEBAR_WIDTH = 240
const MAX_SIDEBAR_WIDTH = 420
const DEFAULT_SIDEBAR_WIDTH = 272
const COLLAPSED_PROJECTS_STORAGE_KEY = 'tasktty-collapsed-projects'
const EMPTY_BELL_ATTENTION: ReadonlySet<string> = new Set()
const EMPTY_RUNTIME_TITLES: ReadonlyMap<string, string> = new Map()
const EMPTY_TERMINAL_PROGRESS: ReadonlyMap<string, TerminalProgress> = new Map()
const MANUAL_CLEANUP_PREFIX = 'Manual cleanup required:'
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  "[tabindex]:not([tabindex='-1'])"
].join(',')

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ].filter(
    (element) =>
      !element.closest('[inert]') && element.getClientRects().length > 0
  )
}

function trapTabKey(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== 'Tab') {
    return
  }

  const elements = focusableElements(container)
  if (!elements.length) {
    event.preventDefault()
    container.focus()
    return
  }

  const first = elements[0]!
  const last = elements.at(-1)!
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width))
}

function needsManualCleanup(worktree: WorktreeRecord): boolean {
  return Boolean(worktree.cleanupError?.startsWith(MANUAL_CLEANUP_PREFIX))
}

type Modal =
  | { type: 'project' }
  | { type: 'worktree'; project: ProjectRecord }
  | { type: 'presets' }
  | { type: 'remove'; worktree: WorktreeRecord; preview: RemovePreview }
  | null

type RemovalStage = 'checking' | 'removing'

const projectsQueryKey = ['projects'] as const
const recentProjectsQueryKey = ['recent-projects'] as const
const terminalPresetsQueryKey = ['terminal-presets'] as const

const PROJECT_COLOR_OPTIONS: Array<{
  value: ProjectColor | null
  label: string
  swatch: string
  check: string
}> = [
  {
    value: null,
    label: 'Neutral',
    swatch: 'bg-zinc-500 hover:bg-zinc-400',
    check: 'fill-white'
  },
  {
    value: 'rose',
    label: 'Rose',
    swatch: 'bg-rose-400 hover:bg-rose-300',
    check: 'fill-white'
  },
  {
    value: 'orange',
    label: 'Orange',
    swatch: 'bg-orange-400 hover:bg-orange-300',
    check: 'fill-zinc-950'
  },
  {
    value: 'amber',
    label: 'Amber',
    swatch: 'bg-amber-400 hover:bg-amber-300',
    check: 'fill-zinc-950'
  },
  {
    value: 'emerald',
    label: 'Emerald',
    swatch: 'bg-emerald-400 hover:bg-emerald-300',
    check: 'fill-zinc-950'
  },
  {
    value: 'cyan',
    label: 'Cyan',
    swatch: 'bg-cyan-400 hover:bg-cyan-300',
    check: 'fill-zinc-950'
  },
  {
    value: 'blue',
    label: 'Blue',
    swatch: 'bg-blue-400 hover:bg-blue-300',
    check: 'fill-white'
  },
  {
    value: 'violet',
    label: 'Violet',
    swatch: 'bg-violet-400 hover:bg-violet-300',
    check: 'fill-white'
  },
  {
    value: 'pink',
    label: 'Pink',
    swatch: 'bg-pink-400 hover:bg-pink-300',
    check: 'fill-white'
  }
]

const PROJECT_COLOR_STYLES: Record<
  ProjectColor,
  { chevron: string; rail: string }
> = {
  rose: { chevron: 'fill-rose-400', rail: 'border-rose-400/50' },
  orange: { chevron: 'fill-orange-400', rail: 'border-orange-400/50' },
  amber: { chevron: 'fill-amber-400', rail: 'border-amber-400/50' },
  emerald: { chevron: 'fill-emerald-400', rail: 'border-emerald-400/50' },
  cyan: { chevron: 'fill-cyan-400', rail: 'border-cyan-400/50' },
  blue: { chevron: 'fill-blue-400', rail: 'border-blue-400/50' },
  violet: { chevron: 'fill-violet-400', rail: 'border-violet-400/50' },
  pink: { chevron: 'fill-pink-400', rail: 'border-pink-400/50' }
}

interface PendingWorktreeCreation {
  id: string
  projectId: string
  typedName: string
  canonicalName: string
  destinationPath: string
  base: 'default' | 'current'
  initialTerminal: { name: string; argv?: string[] }
  sourceWorktreeId?: string
}

interface WorktreeDestination {
  name: string
  path: string
}

export default function App() {
  const queryClient = useQueryClient()
  const projectsQuery = useQuery({
    queryKey: projectsQueryKey,
    queryFn: apiClient.projects,
    staleTime: METADATA_STALE_TIME_MS,
    retry: shouldRetryMetadataQuery,
    retryDelay: metadataRetryDelay,
    refetchInterval: 5_000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true
  })
  const projects = projectsQuery.data ?? []
  const presetsQuery = useQuery({
    queryKey: terminalPresetsQueryKey,
    queryFn: apiClient.terminalPresets,
    staleTime: 0,
    refetchInterval: 5_000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true
  })
  const presets = presetsQuery.data ?? []
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(
    () => localStorage.getItem('tasktty-terminal')
  )
  const [focusTerminalId, setFocusTerminalId] = useState<string | null>(null)
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(
    null
  )
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [openProjectColorPickerId, setOpenProjectColorPickerId] = useState<
    string | null
  >(null)
  const [isMobile, setIsMobile] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modal, setModal] = useState<Modal>(null)
  const [pendingWorktrees, setPendingWorktrees] = useState<
    PendingWorktreeCreation[]
  >([])
  const [pendingRemovals, setPendingRemovals] = useState<
    Record<string, RemovalStage>
  >({})
  const [collapsedProjectIds, setCollapsedProjectIds] = useState(
    () =>
      new Set(
        (localStorage.getItem(COLLAPSED_PROJECTS_STORAGE_KEY) ?? '')
          .split('\n')
          .filter(Boolean)
      )
  )
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const savedWidth = Number.parseInt(
      localStorage.getItem('tasktty-sidebar-width') ?? '',
      10
    )
    return Number.isFinite(savedWidth)
      ? clampSidebarWidth(savedWidth)
      : DEFAULT_SIDEBAR_WIDTH
  })
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const [eventsDisconnected, setEventsDisconnected] = useState(false)
  const [showSyncDegraded, setShowSyncDegraded] = useState(false)
  const selectedWorktreeIdRef = useRef<string | null>(null)
  const resizeOrigin = useRef<{ pointerX: number; width: number } | null>(null)
  const drawerRef = useRef<HTMLElement | null>(null)
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null)
  const openProjectButtonRef = useRef<HTMLButtonElement | null>(null)
  const modalTriggerRef = useRef<HTMLElement | null>(null)
  const removalGuardsRef = useRef(new Set<string>())

  useEffect(() => {
    if (collapsedProjectIds.size) {
      localStorage.setItem(
        COLLAPSED_PROJECTS_STORAGE_KEY,
        [...collapsedProjectIds].join('\n')
      )
    } else {
      localStorage.removeItem(COLLAPSED_PROJECTS_STORAGE_KEY)
    }
  }, [collapsedProjectIds])

  useEffect(() => {
    if (projectsQuery.error && projectsQuery.data === undefined) {
      showError(setError)(projectsQuery.error)
    }
  }, [projectsQuery.data, projectsQuery.error])

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

  useEffect(() => {
    const next = projectsQuery.data
    if (!next) {
      return
    }

    setSelectedTerminalId((current) => {
      if (
        current &&
        next.some((project) =>
          project.worktrees.some((worktree) =>
            worktree.terminals.some((terminal) => terminal.id === current)
          )
        )
      ) {
        return current
      }

      const selectedWorktree = next
        .flatMap((project) => project.worktrees)
        .find((worktree) => worktree.id === selectedWorktreeIdRef.current)
      if (selectedWorktreeIdRef.current) {
        return selectedWorktree?.terminals[0]?.id ?? null
      }

      return (
        next.flatMap((project) =>
          project.worktrees.flatMap((worktree) => worktree.terminals)
        )[0]?.id ?? null
      )
    })
  }, [projectsQuery.data])

  useEffect(() => {
    if (projectsQuery.data === undefined) {
      return
    }

    if (selectedTerminalId) {
      localStorage.setItem('tasktty-terminal', selectedTerminalId)
    } else {
      localStorage.removeItem('tasktty-terminal')
    }
  }, [projectsQuery.data, selectedTerminalId])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)')
    const update = () => setIsMobile(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!isMobile || !drawerOpen) {
      return
    }

    const drawer = drawerRef.current
    if (!drawer) {
      return
    }

    const previouslyFocused = document.activeElement as HTMLElement | null
    const frame = window.requestAnimationFrame(() => {
      focusableElements(drawer)[0]?.focus()
    })
    return () => {
      window.cancelAnimationFrame(frame)
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus()
      } else {
        drawerTriggerRef.current?.focus()
      }
    }
  }, [drawerOpen, isMobile])

  useEffect(() => {
    if (!isMobile || !drawerOpen || modal || openProjectColorPickerId) {
      return
    }

    const drawer = drawerRef.current
    if (!drawer) {
      return
    }

    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setDrawerOpen(false)
        return
      }

      trapTabKey(event, drawer)
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [drawerOpen, isMobile, modal, openProjectColorPickerId])

  useEffect(() => {
    const events: Socket<
      EventsServerToClientEvents,
      EventsClientToServerEvents
    > = io('/events', {
      path: SOCKET_IO_PATH,
      transports: ['websocket'],
      autoConnect: false,
      retries: 0
    })
    const refreshes = createInvalidationCoalescer(() =>
      queryClient.invalidateQueries(
        { queryKey: projectsQueryKey },
        { cancelRefetch: false }
      )
    )
    const projectRefreshes = createInvalidationCoalescer(() =>
      Promise.all([
        queryClient.invalidateQueries(
          { queryKey: projectsQueryKey },
          { cancelRefetch: false }
        ),
        queryClient.invalidateQueries(
          { queryKey: recentProjectsQueryKey },
          { cancelRefetch: false }
        )
      ])
    )
    const refresh = () => refreshes.schedule()
    const refreshProjects = () => projectRefreshes.schedule()
    const snapshot = (value: unknown) => {
      const payload = parseEventsSnapshot(value)
      if (!payload) {
        setEventsDisconnected(true)
        return
      }

      terminalSessions.replaceRuntimeMetadata(payload.terminalMetadata)
      setEventsDisconnected(false)
      refresh()
    }
    const productEvent = (value: unknown) => {
      const event = parseProductEvent(value)
      if (!event) {
        return
      }

      if (event.type === 'terminal.metadata') {
        const metadata = parseTerminalRuntimeMetadata(event.data)
        if (metadata) {
          terminalSessions.applyRuntimeMetadata(metadata)
        }

        return
      }

      if (
        event.type === 'project.updated' ||
        event.type === 'project.removed'
      ) {
        refreshProjects()
        return
      }

      if (event.type !== 'terminal.controller_changed') {
        refresh()
      }
    }
    const disconnected = () => setEventsDisconnected(true)
    events.on('snapshot', snapshot)
    events.on('product_event', productEvent)
    events.on('disconnect', disconnected)
    events.on('connect_error', disconnected)
    events.connect()
    return () => {
      refreshes.dispose()
      projectRefreshes.dispose()
      events.disconnect()
    }
  }, [queryClient])

  const allWorktrees = useMemo(
    () => projects.flatMap((project) => project.worktrees),
    [projects]
  )
  const allTerminals = useMemo(
    () => allWorktrees.flatMap((worktree) => worktree.terminals),
    [allWorktrees]
  )
  useEffect(() => {
    setPendingRemovals((current) => {
      let changed = false
      const next = { ...current }
      for (const [worktreeId, stage] of Object.entries(current)) {
        if (stage !== 'removing') {
          continue
        }

        const worktree = allWorktrees.find((item) => item.id === worktreeId)
        if (!worktree || worktree.status === 'cleanup_failed') {
          delete next[worktreeId]
          removalGuardsRef.current.delete(worktreeId)
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [allWorktrees])
  useEffect(() => {
    if (projectsQuery.data === undefined) {
      return
    }

    terminalSessions.reconcile(allTerminals)
  }, [allTerminals, projectsQuery.data])
  const bellAttention = useSyncExternalStore(
    terminalSessions.subscribe,
    terminalSessions.getAttentionSnapshot,
    () => EMPTY_BELL_ATTENTION
  )
  const runtimeTitles = useSyncExternalStore(
    terminalSessions.subscribe,
    terminalSessions.getTitleSnapshot,
    () => EMPTY_RUNTIME_TITLES
  )
  const terminalProgress = useSyncExternalStore(
    terminalSessions.subscribe,
    terminalSessions.getProgressSnapshot,
    () => EMPTY_TERMINAL_PROGRESS
  )
  const terminalById =
    allTerminals.find((terminal) => terminal.id === selectedTerminalId) ?? null
  useEffect(() => {
    if (!terminalById) {
      return
    }

    selectedWorktreeIdRef.current = terminalById.worktreeId
    setSelectedWorktreeId((current) =>
      current === terminalById.worktreeId ? current : terminalById.worktreeId
    )
  }, [terminalById?.id, terminalById?.worktreeId])
  const selectedWorktree =
    allWorktrees.find((worktree) => worktree.id === selectedWorktreeId) ??
    (terminalById
      ? (allWorktrees.find(
          (worktree) => worktree.id === terminalById.worktreeId
        ) ?? null)
      : null)
  const selectedTerminal =
    selectedWorktree?.terminals.find(
      (terminal) => terminal.id === selectedTerminalId
    ) ?? null
  const selectedProject = selectedWorktree
    ? projects.find((project) =>
        project.worktrees.some(
          (worktree) => worktree.id === selectedWorktree.id
        )
      )
    : null
  const selectedWorktreeMutationsDisabled =
    Boolean(selectedWorktree?.prunable) ||
    selectedWorktree?.status !== 'active' ||
    selectedProject?.availability.state === 'unavailable'

  const selectTerminal = (terminal: TerminalRecord) => {
    setSelectedTerminalId(terminal.id)
    setSelectedWorktreeId(terminal.worktreeId)
    selectedWorktreeIdRef.current = terminal.worktreeId
    localStorage.setItem('tasktty-terminal', terminal.id)
    setDrawerOpen(false)
  }

  const selectWorktree = (worktree: WorktreeRecord) => {
    setSelectedWorktreeId(worktree.id)
    selectedWorktreeIdRef.current = worktree.id
    const nextTerminal =
      worktree.terminals.find(
        (terminal) => terminal.id === selectedTerminalId
      ) ??
      worktree.terminals[0] ??
      null
    setSelectedTerminalId(nextTerminal?.id ?? null)
    if (nextTerminal) {
      localStorage.setItem('tasktty-terminal', nextTerminal.id)
    } else {
      localStorage.removeItem('tasktty-terminal')
    }

    setDrawerOpen(false)
  }

  const updateProjectColor = useMutation({
    mutationFn: ({
      projectId,
      color
    }: {
      projectId: string
      color: ProjectColor | null
    }) => apiClient.updateProjectColor(projectId, color),
    onMutate: async ({ projectId, color }) => {
      await queryClient.cancelQueries({ queryKey: projectsQueryKey })
      const previous =
        queryClient.getQueryData<ProjectRecord[]>(projectsQueryKey)
      queryClient.setQueryData<ProjectRecord[]>(projectsQueryKey, (current) =>
        current?.map((project) =>
          project.id === projectId ? { ...project, color } : project
        )
      )
      return { previous }
    },
    onError: (mutationError, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData<ProjectRecord[]>(
          projectsQueryKey,
          context.previous
        )
      }

      showError(setError)(mutationError)
    },
    onSuccess: (updatedProject) => {
      queryClient.setQueryData<ProjectRecord[]>(projectsQueryKey, (current) =>
        current?.map((project) =>
          project.id === updatedProject.id
            ? { ...updatedProject, worktrees: project.worktrees }
            : project
        )
      )
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: projectsQueryKey })
  })

  const createWorktree = useMutation({
    mutationFn: (pending: PendingWorktreeCreation) =>
      apiClient.createWorktree(
        pending.projectId,
        pending.typedName,
        pending.base,
        pending.initialTerminal,
        pending.sourceWorktreeId
      ),
    onSuccess: async (result, pending) => {
      await queryClient.cancelQueries({ queryKey: projectsQueryKey })
      const worktree =
        result.terminal &&
        !result.worktree.terminals.some(
          (item) => item.id === result.terminal?.id
        )
          ? {
              ...result.worktree,
              terminals: [...result.worktree.terminals, result.terminal]
            }
          : result.worktree
      queryClient.setQueryData<ProjectRecord[]>(projectsQueryKey, (current) =>
        current?.map((project) =>
          project.id === pending.projectId
            ? {
                ...project,
                worktrees: [
                  ...project.worktrees.filter(
                    (item) => item.id !== worktree.id
                  ),
                  worktree
                ]
              }
            : project
        )
      )
      if (result.terminal) {
        selectTerminal(result.terminal)
      } else {
        selectWorktree(worktree)
      }

      setPendingWorktrees((current) =>
        current.filter((item) => item.id !== pending.id)
      )
      if (result.setupError) {
        setError(
          `Worktree created, but setup could not start: ${result.setupError}`
        )
      } else if (result.terminalError) {
        setError(
          `Worktree created, but its terminal could not start: ${result.terminalError}`
        )
      }

      await queryClient.invalidateQueries({ queryKey: projectsQueryKey })
    },
    onError: (mutationError, pending) => {
      setPendingWorktrees((current) =>
        current.filter((item) => item.id !== pending.id)
      )
      setDrawerOpen(false)
      showError(setError)(mutationError)
    }
  })

  const submitWorktreeCreation = (
    project: ProjectRecord,
    name: string,
    base: 'default' | 'current',
    destination: WorktreeDestination,
    initialTerminal: { name: string; argv?: string[] },
    sourceWorktreeId?: string
  ) => {
    if (pendingWorktrees.some((item) => item.projectId === project.id)) {
      return
    }

    const pending: PendingWorktreeCreation = {
      id: crypto.randomUUID(),
      projectId: project.id,
      typedName: name,
      canonicalName: destination.name,
      destinationPath: destination.path,
      base,
      initialTerminal: {
        name: initialTerminal.name,
        ...(initialTerminal.argv ? { argv: [...initialTerminal.argv] } : {})
      },
      ...(sourceWorktreeId ? { sourceWorktreeId } : {})
    }
    setPendingWorktrees((current) => [...current, pending])
    setModal(null)
    window.requestAnimationFrame(() => {
      document.getElementById(`pending-worktree-${pending.id}`)?.focus()
    })
    createWorktree.mutate(pending)
  }

  const createTerminal = useMutation({
    mutationFn: ({
      worktreeId,
      name,
      argv
    }: {
      worktreeId: string
      name: string
      argv?: string[]
    }) => apiClient.createTerminal(worktreeId, name, argv),
    onSuccess: async (terminal) => {
      setFocusTerminalId(terminal.id)
      selectTerminal(terminal)
      await queryClient.invalidateQueries({ queryKey: projectsQueryKey })
    },
    onError: showError(setError)
  })

  const closeTerminal = useMutation({
    mutationFn: (terminal: TerminalRecord) =>
      apiClient.deleteTerminal(terminal.id),
    onSuccess: async (_, closedTerminal) => {
      terminalSessions.forget(closedTerminal.id)
      if (selectedTerminalId === closedTerminal.id) {
        const terminals = selectedWorktree?.terminals ?? []
        const closedIndex = terminals.findIndex(
          (terminal) => terminal.id === closedTerminal.id
        )
        const nextTerminal =
          terminals[closedIndex + 1] ?? terminals[closedIndex - 1] ?? null
        setSelectedTerminalId(nextTerminal?.id ?? null)
        if (nextTerminal) {
          localStorage.setItem('tasktty-terminal', nextTerminal.id)
        } else {
          localStorage.removeItem('tasktty-terminal')
        }
      }

      await queryClient.invalidateQueries({ queryKey: projectsQueryKey })
    },
    onError: showError(setError)
  })

  const closeProject = useMutation({
    mutationFn: (project: ProjectRecord) => apiClient.closeProject(project.id),
    onSuccess: async (_, closedProject) => {
      const currentProjects =
        queryClient.getQueryData<ProjectRecord[]>(projectsQueryKey) ?? projects
      const remainingProjects = currentProjects.filter(
        (project) => project.id !== closedProject.id
      )
      queryClient.setQueryData<ProjectRecord[]>(
        projectsQueryKey,
        remainingProjects
      )
      for (const terminal of closedProject.worktrees.flatMap(
        (worktree) => worktree.terminals
      )) {
        terminalSessions.forget(terminal.id)
      }

      const closedWorktreeIds = new Set(
        closedProject.worktrees.map((worktree) => worktree.id)
      )
      const closedTerminalIds = new Set(
        closedProject.worktrees.flatMap((worktree) =>
          worktree.terminals.map((terminal) => terminal.id)
        )
      )
      if (
        (selectedWorktreeIdRef.current &&
          closedWorktreeIds.has(selectedWorktreeIdRef.current)) ||
        (selectedTerminalId && closedTerminalIds.has(selectedTerminalId))
      ) {
        const fallbackTerminal = remainingProjects
          .flatMap((project) => project.worktrees)
          .flatMap((worktree) => worktree.terminals)[0]
        const fallbackWorktree = fallbackTerminal
          ? remainingProjects
              .flatMap((project) => project.worktrees)
              .find((worktree) => worktree.id === fallbackTerminal.worktreeId)
          : remainingProjects.flatMap((project) => project.worktrees)[0]
        setSelectedWorktreeId(fallbackWorktree?.id ?? null)
        selectedWorktreeIdRef.current = fallbackWorktree?.id ?? null
        setSelectedTerminalId(fallbackTerminal?.id ?? null)
        if (fallbackTerminal) {
          localStorage.setItem('tasktty-terminal', fallbackTerminal.id)
        } else {
          localStorage.removeItem('tasktty-terminal')
        }
      }

      setCollapsedProjectIds((current) => {
        const next = new Set(current)
        next.delete(closedProject.id)
        return next
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectsQueryKey }),
        queryClient.invalidateQueries({ queryKey: recentProjectsQueryKey })
      ])
      window.requestAnimationFrame(() => openProjectButtonRef.current?.focus())
    },
    onError: (mutationError) => {
      showError(setError)(mutationError)
      if (
        mutationError instanceof ApiError &&
        mutationError.code === 'PROJECT_CLOSE_FAILED'
      ) {
        void queryClient.invalidateQueries({ queryKey: projectsQueryKey })
      }
    }
  })

  const requestProjectClose = (project: ProjectRecord) => {
    const terminalCount = project.worktrees.reduce(
      (count, worktree) => count + worktree.terminals.length,
      0
    )
    if (
      terminalCount > 0 &&
      !window.confirm(
        `Close “${project.name}”? This will terminate ${terminalCount} TaskTTY terminal ${terminalCount === 1 ? 'session and its process' : 'sessions and their processes'}. Git worktrees and files will remain on disk, and you can reopen the project from Recent projects.`
      )
    ) {
      return
    }

    closeProject.mutate(project)
  }

  const projectOpened = async (project: ProjectRecord) => {
    queryClient.setQueryData<ProjectRecord[]>(projectsQueryKey, (current) => [
      ...(current ?? []).filter((candidate) => candidate.id !== project.id),
      project
    ])
    queryClient.setQueryData<RecentProjectRecord[]>(
      recentProjectsQueryKey,
      (current) => current?.filter((candidate) => candidate.id !== project.id)
    )
    setCollapsedProjectIds((current) => {
      const next = new Set(current)
      next.delete(project.id)
      return next
    })
    setModal(null)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: projectsQueryKey }),
      queryClient.invalidateQueries({ queryKey: recentProjectsQueryKey })
    ])
  }

  const setProjectOpen = (projectId: string, open: boolean) => {
    setCollapsedProjectIds((current) => {
      const next = new Set(current)
      if (open) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }

      return next
    })
  }

  const setAndSaveSidebarWidth = (width: number) => {
    const nextWidth = clampSidebarWidth(width)
    setSidebarWidth(nextWidth)
    localStorage.setItem('tasktty-sidebar-width', String(nextWidth))
  }

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    resizeOrigin.current = { pointerX: event.clientX, width: sidebarWidth }
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizingSidebar(true)
  }

  const resizeSidebar = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeOrigin.current) {
      return
    }

    setAndSaveSidebarWidth(
      resizeOrigin.current.width + event.clientX - resizeOrigin.current.pointerX
    )
  }

  const openModal = (
    nextModal: Exclude<Modal, null>,
    trigger?: HTMLElement
  ) => {
    modalTriggerRef.current =
      trigger ?? (document.activeElement as HTMLElement | null)
    setModal(nextModal)
  }

  const setRemovalStage = (worktreeId: string, stage: RemovalStage) =>
    setPendingRemovals((current) => ({ ...current, [worktreeId]: stage }))

  const releaseRemoval = (worktreeId: string) => {
    removalGuardsRef.current.delete(worktreeId)
    setPendingRemovals((current) => {
      if (!(worktreeId in current)) {
        return current
      }

      const next = { ...current }
      delete next[worktreeId]
      return next
    })
  }

  const markWorktreeCleaning = (worktreeId: string) =>
    queryClient.setQueryData<ProjectRecord[]>(projectsQueryKey, (current) =>
      current?.map((project) => ({
        ...project,
        worktrees: project.worktrees.map((worktree) =>
          worktree.id === worktreeId
            ? { ...worktree, status: 'cleaning', cleanupError: null }
            : worktree
        )
      }))
    )

  const submitRemoval = async (
    worktree: WorktreeRecord,
    preview: RemovePreview,
    confirmDestructive: boolean,
    staleRetriesRemaining: number
  ): Promise<void> => {
    setRemovalStage(worktree.id, 'removing')
    try {
      await apiClient.removeWorktree(worktree.id, preview, confirmDestructive)
      markWorktreeCleaning(worktree.id)
      setModal((current) =>
        current?.type === 'remove' && current.worktree.id === worktree.id
          ? null
          : current
      )
      void queryClient.invalidateQueries(
        { queryKey: projectsQueryKey },
        { cancelRefetch: false }
      )
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === 'REMOVE_PREVIEW_STALE' &&
        staleRetriesRemaining > 0
      ) {
        setRemovalStage(worktree.id, 'checking')
        try {
          const freshPreview = await apiClient.removePreview(worktree.id)
          if (freshPreview.eligible && freshPreview.warnings.length === 0) {
            await submitRemoval(
              worktree,
              freshPreview,
              false,
              staleRetriesRemaining - 1
            )
            return
          }

          releaseRemoval(worktree.id)
          openModal({ type: 'remove', worktree, preview: freshPreview })
          return
        } catch (refreshError) {
          releaseRemoval(worktree.id)
          showError(setError)(refreshError)
          return
        }
      }

      releaseRemoval(worktree.id)
      showError(setError)(
        error instanceof ApiError && error.code === 'REMOVE_PREVIEW_STALE'
          ? new Error(
              'The worktree kept changing during removal. Review it and try again.'
            )
          : error
      )
    }
  }

  const prepareRemoval = async (
    worktree: WorktreeRecord,
    trigger: HTMLElement
  ): Promise<void> => {
    if (
      removalGuardsRef.current.has(worktree.id) ||
      worktree.status === 'cleaning' ||
      needsManualCleanup(worktree)
    ) {
      return
    }

    modalTriggerRef.current = trigger
    removalGuardsRef.current.add(worktree.id)
    setRemovalStage(worktree.id, 'checking')
    try {
      const preview = await apiClient.removePreview(worktree.id)
      if (preview.eligible && preview.warnings.length === 0) {
        await submitRemoval(worktree, preview, false, 1)
        return
      }

      releaseRemoval(worktree.id)
      openModal({ type: 'remove', worktree, preview }, trigger)
    } catch (error) {
      releaseRemoval(worktree.id)
      showError(setError)(error)
    }
  }

  const confirmRemoval = (worktree: WorktreeRecord, preview: RemovePreview) => {
    if (removalGuardsRef.current.has(worktree.id)) {
      return
    }

    removalGuardsRef.current.add(worktree.id)
    void submitRemoval(worktree, preview, preview.warnings.length > 0, 1)
  }

  const stopSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    resizeOrigin.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    setResizingSidebar(false)
  }

  const resizeSidebarWithKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>
  ) => {
    let nextWidth = sidebarWidth
    if (event.key === 'ArrowLeft') {
      nextWidth -= event.shiftKey ? 32 : 16
    } else if (event.key === 'ArrowRight') {
      nextWidth += event.shiftKey ? 32 : 16
    } else if (event.key === 'Home') {
      nextWidth = MIN_SIDEBAR_WIDTH
    } else if (event.key === 'End') {
      nextWidth = MAX_SIDEBAR_WIDTH
    } else {
      return
    }

    event.preventDefault()
    setAndSaveSidebarWidth(nextWidth)
  }

  return (
    <div
      className={cn(
        'app-frame isolate grid h-dvh grid-cols-[var(--sidebar-width)_minmax(0,1fr)] bg-zinc-950 max-[700px]:grid-cols-1 max-[700px]:grid-rows-[3.25rem_minmax(0,1fr)]',
        resizingSidebar && 'select-none'
      )}
      style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
      <header
        className="mobile-bar hidden min-w-0 grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-2 border-b border-white/8 bg-zinc-900/95 px-2 backdrop-blur max-[700px]:grid"
        inert={isMobile && drawerOpen ? true : undefined}
      >
        <Button
          ref={drawerTriggerRef}
          type="button"
          variant="ghost"
          size="icon"
          className="icon-button text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
          aria-label="Open worktree drawer"
          onClick={() => setDrawerOpen(true)}
        >
          <Bars3Icon />
          <span className="touch-target" aria-hidden="true" />
        </Button>
        <NativeSelect
          className="h-9 border-0 bg-zinc-800/80 text-base ring-0"
          name="terminal-selector"
          aria-label="Terminal selector"
          value={selectedTerminalId ?? ''}
          onChange={(event) => {
            const terminal = allTerminals.find(
              (item) => item.id === event.target.value
            )
            if (terminal) {
              selectTerminal(terminal)
            }
          }}
        >
          <option value="">Select terminal</option>
          {allTerminals.map((terminal) => (
            <option value={terminal.id} key={terminal.id}>
              {runtimeTitles.get(terminal.id) || terminal.name}
            </option>
          ))}
        </NativeSelect>
      </header>
      <div
        className={cn(
          'drawer-backdrop fixed inset-0 z-30 bg-black/60 opacity-0 backdrop-blur-sm transition-opacity pointer-events-none min-[701px]:hidden',
          drawerOpen && 'opacity-100 pointer-events-auto'
        )}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />
      <aside
        ref={drawerRef}
        id="worktree-sidebar"
        role={isMobile ? 'dialog' : undefined}
        aria-modal={isMobile && drawerOpen ? true : undefined}
        aria-labelledby={isMobile ? 'worktree-drawer-title' : undefined}
        aria-hidden={isMobile && !drawerOpen ? true : undefined}
        inert={isMobile && !drawerOpen ? true : undefined}
        className={cn(
          'sidebar relative z-40 flex min-h-0 flex-col border-r border-white/8 bg-zinc-900/80 backdrop-blur-xl max-[700px]:fixed max-[700px]:inset-y-0 max-[700px]:left-0 max-[700px]:w-[min(88vw,21rem)] max-[700px]:-translate-x-full max-[700px]:shadow-2xl max-[700px]:transition-transform',
          drawerOpen && 'open max-[700px]:translate-x-0'
        )}
      >
        <h2 id="worktree-drawer-title" className="sr-only">
          Projects and worktrees
        </h2>
        <div
          className={cn(
            'absolute inset-y-0 right-0 z-50 w-3 translate-x-1/2 touch-none cursor-col-resize outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-white/8 after:absolute after:top-1/2 after:left-1/2 after:h-8 after:w-1 after:-translate-1/2 after:rounded-full after:bg-zinc-700 hover:before:w-0.5 hover:before:bg-cyan-400/60 hover:after:bg-cyan-400 focus-visible:before:w-0.5 focus-visible:before:bg-cyan-400 focus-visible:after:bg-cyan-400 max-[700px]:hidden',
            resizingSidebar && 'before:w-0.5 before:bg-cyan-400'
          )}
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-controls="worktree-sidebar"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          aria-valuetext={`${sidebarWidth} pixels`}
          title="Drag to resize; double-click to reset"
          tabIndex={0}
          onPointerDown={startSidebarResize}
          onPointerMove={resizeSidebar}
          onPointerUp={stopSidebarResize}
          onPointerCancel={stopSidebarResize}
          onKeyDown={resizeSidebarWithKeyboard}
          onDoubleClick={() => setAndSaveSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
        />
        <div className="hidden justify-end p-2 max-[700px]:flex">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="icon-button mobile-close text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
            aria-label="Close drawer"
            onClick={() => setDrawerOpen(false)}
          >
            <XMarkIcon />
            <span className="touch-target" aria-hidden="true" />
          </Button>
        </div>
        <nav
          className="tree min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pt-3 pb-5 sm:px-1.5 sm:pb-4 [scrollbar-color:var(--color-zinc-700)_transparent]"
          aria-label="Projects and worktrees"
        >
          {projectsQuery.isPending ? (
            <p className="sidebar-note px-2 py-3 text-base text-zinc-500 sm:text-sm">
              Loading repositories…
            </p>
          ) : null}
          {!projectsQuery.isPending && !projects.length ? (
            <p className="sidebar-note px-2 py-3 text-base text-pretty text-zinc-500 sm:text-sm">
              Open a Git repository to begin.
            </p>
          ) : null}
          <div className="grid gap-5 sm:gap-4">
            {projects.map((project) => (
              <Collapsible
                className="project-tree"
                open={!collapsedProjectIds.has(project.id)}
                onOpenChange={(open) => setProjectOpen(project.id, open)}
                key={project.id}
              >
                <div className="project-row group/project-row flex min-h-11 items-center gap-1 px-1 sm:min-h-7">
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="group/project min-w-0 flex-1 justify-start px-1.5 text-base font-semibold text-zinc-100 hover:bg-white/5 sm:text-[0.8125rem]"
                      title={
                        project.availability.state === 'unavailable'
                          ? project.availability.message ||
                            'Git repository unavailable'
                          : project.repositoryPath
                      }
                    >
                      <ChevronRightIcon
                        className={cn(
                          'shrink-0 transition-transform group-data-[state=open]/project:rotate-90',
                          project.color
                            ? PROJECT_COLOR_STYLES[project.color].chevron
                            : 'fill-zinc-600'
                        )}
                      />
                      <span className="truncate">{project.name}</span>
                      {project.availability.state === 'unavailable' && (
                        <span className="shrink-0 text-[0.625rem] font-normal text-amber-300">
                          unavailable
                        </span>
                      )}
                    </Button>
                  </CollapsibleTrigger>
                  <ProjectColorPicker
                    project={project}
                    open={openProjectColorPickerId === project.id}
                    pending={
                      updateProjectColor.isPending &&
                      updateProjectColor.variables?.projectId === project.id
                    }
                    onOpenChange={(open) =>
                      setOpenProjectColorPickerId(open ? project.id : null)
                    }
                    onChange={(color) =>
                      updateProjectColor.mutate({
                        projectId: project.id,
                        color
                      })
                    }
                  />
                  <SidebarAction
                    label={`Close project ${project.name}`}
                    tooltip="Close project"
                    disabled={
                      closeProject.isPending &&
                      closeProject.variables?.id === project.id
                    }
                    className="shrink-0 fill-zinc-500 opacity-0 hover:bg-white/5 hover:fill-rose-300 group-hover/project-row:opacity-100 group-focus-within/project-row:opacity-100 max-[700px]:opacity-100"
                    onClick={() => requestProjectClose(project)}
                  >
                    {closeProject.isPending &&
                    closeProject.variables?.id === project.id ? (
                      <ArrowPathIcon className="animate-spin" />
                    ) : (
                      <XMarkIcon />
                    )}
                  </SidebarAction>
                </div>
                <CollapsibleContent asChild>
                  <ul
                    role="list"
                    className={cn(
                      'ml-3 grid gap-0.5 border-l pl-1.5',
                      project.color
                        ? PROJECT_COLOR_STYLES[project.color].rail
                        : 'border-white/8'
                    )}
                  >
                    {project.worktrees.map((worktree) => (
                      <li key={worktree.id} className="group/worktree min-w-0">
                        <div className="relative min-w-0 max-[700px]:flex max-[700px]:items-center">
                          <Button
                            variant="ghost"
                            type="button"
                            className={cn(
                              'worktree-row h-auto min-h-11 w-full min-w-0 justify-start gap-2 rounded-md px-2 py-1.5 text-left text-base font-medium sm:min-h-8 sm:py-1 sm:text-[0.8125rem] max-[700px]:flex-1',
                              selectedWorktree?.id === worktree.id
                                ? 'selected bg-white/8 text-zinc-50'
                                : 'text-zinc-300 hover:bg-white/5 hover:text-zinc-50'
                            )}
                            onClick={() => selectWorktree(worktree)}
                            title={`${worktree.path}${worktree.branch ? ` · ${worktree.branch}` : ` · detached at ${worktree.head.slice(0, 8)}`}`}
                          >
                            {pendingRemovals[worktree.id] ||
                            worktree.status === 'cleaning' ? (
                              <ArrowPathIcon
                                className="shrink-0 animate-spin text-cyan-400"
                                aria-hidden="true"
                              />
                            ) : (
                              <FolderIcon
                                className="shrink-0 text-zinc-500"
                                aria-hidden="true"
                              />
                            )}
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{worktree.name}</span>
                              {(pendingRemovals[worktree.id] ||
                                worktree.status === 'cleaning' ||
                                worktree.status === 'cleanup_failed') && (
                                <span
                                  className={cn(
                                    'truncate text-[0.6875rem] font-normal text-cyan-300',
                                    worktree.status === 'cleanup_failed' &&
                                      'text-rose-300'
                                  )}
                                  role="status"
                                  title={worktree.cleanupError ?? undefined}
                                >
                                  {pendingRemovals[worktree.id] === 'checking'
                                    ? 'Preparing removal…'
                                    : pendingRemovals[worktree.id] ===
                                          'removing' ||
                                        worktree.status === 'cleaning'
                                      ? 'Removing…'
                                      : 'Removal failed'}
                                  {worktree.status === 'cleanup_failed' &&
                                  worktree.cleanupError
                                    ? `: ${worktree.cleanupError}`
                                    : ''}
                                </span>
                              )}
                            </span>
                          </Button>
                          {worktree.kind === 'linked' && (
                            <div className="worktree-actions absolute top-0 right-0 z-10 flex items-center gap-0.5 opacity-0 group-hover/worktree:opacity-100 group-focus-within/worktree:opacity-100 max-[700px]:static max-[700px]:ml-0.5 max-[700px]:shrink-0 max-[700px]:opacity-100">
                              <SidebarAction
                                label={
                                  needsManualCleanup(worktree)
                                    ? `Manual cleanup required for ${worktree.name}`
                                    : worktree.status === 'cleanup_failed'
                                      ? `Retry removal for ${worktree.name}`
                                      : `Remove ${worktree.name}`
                                }
                                tooltip={
                                  project.availability.state === 'unavailable'
                                    ? 'Git repository unavailable'
                                    : worktree.prunable
                                      ? 'Git reports this worktree as prunable'
                                      : pendingRemovals[worktree.id] ||
                                          worktree.status === 'cleaning'
                                        ? 'Removal is already in progress'
                                        : needsManualCleanup(worktree)
                                          ? worktree.cleanupError!
                                          : worktree.status === 'cleanup_failed'
                                            ? 'Retry removal'
                                            : 'Remove worktree'
                                }
                                disabled={
                                  project.availability.state ===
                                    'unavailable' ||
                                  worktree.prunable ||
                                  Boolean(pendingRemovals[worktree.id]) ||
                                  worktree.status === 'cleaning' ||
                                  needsManualCleanup(worktree)
                                }
                                className="text-zinc-500 hover:bg-transparent hover:text-rose-300"
                                onClick={(trigger) =>
                                  void prepareRemoval(worktree, trigger)
                                }
                              >
                                <TrashIcon />
                              </SidebarAction>
                            </div>
                          )}
                        </div>
                        <ul
                          role="list"
                          className="terminal-list ml-4 grid gap-0 border-l border-white/6 pl-2"
                        >
                          {worktree.terminals.map((terminal) => {
                            const needsAttention = bellAttention.has(
                              terminal.id
                            )
                            const progress = terminalProgress.get(terminal.id)
                            const status = [
                              progress
                                ? terminalProgressLabel(progress)
                                : terminal.status,
                              needsAttention ? 'bell' : null
                            ]
                              .filter(Boolean)
                              .join(', ')
                            return (
                              <li key={terminal.id} className="min-w-0">
                                <Button
                                  variant="ghost"
                                  type="button"
                                  className={cn(
                                    'terminal-row grid h-auto min-h-11 w-full min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_0.5rem] gap-1.5 rounded-md px-2 py-1.5 text-left text-base font-normal sm:min-h-7 sm:grid-cols-[1rem_minmax(0,1fr)_0.5rem] sm:py-0.5 sm:text-[0.6875rem]',
                                    selectedTerminalId === terminal.id
                                      ? 'selected bg-cyan-400/8 text-cyan-50'
                                      : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-100'
                                  )}
                                  onClick={() => selectTerminal(terminal)}
                                  aria-label={`${runtimeTitles.get(terminal.id) || terminal.name}, ${status}`}
                                >
                                  {progress ? (
                                    <ArrowPathIcon
                                      className={cn(
                                        'size-4 shrink-0 fill-cyan-300',
                                        progress.state !== 'paused' &&
                                          progress.state !== 'error' &&
                                          'animate-spin',
                                        progress.state === 'error' &&
                                          'fill-rose-300',
                                        progress.state === 'paused' &&
                                          'fill-amber-300'
                                      )}
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <CommandLineIcon className="size-4 shrink-0 fill-zinc-600" />
                                  )}
                                  <span className="truncate" aria-hidden="true">
                                    {runtimeTitles.get(terminal.id) ||
                                      terminal.name}
                                  </span>
                                  {(terminal.status !== 'running' ||
                                    needsAttention) && (
                                    <span
                                      className={cn(
                                        'status-dot size-1.5 shrink-0 rounded-full bg-zinc-600',
                                        terminal.status === 'exited' &&
                                          'bg-rose-400',
                                        needsAttention &&
                                          'bg-amber-300 shadow-[0_0_0.5rem] shadow-amber-300/60'
                                      )}
                                      title={status}
                                    />
                                  )}
                                </Button>
                              </li>
                            )
                          })}
                        </ul>
                      </li>
                    ))}
                    {pendingWorktrees
                      .filter(
                        (pending) =>
                          pending.projectId === project.id &&
                          !project.worktrees.some(
                            (worktree) =>
                              worktree.path === pending.destinationPath
                          )
                      )
                      .map((pending) => (
                        <li key={pending.id} className="min-w-0">
                          <div
                            id={`pending-worktree-${pending.id}`}
                            className="flex min-h-11 min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-base font-normal text-zinc-400 outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 sm:min-h-7 sm:py-0.5 sm:text-[0.6875rem]"
                            role="status"
                            aria-label={`Creating worktree ${pending.typedName}`}
                            title={pending.destinationPath}
                            tabIndex={-1}
                          >
                            <ArrowPathIcon
                              className="size-4 shrink-0 animate-spin text-cyan-400"
                              aria-hidden="true"
                            />
                            <span className="truncate">
                              {pending.typedName}
                            </span>
                          </div>
                        </li>
                      ))}
                    <li className="min-w-0">
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-auto min-h-11 w-full justify-start gap-1.5 px-2 py-1.5 text-base font-normal text-zinc-500 hover:bg-white/5 hover:text-zinc-100 sm:min-h-7 sm:py-0.5 sm:text-[0.6875rem]"
                        disabled={
                          project.availability.state === 'unavailable' ||
                          pendingWorktrees.some(
                            (pending) => pending.projectId === project.id
                          )
                        }
                        onClick={(event) =>
                          openModal(
                            { type: 'worktree', project },
                            event.currentTarget
                          )
                        }
                      >
                        <PlusIcon /> New worktree
                      </Button>
                    </li>
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        </nav>
        <footer className="sidebar-tools flex items-center gap-1 border-t border-white/8 px-2 py-1.5">
          <Button
            ref={openProjectButtonRef}
            type="button"
            variant="ghost"
            size="sm"
            className="flex-1 justify-start text-zinc-500 hover:bg-white/5 hover:text-zinc-200 sm:text-[0.8125rem]"
            onClick={(event) =>
              openModal({ type: 'project' }, event.currentTarget)
            }
          >
            <PlusIcon /> Open project
          </Button>
        </footer>
      </aside>
      <div
        className="contents"
        inert={isMobile && drawerOpen ? true : undefined}
        aria-hidden={isMobile && drawerOpen ? true : undefined}
      >
        <TerminalView
          worktree={selectedWorktree}
          terminal={selectedTerminal}
          focusTerminalId={focusTerminalId}
          presets={presets}
          presetsLoading={presetsQuery.isPending}
          presetsError={presetsQuery.isError}
          onSelectTerminal={selectTerminal}
          onCreateTerminal={(input) =>
            selectedWorktree &&
            createTerminal.mutate({
              worktreeId: selectedWorktree.id,
              name: input.name,
              ...(input.argv ? { argv: [...input.argv] } : {})
            })
          }
          onManagePresets={(trigger) =>
            openModal({ type: 'presets' }, trigger ?? undefined)
          }
          creatingTerminal={
            createTerminal.isPending &&
            createTerminal.variables?.worktreeId === selectedWorktree?.id
          }
          mutationsDisabled={selectedWorktreeMutationsDisabled}
          onCloseTerminal={(terminal) => {
            if (
              window.confirm(
                `Close terminal “${runtimeTitles.get(terminal.id) || terminal.name}”? Its tmux session and process will be terminated.`
              )
            ) {
              closeTerminal.mutate(terminal)
            }
          }}
          closingTerminalId={
            closeTerminal.isPending ? closeTerminal.variables?.id : null
          }
          onStatusChange={() =>
            void queryClient.invalidateQueries({ queryKey: projectsQueryKey })
          }
        />
      </div>
      {showSyncDegraded && (
        <div
          className="fixed right-4 bottom-4 z-70 flex max-w-[min(30rem,calc(100vw-2rem))] items-center gap-3 rounded-lg bg-zinc-800 p-3 text-sm text-zinc-300 shadow-2xl ring-1 ring-white/10"
          role="status"
          inert={isMobile && drawerOpen ? true : undefined}
          aria-hidden={isMobile && drawerOpen ? true : undefined}
        >
          <span>Updates paused; showing the last known project state.</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void projectsQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      )}
      {error && (
        <div
          className="toast fixed right-4 bottom-4 z-80 flex max-w-[min(27.5rem,calc(100vw-2rem))] items-start gap-3 rounded-lg bg-rose-950 p-3 text-sm text-pretty text-rose-200 shadow-2xl ring-1 ring-rose-800/80"
          role="alert"
          inert={isMobile && drawerOpen ? true : undefined}
          aria-hidden={isMobile && drawerOpen ? true : undefined}
        >
          {error}
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            className="text-rose-300 hover:bg-rose-900 hover:text-rose-100"
            aria-label="Dismiss error"
            onClick={() => setError(null)}
          >
            <XMarkIcon />
          </Button>
        </div>
      )}
      {modal && (
        <ActionModal
          modal={modal}
          close={() => setModal(null)}
          restoreFocusTo={modalTriggerRef.current}
          setError={setError}
          presets={presets}
          presetsLoading={presetsQuery.isPending}
          presetsError={presetsQuery.isError}
          onRetryPresets={() => void presetsQuery.refetch()}
          onCreateWorktree={submitWorktreeCreation}
          removalStage={
            modal.type === 'remove'
              ? (pendingRemovals[modal.worktree.id] ?? null)
              : null
          }
          onConfirmRemoval={confirmRemoval}
          onProjectOpened={projectOpened}
        />
      )}
    </div>
  )
}

function ModalHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="grid gap-1.5 pr-12">
      <p className="eyebrow">{eyebrow}</p>
      <h2
        id="modal-title"
        className="text-balance text-xl font-semibold tracking-tight text-zinc-50 sm:text-2xl"
      >
        {title}
      </h2>
    </div>
  )
}

function FormField({ children }: { children: ReactNode }) {
  return <div className="grid gap-2">{children}</div>
}

function ProjectColorPicker({
  project,
  open,
  pending,
  onOpenChange,
  onChange
}: {
  project: ProjectRecord
  open: boolean
  pending: boolean
  onOpenChange: (open: boolean) => void
  onChange: (color: ProjectColor | null) => void
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 fill-zinc-500 opacity-0 hover:bg-white/5 hover:fill-zinc-100 group-hover/project-row:opacity-100 group-focus-within/project-row:opacity-100 data-[state=open]:opacity-100 max-[700px]:opacity-100"
          aria-label={`Change color for ${project.name}`}
        >
          <SwatchIcon />
          <span className="touch-target" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={`Color for ${project.name}`}
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-zinc-100">Project color</p>
          <div className="grid grid-cols-3 gap-2">
            {PROJECT_COLOR_OPTIONS.map((option) => {
              const selected = project.color === option.value
              return (
                <Button
                  key={option.label}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    'rounded-full ring-2 ring-transparent',
                    option.swatch,
                    selected && 'ring-white ring-offset-2 ring-offset-zinc-900'
                  )}
                  aria-label={option.label}
                  aria-pressed={selected}
                  title={option.label}
                  disabled={pending}
                  onClick={() => {
                    onChange(option.value)
                    onOpenChange(false)
                  }}
                >
                  {selected ? <CheckIcon className={option.check} /> : null}
                </Button>
              )
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function SidebarAction({
  label,
  tooltip = label,
  className,
  disabled,
  onClick,
  children
}: {
  label: string
  tooltip?: string
  className?: string
  disabled?: boolean
  onClick: (trigger: HTMLButtonElement) => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={className}
          aria-label={label}
          disabled={disabled}
          onClick={(event) => onClick(event.currentTarget)}
        >
          {children}
          <span className="touch-target" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

function ActionModal({
  modal,
  close,
  restoreFocusTo,
  setError,
  presets,
  presetsLoading,
  presetsError,
  onRetryPresets,
  onCreateWorktree,
  removalStage,
  onConfirmRemoval,
  onProjectOpened
}: {
  modal: Exclude<Modal, null>
  close: () => void
  restoreFocusTo: HTMLElement | null
  setError: (value: string | null) => void
  presets: TerminalPreset[]
  presetsLoading: boolean
  presetsError: boolean
  onRetryPresets: () => void
  onCreateWorktree: (
    project: ProjectRecord,
    name: string,
    base: 'default' | 'current',
    destination: WorktreeDestination,
    initialTerminal: { name: string; argv?: string[] },
    sourceWorktreeId?: string
  ) => void
  removalStage: RemovalStage | null
  onConfirmRemoval: (worktree: WorktreeRecord, preview: RemovePreview) => void
  onProjectOpened: (project: ProjectRecord) => Promise<void>
}) {
  const dialogRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) {
      return
    }

    const previouslyFocused = document.activeElement as HTMLElement | null
    const appFrame = document.querySelector<HTMLElement>('.app-frame')
    appFrame?.setAttribute('inert', '')
    const frame = window.requestAnimationFrame(() => {
      const autofocus = dialog.querySelector<HTMLElement>('[autofocus]')
      const first = autofocus ?? focusableElements(dialog)[0]
      if (first) {
        first.focus()
      } else {
        dialog.focus()
      }
    })
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }

      trapTabKey(event, dialog)
    }
    document.addEventListener('keydown', keydown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', keydown)
      appFrame?.removeAttribute('inert')
      if (restoreFocusTo?.isConnected) {
        restoreFocusTo.focus()
      } else if (previouslyFocused?.isConnected) {
        previouslyFocused.focus()
      }
    }
  }, [])

  return createPortal(
    <div
      className="modal-backdrop fixed inset-0 z-60 grid place-items-center bg-black/70 p-4 backdrop-blur-sm max-[700px]:items-end max-[700px]:p-0"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <section
        ref={dialogRef}
        className={cn(
          'modal relative max-h-[calc(100dvh-2rem)] w-full overflow-y-auto rounded-xl bg-zinc-900 p-6 shadow-2xl ring-1 ring-white/10 max-[700px]:max-h-[90dvh] max-[700px]:max-w-none max-[700px]:rounded-b-none max-[700px]:p-5 max-[700px]:pb-[calc(1.25rem+env(safe-area-inset-bottom))]',
          modal.type === 'presets'
            ? 'max-w-3xl'
            : modal.type === 'worktree'
              ? 'max-w-md'
              : 'max-w-lg'
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="icon-button modal-close absolute top-3 right-3 text-zinc-500 hover:bg-white/5 hover:text-zinc-100"
          aria-label="Close"
          onClick={close}
        >
          <XMarkIcon />
          <span className="touch-target" aria-hidden="true" />
        </Button>
        {modal.type === 'project' && (
          <ProjectForm setError={setError} onOpened={onProjectOpened} />
        )}
        {modal.type === 'worktree' && (
          <WorktreeForm
            project={modal.project}
            presets={presets}
            presetsLoading={presetsLoading}
            presetsError={presetsError}
            onRetryPresets={onRetryPresets}
            busy={false}
            onSubmit={(
              name,
              base,
              destination,
              initialTerminal,
              sourceWorktreeId
            ) =>
              onCreateWorktree(
                modal.project,
                name,
                base,
                destination,
                initialTerminal,
                sourceWorktreeId
              )
            }
          />
        )}
        {modal.type === 'presets' && (
          <TerminalPresetsManager
            presets={presets}
            loading={presetsLoading}
            loadError={presetsError}
            onRetry={onRetryPresets}
            setError={setError}
          />
        )}
        {modal.type === 'remove' && (
          <RemoveConfirm
            worktree={modal.worktree}
            preview={modal.preview}
            busy={removalStage !== null}
            onConfirm={(preview) => onConfirmRemoval(modal.worktree, preview)}
          />
        )}
      </section>
    </div>,
    document.body
  )
}

function ProjectForm({
  setError,
  onOpened
}: {
  setError: (value: string | null) => void
  onOpened: (project: ProjectRecord) => Promise<void>
}) {
  const [pathValue, setPathValue] = useState('')
  const recentProjects = useQuery({
    queryKey: recentProjectsQueryKey,
    queryFn: apiClient.recentProjects,
    retry: false
  })
  const openProject = useMutation({
    mutationFn: (request: { id?: string; path?: string }) =>
      request.id
        ? apiClient.openProject(request.id)
        : apiClient.addProject(request.path ?? ''),
    onSuccess: onOpened,
    onError: showError(setError)
  })
  const busy = openProject.isPending

  return (
    <div className="flex flex-col gap-5">
      <ModalHeading eyebrow="Workspace" title="Open project" />
      <section className="grid gap-2" aria-labelledby="recent-projects-title">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <h3
            id="recent-projects-title"
            className="text-sm font-medium text-zinc-200"
          >
            Recent projects
          </h3>
          {recentProjects.isFetching && !recentProjects.isPending ? (
            <ArrowPathIcon
              className="size-4 shrink-0 animate-spin fill-zinc-500"
              aria-label="Refreshing recent projects"
            />
          ) : null}
        </div>
        {recentProjects.isPending ? (
          <p className="text-base text-zinc-500 sm:text-sm">
            Loading recent projects…
          </p>
        ) : null}
        {recentProjects.isError ? (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-white/3 p-3">
            <p className="min-w-0 text-base text-zinc-400 sm:text-sm">
              Recent projects could not be loaded.
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void recentProjects.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {recentProjects.isSuccess && !recentProjects.data.length ? (
          <p className="text-base text-zinc-500 sm:text-sm">
            Closed projects will appear here.
          </p>
        ) : null}
        {recentProjects.data?.length ? (
          <ul
            role="list"
            className="max-h-56 overflow-y-auto rounded-lg bg-white/3 p-1 ring-1 ring-white/8 [scrollbar-color:var(--color-zinc-700)_transparent]"
          >
            {recentProjects.data.map((project) => (
              <li key={project.id}>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto min-h-11 w-full min-w-0 justify-start px-3 py-2 text-left hover:bg-white/5"
                  disabled={busy}
                  onClick={() => openProject.mutate({ id: project.id })}
                >
                  <span className="grid min-w-0 gap-0.5">
                    <span className="truncate font-medium text-zinc-100">
                      {project.name}
                    </span>
                    <span className="truncate text-zinc-500">
                      {project.repositoryPath}
                    </span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <form
        className="flex flex-col gap-4 border-t border-white/8 pt-5"
        onSubmit={(event) => {
          event.preventDefault()
          openProject.mutate({ path: pathValue })
        }}
      >
        <FormField>
          <Label htmlFor="repository-path">Open by repository path</Label>
          <Input
            id="repository-path"
            name="repository-path"
            value={pathValue}
            onChange={(event) => setPathValue(event.target.value)}
            placeholder="/Users/you/Projects/example"
            required
            autoFocus
            disabled={busy}
          />
        </FormField>
        <p className="form-note">
          The daemon resolves the main checkout and imports existing linked
          worktrees.
        </p>
        <Button type="submit" className="self-end" disabled={busy}>
          {busy ? 'Opening…' : 'Open project'}
        </Button>
      </form>
    </div>
  )
}

function WorktreeForm({
  project,
  presets,
  presetsLoading,
  presetsError,
  onRetryPresets,
  busy,
  onSubmit
}: {
  project: ProjectRecord
  presets: TerminalPreset[]
  presetsLoading: boolean
  presetsError: boolean
  onRetryPresets: () => void
  busy: boolean
  onSubmit: (
    name: string,
    base: 'default' | 'current',
    destination: WorktreeDestination,
    initialTerminal: { name: string; argv?: string[] },
    sourceWorktreeId?: string
  ) => void
}) {
  const [name, setName] = useState('')
  const [debouncedName, setDebouncedName] = useState('')
  const [baseValue, setBaseValue] = useState('default')
  const [initialPresetId, setInitialPresetId] = useState('shell')
  const [initialPresetNotice, setInitialPresetNotice] = useState<string | null>(
    null
  )
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedName(name), 250)
    return () => window.clearTimeout(timeout)
  }, [name])
  useEffect(() => {
    if (
      initialPresetId !== 'shell' &&
      !presets.some((preset) => preset.id === initialPresetId)
    ) {
      setInitialPresetId('shell')
      setInitialPresetNotice(
        'The selected preset was deleted. Initial terminal changed to Shell.'
      )
    }
  }, [initialPresetId, presets])
  const destinationQuery = useQuery({
    queryKey: ['worktree-destination', project.id, debouncedName],
    queryFn: () => apiClient.worktreeDestination(project.id, debouncedName),
    enabled: Boolean(debouncedName.trim()),
    placeholderData: (previous) => previous,
    retry: false
  })
  const base = baseValue === 'default' ? 'default' : 'current'
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!destinationQuery.data || name !== debouncedName) {
          return
        }

        const selectedPreset = presets.find(
          (preset) => preset.id === initialPresetId
        )
        onSubmit(
          name,
          base,
          destinationQuery.data,
          selectedPreset
            ? {
                name: selectedPreset.name,
                argv: [selectedPreset.executable, ...selectedPreset.args]
              }
            : { name: 'Shell' },
          base === 'current' ? baseValue : undefined
        )
      }}
    >
      <ModalHeading eyebrow={project.name} title="New worktree" />
      <FormField>
        <Label htmlFor="worktree-name">Name</Label>
        <Input
          id="worktree-name"
          name="worktree-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="investigate-cache"
          aria-label="Worktree name"
          required
          autoFocus
          aria-invalid={destinationQuery.isError}
        />
      </FormField>
      <FormField>
        <Label htmlFor="worktree-base">Base</Label>
        <NativeSelect
          id="worktree-base"
          name="worktree-base"
          value={baseValue}
          onChange={(event) => setBaseValue(event.target.value)}
        >
          <option value="default">
            {project.defaultBranch} (latest from origin)
          </option>
          {project.worktrees
            .filter((worktree) => worktree.status === 'active')
            .map((worktree) => (
              <option key={worktree.id} value={worktree.id}>
                {worktree.name} (current commit)
              </option>
            ))}
        </NativeSelect>
      </FormField>
      <FormField>
        <Label htmlFor="initial-terminal-preset">Initial terminal</Label>
        <NativeSelect
          id="initial-terminal-preset"
          name="initial-terminal-preset"
          value={initialPresetId}
          onChange={(event) => {
            setInitialPresetId(event.target.value)
            setInitialPresetNotice(null)
          }}
        >
          <option value="shell">Shell</option>
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </NativeSelect>
        {initialPresetNotice && (
          <p className="form-note" role="status">
            {initialPresetNotice}
          </p>
        )}
        {presetsLoading && (
          <p className="form-note" role="status">
            Loading terminal presets…
          </p>
        )}
        {presetsError && (
          <div className="flex items-center justify-between gap-3">
            <p className="form-note">
              Presets could not be loaded. Shell is still available.
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onRetryPresets}
            >
              Retry
            </Button>
          </div>
        )}
      </FormField>
      <p
        className={cn(
          'form-note min-h-5 truncate',
          destinationQuery.isError && 'text-rose-300'
        )}
        title={destinationQuery.data?.path}
        aria-live="polite"
      >
        {destinationQuery.data
          ? `Destination: ${destinationQuery.data.path}`
          : destinationQuery.error
            ? destinationQuery.error.message
            : name.trim()
              ? 'Resolving destination…'
              : 'Enter a name to preview the destination.'}
      </p>
      <Button
        type="submit"
        className="self-end"
        disabled={
          busy ||
          name !== debouncedName ||
          destinationQuery.isFetching ||
          destinationQuery.isError ||
          !destinationQuery.data
        }
      >
        {busy ? 'Creating…' : 'Create worktree'}
      </Button>
    </form>
  )
}

function TerminalPresetsManager({
  presets,
  loading,
  loadError,
  onRetry,
  setError
}: {
  presets: TerminalPreset[]
  loading: boolean
  loadError: boolean
  onRetry: () => void
  setError: (value: string | null) => void
}) {
  const queryClient = useQueryClient()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [executable, setExecutable] = useState('')
  const [args, setArgs] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)

  const resetForm = () => {
    setEditingId(null)
    setLoadedUpdatedAt(null)
    setName('')
    setExecutable('')
    setArgs([])
    setNotice(null)
  }

  useEffect(() => {
    if (!editingId) {
      return
    }

    const preset = presets.find((candidate) => candidate.id === editingId)
    if (!preset) {
      setEditingId(null)
      setLoadedUpdatedAt(null)
      setName('')
      setExecutable('')
      setArgs([])
      setNotice('That preset was deleted. You can create a new one.')
      return
    }

    if (preset.updatedAt !== loadedUpdatedAt) {
      setLoadedUpdatedAt(preset.updatedAt)
      setName(preset.name)
      setExecutable(preset.executable)
      setArgs([...preset.args])
      if (loadedUpdatedAt) {
        setNotice(
          'This preset changed, so the latest saved values were loaded.'
        )
      }
    }
  }, [editingId, loadedUpdatedAt, presets])

  const savePreset = useMutation({
    mutationFn: ({
      presetId,
      input,
      expectedUpdatedAt
    }: {
      presetId: string | null
      input: Pick<TerminalPreset, 'name' | 'executable' | 'args'>
      expectedUpdatedAt: string | null
    }) =>
      presetId
        ? apiClient.updateTerminalPreset(presetId, input, expectedUpdatedAt!)
        : apiClient.createTerminalPreset(input),
    onSuccess: (preset, variables) => {
      queryClient.setQueryData<TerminalPreset[]>(
        terminalPresetsQueryKey,
        (current) =>
          variables.presetId
            ? current?.map((candidate) =>
                candidate.id === preset.id ? preset : candidate
              )
            : [...(current ?? []), preset]
      )
      setEditingId(preset.id)
      setLoadedUpdatedAt(preset.updatedAt)
      setName(preset.name)
      setExecutable(preset.executable)
      setArgs([...preset.args])
      setNotice('Preset saved.')
    },
    onError: (mutationError) => {
      void queryClient.invalidateQueries({ queryKey: terminalPresetsQueryKey })
      showError(setError)(mutationError)
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: terminalPresetsQueryKey })
  })

  const deletePreset = useMutation({
    mutationFn: (preset: TerminalPreset) =>
      apiClient.deleteTerminalPreset(preset.id, preset.updatedAt),
    onSuccess: (_, deletedPreset) => {
      queryClient.setQueryData<TerminalPreset[]>(
        terminalPresetsQueryKey,
        (current) => current?.filter((preset) => preset.id !== deletedPreset.id)
      )
      if (editingId === deletedPreset.id) {
        resetForm()
        setNotice('Preset deleted.')
      }
    },
    onError: (mutationError) => {
      void queryClient.invalidateQueries({ queryKey: terminalPresetsQueryKey })
      showError(setError)(mutationError)
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: terminalPresetsQueryKey })
  })

  const busy = savePreset.isPending || deletePreset.isPending
  return (
    <div className="flex flex-col gap-5">
      <ModalHeading eyebrow="Terminals" title="Terminal presets" />
      <p className="form-note max-w-[65ch]">
        Presets keep the executable separate from its ordered arguments. Shell
        is built in and always starts TaskTTY’s configured login shell.
      </p>
      <div className="grid min-h-0 gap-5 md:grid-cols-[minmax(12rem,0.8fr)_minmax(0,1.35fr)]">
        <section
          className="flex min-w-0 flex-col gap-2"
          aria-labelledby="saved-presets-title"
        >
          <div className="flex items-center justify-between gap-3">
            <h3
              id="saved-presets-title"
              className="text-sm font-medium text-zinc-200"
            >
              Saved presets
            </h3>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={resetForm}
            >
              <PlusIcon /> New preset
            </Button>
          </div>
          <div className="max-h-72 overflow-y-auto rounded-lg bg-white/3 p-1 ring-1 ring-white/8 [scrollbar-color:var(--color-zinc-700)_transparent]">
            <div className="flex min-h-11 items-center gap-2 rounded-md px-2.5 py-2">
              <CommandLineIcon className="shrink-0 text-zinc-500" />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="text-sm font-medium text-zinc-100">Shell</span>
                <span className="text-xs text-zinc-500">
                  Built in · login shell
                </span>
              </span>
            </div>
            {presets.map((preset) => (
              <div
                key={preset.id}
                className={cn(
                  'group/preset flex min-h-11 items-center gap-1 rounded-md px-2.5 py-1.5',
                  editingId === preset.id && 'bg-white/7'
                )}
              >
                <button
                  type="button"
                  className="grid min-w-0 flex-1 cursor-pointer gap-0.5 rounded-sm text-left outline-none focus-visible:outline-2 focus-visible:outline-cyan-400"
                  disabled={busy}
                  onClick={() => {
                    setEditingId(preset.id)
                    setLoadedUpdatedAt(preset.updatedAt)
                    setName(preset.name)
                    setExecutable(preset.executable)
                    setArgs([...preset.args])
                    setNotice(null)
                  }}
                >
                  <span className="truncate text-sm font-medium text-zinc-100">
                    {preset.name}
                  </span>
                  <span className="truncate text-xs text-zinc-500">
                    {preset.executable} · {preset.args.length}{' '}
                    {preset.args.length === 1 ? 'argument' : 'arguments'}
                  </span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-11 min-[701px]:size-7"
                  aria-label={`Edit ${preset.name}`}
                  disabled={busy}
                  onClick={() => {
                    setEditingId(preset.id)
                    setLoadedUpdatedAt(preset.updatedAt)
                    setName(preset.name)
                    setExecutable(preset.executable)
                    setArgs([...preset.args])
                    setNotice(null)
                  }}
                >
                  <PencilIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-11 hover:text-rose-300 min-[701px]:size-7"
                  aria-label={`Delete ${preset.name}`}
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(`Delete terminal preset “${preset.name}”?`)
                    ) {
                      deletePreset.mutate(preset)
                    }
                  }}
                >
                  <TrashIcon />
                </Button>
              </div>
            ))}
            {!loading && !loadError && presets.length === 0 && (
              <p className="px-2.5 py-3 text-sm text-zinc-500">
                No saved presets yet.
              </p>
            )}
            {loading && (
              <p className="px-2.5 py-3 text-sm text-zinc-500" role="status">
                Loading presets…
              </p>
            )}
            {loadError && (
              <div className="flex items-center justify-between gap-3 px-2.5 py-3">
                <p className="text-sm text-zinc-400">Could not load presets.</p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={onRetry}
                >
                  Retry
                </Button>
              </div>
            )}
          </div>
        </section>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            savePreset.mutate({
              presetId: editingId,
              input: { name, executable, args: [...args] },
              expectedUpdatedAt: loadedUpdatedAt
            })
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-zinc-200">
              {editingId ? 'Edit preset' : 'New preset'}
            </h3>
            {notice && (
              <span className="text-xs text-zinc-400" role="status">
                {notice}
              </span>
            )}
          </div>
          <FormField>
            <Label htmlFor="preset-name">Name</Label>
            <Input
              id="preset-name"
              name="preset-name"
              value={name}
              maxLength={TERMINAL_NAME_MAX_LENGTH}
              disabled={busy}
              autoFocus
              required
              onChange={(event) => {
                setName(event.target.value)
                setNotice(null)
              }}
              placeholder="Code review"
            />
          </FormField>
          <FormField>
            <Label htmlFor="preset-executable">Executable</Label>
            <Input
              id="preset-executable"
              name="preset-executable"
              value={executable}
              maxLength={TERMINAL_EXECUTABLE_MAX_LENGTH}
              disabled={busy}
              required
              onChange={(event) => {
                setExecutable(event.target.value)
                setNotice(null)
              }}
              placeholder="npx"
            />
          </FormField>
          <fieldset className="flex min-w-0 flex-col gap-2" disabled={busy}>
            <legend className="sr-only">Arguments</legend>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-zinc-200">
                Arguments
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={
                  busy || args.length >= TERMINAL_PRESET_ARGUMENT_MAX_COUNT
                }
                onClick={() => {
                  setArgs((current) => [...current, ''])
                  setNotice(null)
                }}
              >
                <PlusIcon /> Add argument
              </Button>
            </div>
            {args.length === 0 && (
              <p className="form-note">
                No arguments. Empty arguments are preserved when added.
              </p>
            )}
            <div className="flex max-h-64 flex-col gap-2 overflow-y-auto p-0.5 [scrollbar-color:var(--color-zinc-700)_transparent]">
              {args.map((argument, index) => (
                <div
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-1"
                  key={index}
                >
                  <Label
                    className="sr-only"
                    htmlFor={`preset-argument-${index}`}
                  >
                    Argument {index + 1}
                  </Label>
                  <Input
                    id={`preset-argument-${index}`}
                    value={argument}
                    maxLength={TERMINAL_ARGUMENT_MAX_LENGTH}
                    onChange={(event) => {
                      const value = event.target.value
                      setArgs((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? value : item
                        )
                      )
                      setNotice(null)
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-11 min-[701px]:size-7"
                    aria-label={`Move argument ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() =>
                      setArgs((current) => {
                        const next = [...current]
                        const previous = next[index - 1]!
                        next[index - 1] = next[index]!
                        next[index] = previous
                        return next
                      })
                    }
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-11 min-[701px]:size-7"
                    aria-label={`Move argument ${index + 1} down`}
                    disabled={index === args.length - 1}
                    onClick={() =>
                      setArgs((current) => {
                        const next = [...current]
                        const following = next[index + 1]!
                        next[index + 1] = next[index]!
                        next[index] = following
                        return next
                      })
                    }
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-11 hover:text-rose-300 min-[701px]:size-7"
                    aria-label={`Remove argument ${index + 1}`}
                    onClick={() =>
                      setArgs((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index)
                      )
                    }
                  >
                    <TrashIcon />
                  </Button>
                </div>
              ))}
            </div>
          </fieldset>
          <Button
            type="submit"
            className="self-end"
            disabled={
              busy ||
              !name.trim() ||
              !executable.trim() ||
              (editingId !== null && loadedUpdatedAt === null)
            }
          >
            {savePreset.isPending ? 'Saving…' : 'Save preset'}
          </Button>
        </form>
      </div>
    </div>
  )
}

function RemoveConfirm({
  worktree,
  preview,
  busy,
  onConfirm
}: {
  worktree: WorktreeRecord
  preview: RemovePreview | null
  busy: boolean
  onConfirm: (preview: RemovePreview) => void
}) {
  const destructive = Boolean(preview?.warnings.length)
  const name = preview?.name ?? worktree.name
  const branch = preview ? preview.branch : worktree.branch
  const detached = preview?.detached ?? worktree.detached
  const head = preview?.head ?? worktree.head
  const worktreePath = preview?.path ?? worktree.path
  return (
    <div className="flex flex-col gap-5">
      <ModalHeading
        eyebrow={destructive ? 'Destructive removal' : 'Worktree'}
        title="Remove worktree"
      />
      <dl className="facts">
        <div>
          <dt>Name</dt>
          <dd>{name}</dd>
        </div>
        <div>
          <dt>Git state</dt>
          <dd>
            {!detached && branch
              ? `Branch ${branch} (preserved)`
              : `Detached at ${head.slice(0, 8)}`}
          </dd>
        </div>
        <div>
          <dt>Path</dt>
          <dd>{worktreePath}</dd>
        </div>
        <div>
          <dt>Uncommitted</dt>
          <dd>
            {preview
              ? `${preview.dirty.total} (${preview.dirty.staged} staged, ${preview.dirty.unstaged} unstaged, ${preview.dirty.untracked} untracked, ${preview.dirty.conflicts} conflicted)`
              : 'checking…'}
          </dd>
        </div>
        <div>
          <dt>Terminals stopped</dt>
          <dd>
            {preview
              ? preview.terminals.map((terminal) => terminal.name).join(', ') ||
                'none'
              : 'checking…'}
          </dd>
        </div>
      </dl>
      {preview && preview.reasons.length > 0 && (
        <div className="warning">
          <strong>Removal refused</strong>
          <ul role="list">
            {preview.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
      {preview && preview.warnings.length > 0 && (
        <div className="warning danger">
          <strong>Local work may be lost.</strong>
          <ul role="list">
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      <Button
        type="button"
        variant="destructive"
        className="self-end"
        disabled={busy || !preview?.eligible}
        onClick={() => preview && onConfirm(preview)}
      >
        {busy ? 'Removing…' : destructive ? 'Remove anyway' : 'Remove worktree'}
      </Button>
    </div>
  )
}

function showError(setError: (value: string | null) => void) {
  return (value: unknown) =>
    setError(value instanceof Error ? value.message : String(value))
}
