import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowPathIcon,
  Bars3Icon,
  ChevronRightIcon,
  CommandLineIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/16/solid";
import type { ProjectRecord, RemovePreview, TerminalRecord, WorktreeRecord } from "@wtr/shared";
import { ApiError, apiClient } from "./api.js";
import { Button } from "./components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible.js";
import { Input } from "./components/ui/input.js";
import { Label } from "./components/ui/label.js";
import { NativeSelect } from "./components/ui/native-select.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip.js";
import { cn } from "./lib/utils.js";
import {
  createInvalidationCoalescer,
  METADATA_DEGRADED_GRACE_MS,
  METADATA_STALE_TIME_MS,
  metadataRetryDelay,
  shouldRetryMetadataQuery,
} from "./metadata-sync.js";
import { terminalSessions } from "./terminal-session.js";
import { TerminalView } from "./terminal-view.js";

const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 420;
const DEFAULT_SIDEBAR_WIDTH = 272;
const EMPTY_RUNTIME_TITLES: ReadonlyMap<string, string> = new Map();
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => !element.closest("[inert]") && element.getClientRects().length > 0,
  );
}

function trapTabKey(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== "Tab") return;
  const elements = focusableElements(container);
  if (!elements.length) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = elements[0]!;
  const last = elements.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

type Modal =
  | { type: "project" }
  | { type: "worktree"; project: ProjectRecord }
  | { type: "remove"; worktree: WorktreeRecord }
  | null;

const projectsQueryKey = ["projects"] as const;

interface PendingWorktreeCreation {
  id: string;
  projectId: string;
  typedName: string;
  canonicalName: string;
  destinationPath: string;
  base: "default" | "current";
  sourceWorktreeId?: string;
}

interface WorktreeDestination {
  name: string;
  path: string;
}

