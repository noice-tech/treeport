import type { Page } from '@playwright/test'
import type { RecentProjectRecord } from '@treeport/shared'
import { project } from './project'
import type { MockAppOptions } from './types'

export async function createProjectMock(page: Page, options: MockAppOptions) {
  const state = structuredClone(project)
  if (options.worktreeFree) {
    state.worktrees = []
  }

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
  const folderState = structuredClone(project)
  folderState.id = 'proj_folder'
  folderState.name = 'Projects'
  folderState.kind = 'folder'
  folderState.rootPath = '/home/test/Projects'
  folderState.repositoryPath = folderState.rootPath
  folderState.mainWorktreePath = folderState.rootPath
  folderState.defaultBranch = ''
  folderState.worktrees = [folderState.worktrees[0]!]
  folderState.worktrees[0]!.id = 'wt_folder'
  folderState.worktrees[0]!.projectId = folderState.id
  folderState.worktrees[0]!.name = 'Projects'
  folderState.worktrees[0]!.path = folderState.rootPath
  folderState.worktrees[0]!.kind = 'folder'
  folderState.worktrees[0]!.head = ''
  folderState.worktrees[0]!.branch = null
  folderState.worktrees[0]!.dirty = null
  folderState.worktrees[0]!.terminals[0]!.id = 'term_folder'
  folderState.worktrees[0]!.terminals[0]!.worktreeId = 'wt_folder'

  const openProjects = options.startClosed
    ? []
    : [state, ...(options.includeSecondProject ? [secondState] : [])]
  const recentProjects: RecentProjectRecord[] = options.startClosed
    ? [
        {
          id: state.id,
          name: state.name,
          kind: state.kind,
          rootPath: state.rootPath,
          repositoryPath: state.repositoryPath,
          lastOpenedAt: state.updatedAt
        }
      ]
    : []
  let projectRequests = 0
  let failDirectoryBrowse = false
  const registeredProjectPaths: string[] = []
  let releaseProjects: (() => void) | null = null
  const projectsGate = options.delayProjects
    ? new Promise<void>((resolve) => {
        releaseProjects = resolve
      })
    : null
  let nextProjectsGate: Promise<void> | null = null
  let releaseNextProjects: (() => void) | null = null
  let closeRequests = 0
  let failClose = false
  let dismissRecentProjectRequests = 0

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const pathname = url.pathname
    if (
      pathname === '/api/projects/recent' &&
      route.request().method() === 'GET'
    ) {
      await route.fulfill({ json: { projects: recentProjects } })
      return
    }

    if (
      pathname === '/api/filesystem/directories' &&
      route.request().method() === 'GET'
    ) {
      if (failDirectoryBrowse) {
        failDirectoryBrowse = false
        await route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'DIRECTORY_UNREADABLE',
              message: 'That folder cannot be read on the Treeport server'
            }
          }
        })
        return
      }

      const input = url.searchParams.get('input') ?? '~'
      const showHidden = url.searchParams.get('hidden') === 'true'
      const exactPaths = new Map([
        ['~', ['Projects']],
        ['/home/test', ['Projects']],
        ['/home/test/Projects', ['example']],
        ['/repo', ['src']]
      ])
      const exact = exactPaths.has(input)
      const partialProjects = input === '/home/test/Pro'
      const directoryPath = partialProjects
        ? '/home/test'
        : input === '~'
          ? '/home/test'
          : input
      const entryNames = partialProjects
        ? ['Projects']
        : [...(exactPaths.get(input) ?? []), ...(showHidden ? ['.hidden'] : [])]
      await route.fulfill({
        json: {
          input,
          exact,
          directory: {
            path: directoryPath,
            parentPath:
              directoryPath === '/'
                ? null
                : directoryPath.slice(0, directoryPath.lastIndexOf('/')) || '/',
            homePath: '/home/test',
            rootPath: '/',
            breadcrumbs:
              directoryPath === '/'
                ? [{ name: '/', path: '/' }]
                : [
                    { name: '/', path: '/' },
                    ...directoryPath
                      .split('/')
                      .filter(Boolean)
                      .map((name, index, segments) => ({
                        name,
                        path: `/${segments.slice(0, index + 1).join('/')}`
                      }))
                  ],
            entries: entryNames.map((name) => ({
              name,
              path: `${directoryPath === '/' ? '' : directoryPath}/${name}`
            })),
            truncated: false
          },
          project: exact
            ? input === '/repo'
              ? { state: 'valid', kind: 'repository', path: '/repo' }
              : { state: 'valid', kind: 'folder', path: directoryPath }
            : {
                state: 'incomplete',
                message: 'Choose a matching folder to continue.'
              },
          repository:
            input === '/repo'
              ? { state: 'valid', repositoryPath: '/repo' }
              : exact
                ? {
                    state: 'not-repository',
                    message: 'This folder is not inside a Git repository.'
                  }
                : {
                    state: 'incomplete',
                    message: 'Choose a matching folder to continue.'
                  }
        }
      })
      return
    }

    if (pathname === '/api/projects' && route.request().method() === 'GET') {
      projectRequests += 1
      if (projectsGate) {
        await projectsGate
      }

      if (nextProjectsGate) {
        const gate = nextProjectsGate
        nextProjectsGate = null
        await gate
      }

      await route.fulfill({ json: { projects: openProjects } })
      return
    }

    if (pathname === '/api/projects' && route.request().method() === 'POST') {
      const body: { path: string } = route.request().postDataJSON()
      registeredProjectPaths.push(body.path)
      const registered =
        body.path === folderState.rootPath ? folderState : state
      if (!openProjects.some((candidate) => candidate.id === registered.id)) {
        openProjects.push(registered)
      }

      const recentIndex = recentProjects.findIndex(
        (candidate) => candidate.id === registered.id
      )
      if (recentIndex >= 0) {
        recentProjects.splice(recentIndex, 1)
      }

      await route.fulfill({ status: 201, json: { project: registered } })
      return
    }

    if (
      pathname === '/api/projects/proj_1/open' &&
      route.request().method() === 'POST'
    ) {
      if (!openProjects.some((candidate) => candidate.id === state.id)) {
        openProjects.push(state)
      }

      const recentIndex = recentProjects.findIndex(
        (candidate) => candidate.id === state.id
      )
      if (recentIndex >= 0) {
        recentProjects.splice(recentIndex, 1)
      }

      await route.fulfill({ json: { project: state } })
      return
    }

    if (
      pathname === '/api/projects/proj_1/close' &&
      route.request().method() === 'POST'
    ) {
      closeRequests += 1
      if (failClose) {
        failClose = false
        await route.fulfill({
          status: 500,
          json: {
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Unexpected server error'
            }
          }
        })
        return
      }

      const openIndex = openProjects.findIndex(
        (candidate) => candidate.id === state.id
      )
      if (openIndex >= 0) {
        openProjects.splice(openIndex, 1)
      }

      if (!recentProjects.some((candidate) => candidate.id === state.id)) {
        recentProjects.push({
          id: state.id,
          name: state.name,
          kind: state.kind,
          rootPath: state.rootPath,
          repositoryPath: state.repositoryPath,
          lastOpenedAt: state.updatedAt
        })
      }

      for (const worktree of state.worktrees) {
        worktree.terminals = []
      }
      await route.fulfill({ json: { ok: true } })
      return
    }

    if (
      pathname === '/api/projects/proj_1/recent' &&
      route.request().method() === 'DELETE'
    ) {
      dismissRecentProjectRequests += 1
      const recentIndex = recentProjects.findIndex(
        (candidate) => candidate.id === state.id
      )
      if (recentIndex >= 0) {
        recentProjects.splice(recentIndex, 1)
      }

      await route.fulfill({ json: { ok: true } })
      return
    }

    if (
      pathname === '/api/projects/proj_1' &&
      route.request().method() === 'PATCH'
    ) {
      const body: { color: typeof state.color } = route.request().postDataJSON()
      state.color = body.color
      await route.fulfill({ json: { project: state } })
      return
    }

    await route.fallback()
  })

  return {
    state,
    projectRequests: () => projectRequests,
    registeredProjectPaths: () => [...registeredProjectPaths],
    failNextDirectoryBrowse: () => {
      failDirectoryBrowse = true
    },
    releaseProjects: () => releaseProjects?.(),
    delayNextProjects: () => {
      nextProjectsGate = new Promise<void>((resolve) => {
        releaseNextProjects = resolve
      })
      return () => releaseNextProjects?.()
    },
    closeRequests: () => closeRequests,
    failNextClose: () => {
      failClose = true
    },
    dismissRecentProjectRequests: () => dismissRecentProjectRequests
  }
}
