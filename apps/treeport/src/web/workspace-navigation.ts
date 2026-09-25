import type {
  BrowserTab,
  ProjectRecord,
  TerminalRecord,
  WebPanel,
  WorktreeRecord
} from '@treeport/shared'

export const LAST_WORKSPACE_ROUTE_STORAGE_KEY = 'treeport-last-workspace-route'
export const LAST_PROJECT_TERMINAL_STORAGE_PREFIX =
  'treeport-last-project-terminal:'

export function openRequestMatchesTerminal(
  sourceTerminalId: string | null,
  selectedTerminalId: string | null
): boolean {
  return sourceTerminalId !== null && sourceTerminalId === selectedTerminalId
}

export function openRequestMatchesWorkspace(
  sourceTerminalId: string | null,
  sourceTabId: string | null,
  selectedTerminalId: string | null,
  selectedTabId: string | null
): boolean {
  return (
    openRequestMatchesTerminal(sourceTerminalId, selectedTerminalId) ||
    (sourceTabId !== null && sourceTabId === selectedTabId)
  )
}

export type WorkspaceTarget =
  | { kind: 'root'; pathname: '/' }
  | {
      kind: 'project'
      pathname: string
      projectId: string
    }
  | {
      kind: 'worktree'
      pathname: string
      projectId: string
      worktreeId: string
    }
  | {
      kind: 'terminal'
      pathname: string
      projectId: string
      worktreeId: string
      terminalId: string
    }
  | {
      kind: 'tab'
      pathname: string
      projectId: string
      worktreeId: string
      tabId: string
    }

interface WorkspaceSelection {
  project: ProjectRecord | null
  worktree: WorktreeRecord | null
  terminal: TerminalRecord | null
  tab: BrowserTab | WebPanel | null
}

export interface WorkspaceResolution {
  target: WorkspaceTarget
  selection: WorkspaceSelection
  canonical: boolean
}

function segment(value: string): string {
  return encodeURIComponent(value)
}

function projectTarget(projectId: string): WorkspaceTarget {
  return {
    kind: 'project',
    pathname: `/projects/${segment(projectId)}`,
    projectId
  }
}

export function worktreeTarget(
  projectId: string,
  worktreeId: string
): WorkspaceTarget {
  return {
    kind: 'worktree',
    pathname: `/projects/${segment(projectId)}/worktrees/${segment(worktreeId)}`,
    projectId,
    worktreeId
  }
}

export function terminalTarget(
  projectId: string,
  worktreeId: string,
  terminalId: string
): WorkspaceTarget {
  return {
    kind: 'terminal',
    pathname: `/projects/${segment(projectId)}/worktrees/${segment(worktreeId)}/terminals/${segment(terminalId)}`,
    projectId,
    worktreeId,
    terminalId
  }
}

export function tabTarget(
  projectId: string,
  worktreeId: string,
  tabId: string
): WorkspaceTarget {
  return {
    kind: 'tab',
    pathname: `/projects/${segment(projectId)}/worktrees/${segment(worktreeId)}/tabs/${segment(tabId)}`,
    projectId,
    worktreeId,
    tabId
  }
}

export function deepestProjectTarget(project: ProjectRecord): WorkspaceTarget {
  const worktree = project.worktrees[0]
  if (!worktree) {
    return projectTarget(project.id)
  }

  const terminal = worktree.terminals[0]
  return terminal
    ? terminalTarget(project.id, worktree.id, terminal.id)
    : worktreeTarget(project.id, worktree.id)
}

export function targetForProject(
  project: ProjectRecord,
  rememberedTerminalId?: string | null
): WorkspaceTarget {
  if (rememberedTerminalId) {
    for (const worktree of project.worktrees) {
      const terminal = worktree.terminals.find(
        (candidate) => candidate.id === rememberedTerminalId
      )
      if (terminal) {
        return terminalTarget(project.id, worktree.id, terminal.id)
      }
    }
  }

  return deepestProjectTarget(project)
}

function deepestWorktreeTarget(
  project: ProjectRecord,
  worktree: WorktreeRecord
): WorkspaceTarget {
  const terminal = worktree.terminals[0]
  return terminal
    ? terminalTarget(project.id, worktree.id, terminal.id)
    : worktreeTarget(project.id, worktree.id)
}

export function targetForTab(
  projects: ProjectRecord[],
  tab: BrowserTab | WebPanel
): WorkspaceTarget | null {
  for (const project of projects) {
    const worktree = project.worktrees.find(
      (candidate) => candidate.id === tab.worktreeId
    )
    if (
      worktree?.tabs.some(
        (candidate) => candidate.kind !== 'terminal' && candidate.id === tab.id
      )
    ) {
      return tabTarget(project.id, worktree.id, tab.id)
    }
  }

  return null
}

export function targetForTerminal(
  projects: ProjectRecord[],
  terminal: TerminalRecord
): WorkspaceTarget | null {
  for (const project of projects) {
    const worktree = project.worktrees.find(
      (candidate) => candidate.id === terminal.worktreeId
    )
    if (worktree?.terminals.some((candidate) => candidate.id === terminal.id)) {
      return terminalTarget(project.id, worktree.id, terminal.id)
    }
  }

  return null
}

