import type { ProjectRecord, TerminalRecord } from '@treeport/shared'

/** Applies an authoritative terminal record without duplicating event/response races. */
export function upsertProjectTerminal(
  projects: ProjectRecord[] | undefined,
  worktreeId: string,
  terminal: TerminalRecord
) {
  let found = false
  const updated = projects?.map((project) => {
    let projectChanged = false
    const worktrees = project.worktrees.map((worktree) => {
      if (worktree.id !== worktreeId) {
        return worktree
      }

      found = true
      const existingIndex = worktree.terminals.findIndex(
        (candidate) => candidate.id === terminal.id
      )
      const terminals = [...worktree.terminals]
      if (existingIndex === -1) {
        terminals.push(terminal)
      } else {
        terminals[existingIndex] = terminal
      }

      projectChanged = true
      return { ...worktree, terminals }
    })

    return projectChanged ? { ...project, worktrees } : project
  })

  return { projects: updated, found }
}

/** Removes an authoritative terminal record while tolerating repeated events. */
export function removeProjectTerminal(
  projects: ProjectRecord[] | undefined,
  worktreeId: string,
  terminalId: string
) {
  let worktreeFound = false
  let removed = false
  const updated = projects?.map((project) => {
    let projectChanged = false
    const worktrees = project.worktrees.map((worktree) => {
      if (worktree.id !== worktreeId) {
        return worktree
      }

      worktreeFound = true
      if (!worktree.terminals.some((terminal) => terminal.id === terminalId)) {
        return worktree
      }

      removed = true
      projectChanged = true
      return {
        ...worktree,
        terminals: worktree.terminals.filter(
          (terminal) => terminal.id !== terminalId
        )
      }
    })
    return projectChanged ? { ...project, worktrees } : project
  })

  return {
    projects: removed ? updated : projects,
    worktreeFound
  }
}
