import type { Page } from '@playwright/test'
import type { ProjectRecord } from '@treeport/shared'

export async function createTerminalMock(page: Page, state: ProjectRecord) {
  let fileUploadRequests = 0
  let terminalCreations = 0
  let terminalDeletions = 0
  let terminalCreateGate: Promise<void> | null = null
  let releaseTerminalCreate: (() => void) | null = null
  let failTerminalCreate = false
  let failTerminalCreateWithGateway = false
  let failTerminalCreateWithNetwork = false
  let terminalDeleteGate: Promise<void> | null = null
  let releaseTerminalDelete: (() => void) | null = null
  let failTerminalDelete = false

  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (
      pathname === '/api/worktrees/wt_topic/terminals/order' &&
      route.request().method() === 'PUT'
    ) {
      const body: { itemIds: string[] } = route.request().postDataJSON()
      const worktree = state.worktrees.find(
        (candidate) => candidate.id === 'wt_topic'
      )!
      const terminalsById = new Map(
        worktree.terminals.map((terminal) => [terminal.id, terminal])
      )
      worktree.terminals = body.itemIds.map((terminalId) =>
        terminalsById.get(terminalId)!
      )
      await route.fulfill({ json: { ok: true } })
      return
    }

    if (
      pathname === '/api/worktrees/wt_topic/terminals' &&
      route.request().method() === 'POST'
    ) {
      const body: { name: string; argv?: string[] } = route
        .request()
        .postDataJSON()
      terminalCreations += 1
      const creationNumber = terminalCreations
      if (terminalCreateGate) {
        await terminalCreateGate
      }

      terminalCreateGate = null
      releaseTerminalCreate = null
      if (failTerminalCreate) {
        failTerminalCreate = false
        await route.fulfill({
          status: 500,
          json: {
            error: {
              code: 'TERMINAL_CREATE_FAILED',
              message: 'Terminal could not be created',
              details: { requestId: 'request_terminal_create' }
            }
          }
        })
        return
      }

      if (failTerminalCreateWithGateway) {
        failTerminalCreateWithGateway = false
        await route.fulfill({
          status: 502,
          contentType: 'text/html',
          body: '<html><body>PRIVATE_PROXY_DIAGNOSTIC</body></html>'
        })
        return
      }

      if (failTerminalCreateWithNetwork) {
        failTerminalCreateWithNetwork = false
        await route.abort('connectionrefused')
        return
      }

      const terminal = {
        id: creationNumber === 1 ? 'term_dev' : `term_dev_${creationNumber}`,
        worktreeId: 'wt_topic',
        name: body.name,
        argv:
          body.argv ||
          (body.shellCommand
            ? ['/bin/zsh', '-lc', body.shellCommand]
            : ['/bin/zsh', '-l']),
        shellCommand: body.shellCommand ?? null,
        interactiveShell: !body.argv && !body.shellCommand,
        status: 'running',
        exitCode: null,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01'
      }
      state.worktrees[1]!.terminals.push(terminal)
      await route.fulfill({ status: 201, json: { terminal } })
      return
    }

    if (
      /^\/api\/terminals\/[^/]+\/files$/.test(pathname) &&
      route.request().method() === 'POST'
    ) {
      fileUploadRequests += 1
      const extension =
        route.request().headers()['x-treeport-file-extension'] || 'bin'
      await route.fulfill({
        status: 201,
        json: {
          file: {
            path: `/tmp/treeport-upload-${fileUploadRequests}.${extension}`
          }
        }
      })
      return
    }

    if (
      pathname.startsWith('/api/terminals/') &&
      route.request().method() === 'DELETE'
    ) {
      terminalDeletions += 1
      if (terminalDeleteGate) {
        await terminalDeleteGate
      }

      terminalDeleteGate = null
      releaseTerminalDelete = null
      if (failTerminalDelete) {
        failTerminalDelete = false
        await route.fulfill({
          status: 500,
          json: { error: { message: 'Terminal could not be closed' } }
        })
        return
      }

      const terminalId = pathname.split('/').at(-1)
      for (const worktree of state.worktrees) {
        worktree.terminals = worktree.terminals.filter(
          (terminal) => terminal.id !== terminalId
        )
      }
      await route.fulfill({ json: { ok: true } })
      return
    }

    await route.fallback()
  })

  return {
    fileUploadRequests: () => fileUploadRequests,
    terminalCreations: () => terminalCreations,
    terminalDeletions: () => terminalDeletions,
    delayNextTerminalCreate: () => {
      terminalCreateGate = new Promise<void>((resolve) => {
        releaseTerminalCreate = resolve
      })
      return () => releaseTerminalCreate?.()
    },
    failNextTerminalCreate: () => {
      failTerminalCreate = true
    },
    failNextTerminalCreateWithGateway: () => {
      failTerminalCreateWithGateway = true
    },
    failNextTerminalCreateWithNetwork: () => {
      failTerminalCreateWithNetwork = true
    },
    delayNextTerminalDelete: () => {
      terminalDeleteGate = new Promise<void>((resolve) => {
        releaseTerminalDelete = resolve
      })
      return () => releaseTerminalDelete?.()
    },
    failNextTerminalDelete: () => {
      failTerminalDelete = true
    }
  }
}