export function targetForWorktree(
  projects: ProjectRecord[],
  worktree: WorktreeRecord,
  currentTerminalId?: string | null
): WorkspaceTarget | null {
  const project = projects.find(
    (candidate) =>
      candidate.id === worktree.projectId &&
      candidate.worktrees.some(
        (candidateWorktree) => candidateWorktree.id === worktree.id
      )
  )
  if (!project) {
    return null
  }

  const terminal =
    worktree.terminals.find(
      (candidate) => candidate.id === currentTerminalId
    ) ?? worktree.terminals[0]
  return terminal
    ? terminalTarget(project.id, worktree.id, terminal.id)
    : worktreeTarget(project.id, worktree.id)
}

function selectionForTarget(
  projects: ProjectRecord[],
  target: WorkspaceTarget
): WorkspaceSelection {
  if (target.kind === 'root') {
    return { project: null, worktree: null, terminal: null, tab: null }
  }

  const project =
    projects.find((candidate) => candidate.id === target.projectId) ?? null
  if (!project || target.kind === 'project') {
    return { project, worktree: null, terminal: null, tab: null }
  }

  const worktree =
    project.worktrees.find((candidate) => candidate.id === target.worktreeId) ??
    null
  if (!worktree || target.kind === 'worktree') {
    return { project, worktree, terminal: null, tab: null }
  }

  if (target.kind === 'tab') {
    const tab =
      worktree.tabs.find(
        (candidate): candidate is BrowserTab | WebPanel =>
          candidate.kind !== 'terminal' && candidate.id === target.tabId
      ) ?? null
    return { project, worktree, terminal: null, tab }
  }

  const terminal =
    worktree.terminals.find(
      (candidate) => candidate.id === target.terminalId
    ) ?? null
  return { project, worktree, terminal, tab: null }
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function requestedTarget(pathname: string): WorkspaceTarget | null {
  if (pathname === '/') {
    return { kind: 'root', pathname: '/' }
  }

  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] !== 'projects') {
    return null
  }

  const projectId = parts[1] ? decode(parts[1]) : null
  if (!projectId) {
    return null
  }

  if (parts.length === 2) {
    return projectTarget(projectId)
  }

  if (parts[2] !== 'worktrees') {
    return null
  }

  const worktreeId = parts[3] ? decode(parts[3]) : null
  if (!worktreeId) {
    return null
  }

  if (parts.length === 4) {
    return worktreeTarget(projectId, worktreeId)
  }

  const descendantId = parts[5] ? decode(parts[5]) : null
  if (!descendantId || parts.length !== 6) {
    return null
  }

  if (parts[4] === 'terminals') {
    return terminalTarget(projectId, worktreeId, descendantId)
  }

  if (parts[4] === 'tabs') {
    return tabTarget(projectId, worktreeId, descendantId)
  }

  return null
}

function fallbackTarget(projects: ProjectRecord[]): WorkspaceTarget {
  return projects[0]
    ? deepestProjectTarget(projects[0])
    : { kind: 'root', pathname: '/' }
}

function resolveTarget(
  projects: ProjectRecord[],
  requested: WorkspaceTarget | null
): WorkspaceTarget {
  if (!requested || requested.kind === 'root') {
    return fallbackTarget(projects)
  }

  const project = projects.find(
    (candidate) => candidate.id === requested.projectId
  )
  if (!project) {
    return fallbackTarget(projects)
  }

  if (requested.kind === 'project') {
    return project.worktrees.length
      ? deepestProjectTarget(project)
      : projectTarget(project.id)
  }

  const worktree = project.worktrees.find(
    (candidate) => candidate.id === requested.worktreeId
  )
  if (!worktree) {
    return project.worktrees[0]
      ? deepestWorktreeTarget(project, project.worktrees[0])
      : projectTarget(project.id)
  }

  if (requested.kind === 'worktree') {
    return deepestWorktreeTarget(project, worktree)
  }

  if (requested.kind === 'tab') {
    const tab = worktree.tabs.find(
      (candidate) =>
        candidate.kind !== 'terminal' && candidate.id === requested.tabId
    )
    return tab
      ? tabTarget(project.id, worktree.id, tab.id)
      : deepestWorktreeTarget(project, worktree)
  }

  const terminal = worktree.terminals.find(
    (candidate) => candidate.id === requested.terminalId
  )
  if (!terminal) {
    return deepestWorktreeTarget(project, worktree)
  }

  return terminalTarget(project.id, worktree.id, terminal.id)
}

export function resolveWorkspaceRoute(
  projects: ProjectRecord[],
  pathname: string,
  rootResumePath?: string | null
): WorkspaceResolution {
  const requested = requestedTarget(pathname)
  let target: WorkspaceTarget

  if (requested?.kind === 'root' && projects.length && rootResumePath) {
    const resumeTarget = requestedTarget(rootResumePath)
    const resumeProjectIsValid =
      resumeTarget?.kind !== 'root' &&
      projects.some((project) => project.id === resumeTarget?.projectId)
    target = resumeProjectIsValid
      ? resolveTarget(projects, resumeTarget)
      : fallbackTarget(projects)
  } else {
    target = resolveTarget(projects, requested)
  }

  return {
    target,
    selection: selectionForTarget(projects, target),
    canonical: target.pathname === pathname
  }
}