export default function App() {
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({
    queryKey: projectsQueryKey,
    queryFn: apiClient.projects,
    staleTime: METADATA_STALE_TIME_MS,
    retry: shouldRetryMetadataQuery,
    retryDelay: metadataRetryDelay,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
  const projects = projectsQuery.data ?? [];
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(() =>
    localStorage.getItem("wtr-terminal"),
  );
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [pendingWorktrees, setPendingWorktrees] = useState<PendingWorktreeCreation[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const savedWidth = Number.parseInt(localStorage.getItem("wtr-sidebar-width") ?? "", 10);
    return Number.isFinite(savedWidth) ? clampSidebarWidth(savedWidth) : DEFAULT_SIDEBAR_WIDTH;
  });
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [sseDisconnected, setSseDisconnected] = useState(false);
  const [showSyncDegraded, setShowSyncDegraded] = useState(false);
  const selectedWorktreeIdRef = useRef<string | null>(null);
  const resizeOrigin = useRef<{ pointerX: number; width: number } | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const modalTriggerRef = useRef<HTMLElement | null>(null);

  const unauthorized =
    projectsQuery.error instanceof ApiError && projectsQuery.error.status === 401;

  useEffect(() => {
    if (projectsQuery.error && projectsQuery.data === undefined && !unauthorized)
      showError(setError)(projectsQuery.error);
  }, [projectsQuery.data, projectsQuery.error, unauthorized]);

  useEffect(() => {
    const degraded =
      projectsQuery.data !== undefined && (sseDisconnected || projectsQuery.isRefetchError);
    if (!degraded) {
      setShowSyncDegraded(false);
      return;
    }
    const timer = window.setTimeout(() => setShowSyncDegraded(true), METADATA_DEGRADED_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [projectsQuery.data, projectsQuery.isRefetchError, sseDisconnected]);

  useEffect(() => {
    const next = projectsQuery.data;
    if (!next) return;
    setSelectedTerminalId((current) => {
      if (
        current &&
        next.some((project) =>
          project.worktrees.some((worktree) =>
            worktree.terminals.some((terminal) => terminal.id === current),
          ),
        )
      ) {
        return current;
      }
      const selectedWorktree = next
        .flatMap((project) => project.worktrees)
        .find((worktree) => worktree.id === selectedWorktreeIdRef.current);
      if (selectedWorktreeIdRef.current) return selectedWorktree?.terminals[0]?.id ?? null;
      return (
        next.flatMap((project) => project.worktrees.flatMap((worktree) => worktree.terminals))[0]
          ?.id ?? null
      );
    });
  }, [projectsQuery.data]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!isMobile || !drawerOpen) return;
    const drawer = drawerRef.current;
    if (!drawer) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const frame = window.requestAnimationFrame(() => {
      focusableElements(drawer)[0]?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
      else drawerTriggerRef.current?.focus();
    };
  }, [drawerOpen, isMobile]);

  useEffect(() => {
    if (!isMobile || !drawerOpen || modal) return;
    const drawer = drawerRef.current;
    if (!drawer) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDrawerOpen(false);
        return;
      }
      trapTabKey(event, drawer);
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [drawerOpen, isMobile, modal]);

  useEffect(() => {
    if (unauthorized) return;
    const events = new EventSource("/api/events");
    const refreshes = createInvalidationCoalescer(() =>
      queryClient.invalidateQueries({ queryKey: projectsQueryKey }, { cancelRefetch: false }),
    );
    const refresh = () => refreshes.schedule();
    const connected = () => {
      setSseDisconnected(false);
      refresh();
    };
    const disconnected = () => setSseDisconnected(true);
    const eventNames = [
      "project.created",
      "project.updated",
      "worktree.created",
      "worktree.updated",
      "worktree.removed",
      "terminal.created",
      "terminal.updated",
      "terminal.removed",
      "remove.completed",
      "remove.failed",
    ];
    events.addEventListener("connected", connected);
    events.addEventListener("error", disconnected);
    eventNames.forEach((name) => events.addEventListener(name, refresh));
    return () => {
      refreshes.dispose();
      events.close();
    };
  }, [queryClient, unauthorized]);

  const allWorktrees = useMemo(() => projects.flatMap((project) => project.worktrees), [projects]);
  const allTerminals = useMemo(
    () => allWorktrees.flatMap((worktree) => worktree.terminals),
    [allWorktrees],
  );
  useEffect(() => {
    terminalSessions.reconcile(allTerminals);
  }, [allTerminals]);
  const runtimeTitles = useSyncExternalStore(
    terminalSessions.subscribe,
    terminalSessions.getTitleSnapshot,
    () => EMPTY_RUNTIME_TITLES,
  );
  const terminalById = allTerminals.find((terminal) => terminal.id === selectedTerminalId) ?? null;
  useEffect(() => {
    if (!terminalById) return;
    selectedWorktreeIdRef.current = terminalById.worktreeId;
    setSelectedWorktreeId((current) =>
      current === terminalById.worktreeId ? current : terminalById.worktreeId,
    );
  }, [terminalById?.id, terminalById?.worktreeId]);
  const selectedWorktree =
    allWorktrees.find((worktree) => worktree.id === selectedWorktreeId) ??
    (terminalById
      ? (allWorktrees.find((worktree) => worktree.id === terminalById.worktreeId) ?? null)
      : null);
  const selectedTerminal =
    selectedWorktree?.terminals.find((terminal) => terminal.id === selectedTerminalId) ?? null;

  const selectTerminal = (terminal: TerminalRecord) => {
    setSelectedTerminalId(terminal.id);
    setSelectedWorktreeId(terminal.worktreeId);
    selectedWorktreeIdRef.current = terminal.worktreeId;
    localStorage.setItem("wtr-terminal", terminal.id);
    setDrawerOpen(false);
  };

  const selectWorktree = (worktree: WorktreeRecord) => {
    setSelectedWorktreeId(worktree.id);
    selectedWorktreeIdRef.current = worktree.id;
    const nextTerminal =
      worktree.terminals.find((terminal) => terminal.id === selectedTerminalId) ??
      worktree.terminals[0] ??
      null;
    setSelectedTerminalId(nextTerminal?.id ?? null);
    if (nextTerminal) localStorage.setItem("wtr-terminal", nextTerminal.id);
    else localStorage.removeItem("wtr-terminal");
    setDrawerOpen(false);
  };

  const createWorktree = useMutation({
    mutationFn: (pending: PendingWorktreeCreation) =>
      apiClient.createWorktree(
        pending.projectId,
        pending.typedName,
        pending.base,
        pending.sourceWorktreeId,
      ),
    onSuccess: async (result, pending) => {
      await queryClient.cancelQueries({ queryKey: projectsQueryKey });
      const worktree =
        result.terminal &&
        !result.worktree.terminals.some((item) => item.id === result.terminal?.id)
          ? { ...result.worktree, terminals: [...result.worktree.terminals, result.terminal] }
          : result.worktree;
      queryClient.setQueryData<ProjectRecord[]>(projectsQueryKey, (current) =>
        current?.map((project) =>
          project.id === pending.projectId
            ? {
                ...project,
                worktrees: [
                  ...project.worktrees.filter((item) => item.id !== worktree.id),
                  worktree,
                ],
              }
            : project,
        ),
      );
      if (result.terminal) selectTerminal(result.terminal);
      else selectWorktree(worktree);
      setPendingWorktrees((current) => current.filter((item) => item.id !== pending.id));
      if (result.setupError)
        setError(`Worktree created, but setup could not start: ${result.setupError}`);
      else if (result.terminalError)
        setError(`Worktree created, but its terminal could not start: ${result.terminalError}`);
      await queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
    onError: (mutationError, pending) => {
      setPendingWorktrees((current) => current.filter((item) => item.id !== pending.id));
      setDrawerOpen(false);
      showError(setError)(mutationError);
    },
  });

  const submitWorktreeCreation = (
    project: ProjectRecord,
    name: string,
    base: "default" | "current",
    destination: WorktreeDestination,
    sourceWorktreeId?: string,
  ) => {
    if (pendingWorktrees.some((item) => item.projectId === project.id)) return;
    const pending: PendingWorktreeCreation = {
      id: crypto.randomUUID(),
      projectId: project.id,
      typedName: name,
      canonicalName: destination.name,
      destinationPath: destination.path,
      base,
      ...(sourceWorktreeId ? { sourceWorktreeId } : {}),
    };
    setPendingWorktrees((current) => [...current, pending]);
    setModal(null);
    window.requestAnimationFrame(() => {
      document.getElementById(`pending-worktree-${pending.id}`)?.focus();
    });
    createWorktree.mutate(pending);
  };

  const createTerminal = useMutation({
    mutationFn: (worktree: WorktreeRecord) => apiClient.createTerminal(worktree.id, "Terminal"),
    onSuccess: async (terminal) => {
      selectTerminal(terminal);
      await queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
    onError: showError(setError),
  });

  const closeTerminal = useMutation({
    mutationFn: (terminal: TerminalRecord) => apiClient.deleteTerminal(terminal.id),
    onSuccess: async (_, closedTerminal) => {
      terminalSessions.forget(closedTerminal.id);
      if (selectedTerminalId === closedTerminal.id) {
        const terminals = selectedWorktree?.terminals ?? [];
        const closedIndex = terminals.findIndex((terminal) => terminal.id === closedTerminal.id);
        const nextTerminal = terminals[closedIndex + 1] ?? terminals[closedIndex - 1] ?? null;
        setSelectedTerminalId(nextTerminal?.id ?? null);
        if (nextTerminal) localStorage.setItem("wtr-terminal", nextTerminal.id);
        else localStorage.removeItem("wtr-terminal");
      }
      await queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
    onError: showError(setError),
  });

  const setAndSaveSidebarWidth = (width: number) => {
    const nextWidth = clampSidebarWidth(width);
    setSidebarWidth(nextWidth);
    localStorage.setItem("wtr-sidebar-width", String(nextWidth));
  };

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    resizeOrigin.current = { pointerX: event.clientX, width: sidebarWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingSidebar(true);
  };

  const resizeSidebar = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeOrigin.current) return;
    setAndSaveSidebarWidth(
      resizeOrigin.current.width + event.clientX - resizeOrigin.current.pointerX,
    );
  };

  const openModal = (nextModal: Exclude<Modal, null>, trigger?: HTMLElement) => {
    modalTriggerRef.current = trigger ?? (document.activeElement as HTMLElement | null);
    setModal(nextModal);
  };

  const stopSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    resizeOrigin.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setResizingSidebar(false);
  };

  const resizeSidebarWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextWidth = sidebarWidth;
    if (event.key === "ArrowLeft") nextWidth -= event.shiftKey ? 32 : 16;
    else if (event.key === "ArrowRight") nextWidth += event.shiftKey ? 32 : 16;
    else if (event.key === "Home") nextWidth = MIN_SIDEBAR_WIDTH;
    else if (event.key === "End") nextWidth = MAX_SIDEBAR_WIDTH;
    else return;
    event.preventDefault();
    setAndSaveSidebarWidth(nextWidth);
  };

  if (unauthorized) return <Login onSuccess={() => void projectsQuery.refetch()} />;

  return (
    <div
      className={cn(
        "app-frame isolate grid h-dvh grid-cols-[var(--sidebar-width)_minmax(0,1fr)] bg-zinc-950 max-[700px]:grid-cols-1 max-[700px]:grid-rows-[3.25rem_minmax(0,1fr)]",
        resizingSidebar && "select-none",
      )}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <header
        className="mobile-bar hidden min-w-0 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center gap-2 border-b border-white/8 bg-zinc-900/95 px-2 backdrop-blur max-[700px]:grid"
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
          value={selectedTerminalId ?? ""}
          onChange={(event) => {
            const terminal = allTerminals.find((item) => item.id === event.target.value);
            if (terminal) selectTerminal(terminal);
          }}
        >
          <option value="">Select terminal</option>
          {allTerminals.map((terminal) => (
            <option value={terminal.id} key={terminal.id}>
              {runtimeTitles.get(terminal.id) || terminal.name}
            </option>
          ))}
        </NativeSelect>
        <span className="mobile-brand font-mono text-sm font-semibold tracking-tight text-cyan-300">
          wtr
        </span>
      </header>
      <div
        className={cn(
          "drawer-backdrop fixed inset-0 z-30 bg-black/60 opacity-0 backdrop-blur-sm transition-opacity pointer-events-none min-[701px]:hidden",
          drawerOpen && "opacity-100 pointer-events-auto",
        )}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />
      <aside
        ref={drawerRef}
        id="worktree-sidebar"
        role={isMobile ? "dialog" : undefined}
        aria-modal={isMobile && drawerOpen ? true : undefined}
        aria-labelledby={isMobile ? "worktree-drawer-title" : undefined}
        aria-hidden={isMobile && !drawerOpen ? true : undefined}
        inert={isMobile && !drawerOpen ? true : undefined}
        className={cn(
          "sidebar relative z-40 flex min-h-0 flex-col border-r border-white/8 bg-zinc-900/80 backdrop-blur-xl max-[700px]:fixed max-[700px]:inset-y-0 max-[700px]:left-0 max-[700px]:w-[min(88vw,21rem)] max-[700px]:-translate-x-full max-[700px]:shadow-2xl max-[700px]:transition-transform",
          drawerOpen && "open max-[700px]:translate-x-0",
        )}
      >
        <h2 id="worktree-drawer-title" className="sr-only">
          Projects and worktrees
        </h2>
        <div
          className={cn(
            "absolute inset-y-0 right-0 z-50 w-3 translate-x-1/2 touch-none cursor-col-resize outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-white/8 after:absolute after:top-1/2 after:left-1/2 after:h-8 after:w-1 after:-translate-1/2 after:rounded-full after:bg-zinc-700 hover:before:w-0.5 hover:before:bg-cyan-400/60 hover:after:bg-cyan-400 focus-visible:before:w-0.5 focus-visible:before:bg-cyan-400 focus-visible:after:bg-cyan-400 max-[700px]:hidden",
            resizingSidebar && "before:w-0.5 before:bg-cyan-400",
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
              Register a Git repository to begin.
            </p>
          ) : null}
          <div className="grid gap-5 sm:gap-4">
            {projects.map((project) => (
              <Collapsible className="project-tree" defaultOpen key={project.id}>
                <div className="project-row flex min-h-11 items-center gap-1 px-1 sm:min-h-7">
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="group/project min-w-0 flex-1 justify-start px-1.5 text-base font-medium text-zinc-100 hover:bg-white/5 sm:text-[0.8125rem]"
                      title={project.repositoryPath}
                    >
                      <ChevronRightIcon className="shrink-0 text-zinc-600 transition-transform group-data-[state=open]/project:rotate-90" />
                      <span className="truncate">{project.name}</span>
                    </Button>
                  </CollapsibleTrigger>
                </div>
                <CollapsibleContent asChild>
                  <ul role="list" className="ml-3 grid gap-0.5 border-l border-white/8 pl-1.5">
                    {project.worktrees.map((worktree) => (
                      <li key={worktree.id} className="group/worktree min-w-0">
                        <div className="relative min-w-0">
                          <Button
                            variant="ghost"
                            type="button"
                            className={cn(
                              "worktree-row h-auto min-h-11 w-full min-w-0 justify-start gap-1.5 rounded-md px-2 py-1.5 text-left text-base font-normal sm:min-h-7 sm:py-0.5 sm:text-[0.6875rem]",
                              selectedWorktree?.id === worktree.id
                                ? "selected bg-white/8 text-zinc-50"
                                : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100",
                            )}
                            onClick={() => selectWorktree(worktree)}
                            title={`${worktree.path}${worktree.branch ? ` · ${worktree.branch}` : ` · detached at ${worktree.head.slice(0, 8)}`}`}
                          >
                            <span className="branch-line flex min-w-0 items-center gap-1.5 truncate">
                              <span
                                className={cn(
                                  "size-1.5 shrink-0 rounded-full",
                                  worktree.dirty?.dirty
                                    ? "bg-amber-400 ring-2 ring-amber-400/10"
                                    : "bg-zinc-600",
                                )}
                              />
                              <span className="truncate">{worktree.name}</span>
                            </span>
                          </Button>
                          {worktree.kind === "linked" && (
                            <div className="worktree-actions absolute top-0 right-0 z-10 flex items-center gap-0.5 rounded-md bg-zinc-900 opacity-0 shadow-sm ring-1 ring-white/8 group-hover/worktree:opacity-100 group-focus-within/worktree:opacity-100 max-[700px]:relative max-[700px]:mt-0.5 max-[700px]:ml-7 max-[700px]:w-fit max-[700px]:opacity-100">
                              <SidebarAction
                                label={`Remove ${worktree.name}`}
                                tooltip="Remove worktree"
                                className="text-zinc-500 hover:bg-rose-400/8 hover:text-rose-300"
                                onClick={(trigger) =>
                                  openModal({ type: "remove", worktree }, trigger)
                                }
                              >
                                <TrashIcon />
                              </SidebarAction>
                            </div>
                          )}
                        </div>
                        <ul
                          role="list"
                          className="terminal-list ml-3 grid gap-0 border-l border-white/6 pl-1.5"
                        >
                          {worktree.terminals.map((terminal) => (
                            <li key={terminal.id} className="min-w-0">
                              <Button
                                variant="ghost"
                                type="button"
                                className={cn(
                                  "terminal-row grid h-auto min-h-11 w-full min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_0.5rem] gap-1.5 rounded-md px-2 py-1.5 text-left text-base font-normal sm:min-h-7 sm:grid-cols-[1rem_minmax(0,1fr)_0.5rem] sm:py-0.5 sm:text-[0.6875rem]",
                                  selectedTerminalId === terminal.id
                                    ? "selected bg-cyan-400/8 text-cyan-50"
                                    : "text-zinc-500 hover:bg-white/5 hover:text-zinc-100",
                                )}
                                onClick={() => selectTerminal(terminal)}
                              >
                                <CommandLineIcon className="size-5 shrink-0 text-zinc-600 sm:size-4" />
                                <span className="truncate">
                                  {runtimeTitles.get(terminal.id) || terminal.name}
                                </span>
                                <span
                                  className={cn(
                                    "status-dot size-1.5 shrink-0 rounded-full bg-zinc-600",
                                    terminal.status === "running" && "bg-emerald-400",
                                    terminal.status === "exited" && "bg-rose-400",
                                  )}
                                  title={terminal.status}
                                />
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                    {pendingWorktrees
                      .filter(
                        (pending) =>
                          pending.projectId === project.id &&
                          !project.worktrees.some(
                            (worktree) => worktree.path === pending.destinationPath,
                          ),
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
                            <span className="truncate">{pending.typedName}</span>
                          </div>
                        </li>
                      ))}
                    <li className="min-w-0">
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-auto min-h-11 w-full justify-start gap-1.5 px-2 py-1.5 text-base font-normal text-zinc-500 hover:bg-white/5 hover:text-zinc-100 sm:min-h-7 sm:py-0.5 sm:text-[0.6875rem]"
                        disabled={pendingWorktrees.some(
                          (pending) => pending.projectId === project.id,
                        )}
                        onClick={(event) =>
                          openModal({ type: "worktree", project }, event.currentTarget)
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
            type="button"
            variant="ghost"
            size="sm"
            className="flex-1 justify-start text-zinc-500 hover:bg-white/5 hover:text-zinc-200 sm:text-[0.8125rem]"
            onClick={(event) => openModal({ type: "project" }, event.currentTarget)}
          >
            <PlusIcon /> Add project
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
          onSelectTerminal={selectTerminal}
          onCreateTerminal={() => selectedWorktree && createTerminal.mutate(selectedWorktree)}
          creatingTerminal={
            createTerminal.isPending && createTerminal.variables?.id === selectedWorktree?.id
          }
          onCloseTerminal={(terminal) => {
            if (
              window.confirm(
                `Close terminal “${runtimeTitles.get(terminal.id) || terminal.name}”? Its tmux session and process will be terminated.`,
              )
            ) {
              closeTerminal.mutate(terminal);
            }
          }}
          closingTerminalId={closeTerminal.isPending ? closeTerminal.variables?.id : null}
          onStatusChange={() => void queryClient.invalidateQueries({ queryKey: projectsQueryKey })}
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
          onCreateWorktree={submitWorktreeCreation}
        />
      )}
    </div>
  );
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
  );
}

function FormField({ children }: { children: ReactNode }) {
  return <div className="grid gap-2">{children}</div>;
}

function SidebarAction({
  label,
  tooltip = label,
  className,
  disabled,
  onClick,
  children,
}: {
  label: string;
  tooltip?: string;
  className?: string;
  disabled?: boolean;
  onClick: (trigger: HTMLButtonElement) => void;
  children: ReactNode;
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
  );
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [token, setToken] = useState("");
  const login = useMutation({
    mutationFn: apiClient.login,
    onSuccess,
  });
  return (
    <main className="login-page isolate grid min-h-dvh place-items-center bg-[radial-gradient(circle_at_center,var(--color-zinc-900)_0,var(--color-zinc-950)_58%)] p-6">
      <form
        className="flex w-full max-w-xs flex-col gap-5 rounded-xl bg-zinc-900/70 p-6 shadow-2xl ring-1 ring-white/8 backdrop-blur"
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate(token);
        }}
      >
        <div className="grid gap-2">
          <p className="eyebrow">Private terminal access</p>
          <h1 className="text-balance text-2xl font-semibold tracking-tight text-zinc-50">
            Unlock wtr
          </h1>
          <p className="text-base text-pretty text-zinc-400 sm:text-sm">
            Enter the daemon’s static authentication token. It is stored only in an HttpOnly session
            cookie.
          </p>
        </div>
        <FormField>
          <Label htmlFor="token">Authentication token</Label>
          <Input
            id="token"
            name="token"
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            required
          />
        </FormField>
        {login.error && <p className="form-error">{login.error.message}</p>}
        <Button type="submit" className="self-end" disabled={login.isPending}>
          {login.isPending ? "Unlocking…" : "Continue"}
        </Button>
      </form>
    </main>
  );
}

function ActionModal({
  modal,
  close,
  restoreFocusTo,
  setError,
  onCreateWorktree,
}: {
  modal: Exclude<Modal, null>;
  close: () => void;
  restoreFocusTo: HTMLElement | null;
  setError: (value: string | null) => void;
  onCreateWorktree: (
    project: ProjectRecord,
    name: string,
    base: "default" | "current",
    destination: WorktreeDestination,
    sourceWorktreeId?: string,
  ) => void;
}) {
  const queryClient = useQueryClient();
  const worktreeId = modal.type === "remove" ? modal.worktree.id : null;
  const previewQuery = useQuery({
    queryKey: ["remove-preview", worktreeId],
    queryFn: () => {
      if (modal.type !== "remove") throw new Error("A removal preview is not available");
      return apiClient.removePreview(modal.worktree.id);
    },
    enabled: modal.type === "remove",
  });
  const [refreshingStalePreview, setRefreshingStalePreview] = useState(false);
  const actionMutation = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      close();
      await queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
    onError: (error) => {
      if (
        modal.type === "remove" &&
        error instanceof ApiError &&
        error.code === "REMOVE_PREVIEW_STALE"
      ) {
        setRefreshingStalePreview(true);
        void previewQuery.refetch().finally(() => setRefreshingStalePreview(false));
        return;
      }
      showError(setError)(error);
    },
  });

  useEffect(() => {
    if (previewQuery.error) showError(setError)(previewQuery.error);
  }, [previewQuery.error, setError]);

  const submit = (action: () => Promise<unknown>) => actionMutation.mutate(action);
  const busy = actionMutation.isPending;
  const freshRemovePreview =
    !previewQuery.isFetching && !previewQuery.isError && !refreshingStalePreview
      ? (previewQuery.data ?? null)
      : null;
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const appFrame = document.querySelector<HTMLElement>(".app-frame");
    appFrame?.setAttribute("inert", "");
    const frame = window.requestAnimationFrame(() => {
      const first = focusableElements(dialog)[0];
      if (first) first.focus();
      else dialog.focus();
    });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      trapTabKey(event, dialog);
    };
    document.addEventListener("keydown", keydown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keydown);
      appFrame?.removeAttribute("inert");
      if (restoreFocusTo?.isConnected) restoreFocusTo.focus();
      else if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  return createPortal(
    <div
      className="modal-backdrop fixed inset-0 z-60 grid place-items-center bg-black/70 p-4 backdrop-blur-sm max-[700px]:items-end max-[700px]:p-0"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <section
        ref={dialogRef}
        className="modal relative max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl bg-zinc-900 p-6 shadow-2xl ring-1 ring-white/10 max-[700px]:max-h-[90dvh] max-[700px]:max-w-none max-[700px]:rounded-b-none max-[700px]:p-5 max-[700px]:pb-[calc(1.25rem+env(safe-area-inset-bottom))]"
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
        {modal.type === "project" && (
          <ProjectForm
            busy={busy}
            onSubmit={(repositoryPath) => submit(() => apiClient.addProject(repositoryPath))}
          />
        )}
        {modal.type === "worktree" && (
          <WorktreeForm
            project={modal.project}
            busy={false}
            onSubmit={(name, base, destination, sourceWorktreeId) =>
              onCreateWorktree(modal.project, name, base, destination, sourceWorktreeId)
            }
          />
        )}
        {modal.type === "remove" && (
          <RemoveConfirm
            worktree={modal.worktree}
            preview={freshRemovePreview}
            busy={busy}
            onConfirm={(preview) =>
              submit(() => apiClient.removeWorktree(modal.worktree.id, preview))
            }
          />
        )}
      </section>
    </div>,
    document.body,
  );
}

function ProjectForm({ busy, onSubmit }: { busy: boolean; onSubmit: (path: string) => void }) {
  const [pathValue, setPathValue] = useState("");
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(pathValue);
      }}
    >
      <ModalHeading eyebrow="Repository" title="Register project" />
      <FormField>
        <Label htmlFor="repository-path">Repository path</Label>
        <Input
          id="repository-path"
          name="repository-path"
          value={pathValue}
          onChange={(event) => setPathValue(event.target.value)}
          placeholder="/Users/you/Projects/example"
          required
          autoFocus
        />
      </FormField>
      <p className="form-note">
        The daemon resolves the main checkout and imports existing linked worktrees.
      </p>
      <Button type="submit" className="self-end" disabled={busy}>
        {busy ? "Registering…" : "Register project"}
      </Button>
    </form>
  );
}

