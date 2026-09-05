import type { Page } from '@playwright/test'
import type { RecentProjectRecord } from '@treeport/shared'
import { project } from './project'
import type { MockAppOptions } from './types'

export async function createProjectMock(page: Page, options: MockAppOptions) {
  const state = structuredClone(project)
  const secondState = structuredClone(project)
  secondState.id = 'proj_2'
  secondState.name = 'another-project'
  secondState.rootPath = '/another'
  secondState.repositoryPath = '/another'
  secondState.mainWorktreePath = '/another'
  for (const worktree of secondState.worktrees) {
    worktree.id = `second_${worktree.id}`
    worktree.projectId = secondState.id
    worktree.name = `another ${worktree.name}`
    worktree.path = worktree.path.replace('/repo', '/another')
    for (const terminal of worktree.terminals) {
      terminal.id = `second_${terminal.id}`
      terminal.worktreeId = worktree.id
    }
  }
  const openProjects = [
    state,
    ...(options.includeSecondProject ? [secondState] : [])
  ]
  const recentProjects: RecentProjectRecord[] = []
  let projectRequests = 0
  let nextProjectsGate: Promise<void> | null = null
  let releaseNextProjects: (() => void) | null = null

  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (
      pathname === '/api/projects/recent' &&
      route.request().method() === 'GET'
    ) {
      await route.fulfill({ json: { projects: recentProjects } })
      return
    }

    if (pathname === '/api/projects' && route.request().method() === 'GET') {
      projectRequests += 1
      if (nextProjectsGate) {
        const gate = nextProjectsGate
        nextProjectsGate = null
        await gate
      }

      await route.fulfill({ json: { projects: openProjects } })
      return
    }

    if (
      pathname === '/api/projects/proj_1/close' &&
      route.request().method() === 'POST'
    ) {
      const openIndex = openProjects.findIndex(
        (candidate) => candidate.id === state.id
      )
      if (openIndex >= 0) {
        openProjects.splice(openIndex, 1)
        recentProjects.push({
          id: state.id,
          name: state.name,
          kind: state.kind,
          rootPath: state.rootPath,
          repositoryPath: state.repositoryPath,
          lastOpenedAt: state.updatedAt
        })
      }

      await route.fulfill({ json: { ok: true } })
      return
    }

    await route.fallback()
  })

  return {
    state,
    projectRequests: () => projectRequests,
    delayNextProjects: () => {
      nextProjectsGate = new Promise<void>((resolve) => {
        releaseNextProjects = resolve
      })
      return () => releaseNextProjects?.()
    }
  }
}