function WorktreeForm({
  project,
  busy,
  onSubmit,
}: {
  project: ProjectRecord;
  busy: boolean;
  onSubmit: (
    name: string,
    base: "default" | "current",
    destination: WorktreeDestination,
    sourceWorktreeId?: string,
  ) => void;
}) {
  const [name, setName] = useState("");
  const [baseValue, setBaseValue] = useState("default");
  const destinationQuery = useQuery({
    queryKey: ["worktree-destination", project.id, name],
    queryFn: () => apiClient.worktreeDestination(project.id, name),
    enabled: Boolean(name.trim()),
    retry: false,
  });
  const base = baseValue === "default" ? "default" : "current";
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!destinationQuery.data) return;
        onSubmit(name, base, destinationQuery.data, base === "current" ? baseValue : undefined);
      }}
    >
      <ModalHeading eyebrow={project.name} title="Create worktree" />
      <FormField>
        <Label htmlFor="worktree-name">Worktree name</Label>
        <Input
          id="worktree-name"
          name="worktree-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="investigate-cache"
          required
          autoFocus
          aria-invalid={destinationQuery.isError}
        />
      </FormField>
      <FormField>
        <Label htmlFor="worktree-base">Start from</Label>
        <NativeSelect
          id="worktree-base"
          name="worktree-base"
          value={baseValue}
          onChange={(event) => setBaseValue(event.target.value)}
        >
          <option value="default">Default branch ({project.defaultBranch})</option>
          {project.worktrees
            .filter((worktree) => worktree.status === "active")
            .map((worktree) => (
              <option key={worktree.id} value={worktree.id}>
                Current commit from {worktree.name}
              </option>
            ))}
        </NativeSelect>
      </FormField>
      <p className="form-note">
        {destinationQuery.data
          ? `Destination: ${destinationQuery.data.path}`
          : destinationQuery.error
            ? destinationQuery.error.message
            : "The daemon will create a detached worktree and run compatible setup tasks."}
      </p>
      <Button
        type="submit"
        className="self-end"
        disabled={
          busy || destinationQuery.isFetching || destinationQuery.isError || !destinationQuery.data
        }
      >
        {busy ? "Creating and setting up…" : "Create worktree"}
      </Button>
    </form>
  );
}

function RemoveConfirm({
  worktree,
  preview,
  busy,
  onConfirm,
}: {
  worktree: WorktreeRecord;
  preview: RemovePreview | null;
  busy: boolean;
  onConfirm: (preview: RemovePreview) => void;
}) {
  const destructive = Boolean(preview?.warnings.length);
  const name = preview?.name ?? worktree.name;
  const branch = preview ? preview.branch : worktree.branch;
  const detached = preview?.detached ?? worktree.detached;
  const head = preview?.head ?? worktree.head;
  const worktreePath = preview?.path ?? worktree.path;
  return (
    <div className="flex flex-col gap-5">
      <ModalHeading
        eyebrow={destructive ? "Destructive removal" : "Worktree"}
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
              : "checking…"}
          </dd>
        </div>
        <div>
          <dt>Terminals stopped</dt>
          <dd>
            {preview
              ? preview.terminals.map((terminal) => terminal.name).join(", ") || "none"
              : "checking…"}
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
        {busy ? "Removing…" : destructive ? "Remove anyway" : "Remove worktree"}
      </Button>
    </div>
  );
}

function showError(setError: (value: string | null) => void) {
  return (value: unknown) => setError(value instanceof Error ? value.message : String(value));
}
