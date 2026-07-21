import { expect, test, type Page } from '@playwright/test'
import type { ProjectColor, TerminalRuntimeMetadata } from '@tasktty/shared'

const TERMINAL_SCROLL_EXIT_SEQUENCE = '\u001b[9000~'

const project = {
  id: 'proj_1',
  name: 'example',
  repositoryPath: '/repo',
  mainWorktreePath: '/repo',
  defaultBranch: 'trunk',
  color: null as ProjectColor | null,
  availability: { state: 'available' as const, message: null },
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  worktrees: [
    {
      id: 'wt_main',
      projectId: 'proj_1',
      name: 'main worktree',
      path: '/repo',
      head: 'aaaaaaaa',
      branch: 'trunk',
      detached: false,
      locked: false,
      lockReason: null,
      kind: 'main',
      tmuxSocketName: 'tasktty-wt-main',
      status: 'active',
      cleanupError: null,
      managedWrapperPath: null,
      pr: {
        state: 'no_pr',
        number: null,
        url: null,
        baseBranch: null,
        headBranch: null,
        mergedAt: null,
        refreshedAt: null
      },
      dirty: {
        dirty: false,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicts: 0,
        total: 0
      },
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      terminals: [
        {
          id: 'term_shell',
          worktreeId: 'wt_main',
          name: 'Shell',
          tmuxSessionName: 'tasktty-term-shell',
          argv: ['/bin/zsh', '-l'],
          status: 'running',
          exitCode: null,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01'
        }
      ]
    },
    {
      id: 'wt_topic',
      projectId: 'proj_1',
      name: 'topic',
      path: '/worktrees/topic',
      head: 'bbbbbbbb',
      branch: 'feature/topic',
      detached: false,
      locked: false,
      lockReason: null,
      kind: 'linked',
      tmuxSocketName: 'tasktty-wt-topic',
      status: 'active',
      cleanupError: null,
      managedWrapperPath: null,
      pr: {
        state: 'merged',
        number: 12,
        url: 'https://example.test/pr/12',
        baseBranch: 'trunk',
        headBranch: 'feature/topic',
        mergedAt: '2026-01-02',
        refreshedAt: '2026-01-02'
      },
      dirty: {
        dirty: false,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicts: 0,
        total: 0
      },
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      terminals: [
        {
          id: 'term_pi',
          worktreeId: 'wt_topic',
          name: 'Pi',
          tmuxSessionName: 'tasktty-term-pi',
          argv: ['pi'],
          status: 'running',
          exitCode: null,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01'
        }
      ]
    }
  ]
}

async function mockApp(
  page: Page,
  initialTerminalMetadata: TerminalRuntimeMetadata[] = []
) {
  await page.addInitScript((initialMetadata) => {
    class MockEventSource {
      listeners = new Map<string, Array<(event: { data: string }) => void>>()
      constructor() {
        const scope = window as any
        scope.__eventSource = this
        setTimeout(
          () =>
            this.emit(
              'connected',
              JSON.stringify({
                at: new Date().toISOString(),
                terminalMetadata: initialMetadata
              })
            ),
          0
        )
      }
      addEventListener(
        name: string,
        listener: (event: { data: string }) => void
      ) {
        this.listeners.set(name, [
          ...(this.listeners.get(name) || []),
          listener
        ])
      }
      emit(name: string, data = '{}') {
        this.listeners.get(name)?.forEach((listener) => listener({ data }))
      }
      close() {}
    }
    class MockWebSocket {
      static OPEN = 1
      readyState = 0
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      clientId = ''
      readonly streamId = crypto.randomUUID()
      constructor(public url: string) {
        const scope = window as any
        scope.__controllerClientId ||= 'other'
        scope.__wsInstances = [...(scope.__wsInstances || []), this]
        scope.__lastWs = this
        setTimeout(() => {
          this.readyState = 1
          this.onopen?.()
        }, 10)
      }
      send(data: string) {
        const scope = window as any
        const message = JSON.parse(data)
        scope.__wsSent = [...(scope.__wsSent || []), message]
        if (message.type === 'hello') {
          this.clientId = message.clientId
          const controller = scope.__controllerClientId === this.clientId
          this.onmessage?.({
            data: JSON.stringify({
              version: 1,
              type: 'ready',
              connectionId: crypto.randomUUID(),
              streamId: this.streamId,
              controller,
              reset: 'full',
              heartbeatMs: 15000
            })
          })
          this.onmessage?.({
            data: JSON.stringify({
              version: 1,
              type: 'output',
              streamId: this.streamId,
              sequence: 1,
              data: this.url.includes('term_new')
                ? '[TaskTTY setup] bootstrap\\r\\nSETUP_OUTPUT\\r\\n[TaskTTY setup] bootstrap complete\\r\\nSHELL_READY\\r\\n'
                : 'same persistent terminal session\\r\\n'
            })
          })
          if (!scope.__suppressInitialTitle) {
            this.onmessage?.({
              data: JSON.stringify({
                version: 1,
                type: 'title',
                title: this.url.includes('term_dev')
                  ? 'dev · /worktrees/topic'
                  : 'zsh · /worktrees/topic'
              })
            })
          }
        }

        if (message.type === 'take_control') {
          scope.__controllerClientId = this.clientId
          this.onmessage?.({
            data: JSON.stringify({
              version: 1,
              type: 'control',
              controller: true
            })
          })
        }
      }
      close() {
        this.readyState = 3
        this.onclose?.()
      }
    }
    Object.assign(window, {
      EventSource: MockEventSource,
      WebSocket: MockWebSocket
    })
  }, initialTerminalMetadata)
  const state = structuredClone(project)
  let projectRequests = 0
  let removePreviewRequests = 0
  let removePreviewDelayMs = 0
  let removePreviewOverride: Record<string, unknown> = {}
  let staleRemovePreview: Record<string, unknown> | null = null
  let removeRequests = 0
  const removeRequestBodies: unknown[] = []
  let removeGate: Promise<void> | null = null
  let releaseRemove: (() => void) | null = null
  let createGate: Promise<void> | null = null
  let releaseCreate: (() => void) | null = null
  let failCreate = false
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const pathname = url.pathname
    if (pathname === '/api/projects' && route.request().method() === 'GET') {
      projectRequests += 1
      await route.fulfill({ json: { projects: [state] } })
      return
    }

    if (
      pathname === '/api/projects/proj_1' &&
      route.request().method() === 'PATCH'
    ) {
      const body = route.request().postDataJSON() as {
        color: typeof state.color
      }
      state.color = body.color
      await route.fulfill({ json: { project: state } })
      return
    }

    if (pathname.endsWith('/remove-preview')) {
      removePreviewRequests += 1
      if (removePreviewDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, removePreviewDelayMs)
        )
      }

      const worktree = state.worktrees[1]!
      await route.fulfill({
        json: {
          preview: {
            worktreeId: worktree.id,
            name: worktree.name,
            branch: worktree.branch,
            path: worktree.path,
            head: worktree.head,
            detached: worktree.detached,
            locked: false,
            lockReason: null,
            dirty: worktree.dirty,
            detachedHeadReachable: null,
            forceRequired: false,
            eligible: true,
            reasons: [],
            warnings: [],
            terminals: worktree.terminals.map(({ id, name, status }) => ({
              id,
              name,
              status
            })),
            confirmationToken: 'a'.repeat(64),
            ...removePreviewOverride
          }
        }
      })
      return
    }

    if (pathname.endsWith('/worktree-destination')) {
      const name = (url.searchParams.get('name') ?? '')
        .trim()
        .replace(/\s+/g, '-')
      await route.fulfill({
        json: {
          destination: {
            name,
            path: `/worktrees/${name}/repo`
          }
        }
      })
      return
    }

    if (
      pathname === '/api/projects/proj_1/worktrees' &&
      route.request().method() === 'POST'
    ) {
      const body = route.request().postDataJSON() as {
        name: string
        base: 'default' | 'current'
        sourceWorktreeId?: string
        initialTerminal?: { name: string }
      }
      if (createGate) {
        await createGate
      }

      createGate = null
      releaseCreate = null
      if (failCreate) {
        failCreate = false
        await route.fulfill({
          status: 500,
          json: { error: { code: 'CREATE_FAILED', message: 'create failed' } }
        })
        return
      }

      const canonicalName = body.name.trim().replace(/\s+/g, '-')
      const terminal = {
        id: 'term_new',
        worktreeId: 'wt_new',
        name: body.initialTerminal?.name ?? 'Terminal',
        tmuxSessionName: 'tasktty-term-new',
        argv: ['/bin/zsh', '-l'],
        status: 'running' as const,
        exitCode: null,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01'
      }
      const worktree = {
        ...structuredClone(state.worktrees[1]!),
        id: 'wt_new',
        name: canonicalName,
        path: `/worktrees/${canonicalName}/repo`,
        terminals: [terminal]
      }
      const existingIndex = state.worktrees.findIndex(
        (item) => item.id === worktree.id
      )
      if (existingIndex >= 0) {
        state.worktrees[existingIndex] = worktree
      } else {
        state.worktrees.push(worktree)
      }

      await route.fulfill({
        status: 201,
        json: { worktree, terminal, terminalError: null, setupError: null }
      })
      return
    }

    if (
      pathname === '/api/worktrees/wt_topic/terminals' &&
      route.request().method() === 'POST'
    ) {
      const body = route.request().postDataJSON() as {
        name: string
        argv?: string[]
      }
      const terminal = {
        id: 'term_dev',
        worktreeId: 'wt_topic',
        name: body.name,
        tmuxSessionName: 'tasktty-term-dev',
        argv: body.argv || ['/bin/zsh', '-l'],
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
      pathname.startsWith('/api/terminals/') &&
      route.request().method() === 'DELETE'
    ) {
      const terminalId = pathname.split('/').at(-1)
      for (const worktree of state.worktrees) {
        worktree.terminals = worktree.terminals.filter(
          (terminal) => terminal.id !== terminalId
        )
      }
      await route.fulfill({ json: { ok: true } })
      return
    }

    if (pathname.endsWith('/remove')) {
      removeRequests += 1
      removeRequestBodies.push(route.request().postDataJSON())
      if (staleRemovePreview) {
        removePreviewOverride = staleRemovePreview
        staleRemovePreview = null
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'REMOVE_PREVIEW_STALE',
              message:
                'The worktree changed after the removal preview; review it again'
            }
          }
        })
        return
      }

      if (removeGate) {
        await removeGate
      }

      removeGate = null
      releaseRemove = null
      state.worktrees[1]!.status = 'cleaning'
      await route.fulfill({
        status: 202,
        json: { operation: { id: 'op_1', status: 'pending' } }
      })
      return
    }

    if (pathname.endsWith('/pr/refresh')) {
      await route.fulfill({ json: { pr: state.worktrees[1]!.pr } })
      return
    }

    await route.fulfill({ json: { ok: true } })
  })
  await page.goto('/')
  return {
    state,
    projectRequests: () => projectRequests,
    removePreviewRequests: () => removePreviewRequests,
    setRemovePreview: (value: Record<string, unknown>) => {
      removePreviewOverride = value
    },
    setRemovePreviewDelay: (value: number) => {
      removePreviewDelayMs = value
    },
    removeRequests: () => removeRequests,
    removeRequestBodies: () => [...removeRequestBodies],
    staleNextRemoveWithPreview: (value: Record<string, unknown>) => {
      staleRemovePreview = value
    },
    delayNextRemove: () => {
      removeGate = new Promise<void>((resolve) => {
        releaseRemove = resolve
      })
      return () => releaseRemove?.()
    },
    delayNextCreate: () => {
      createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve
      })
      return () => releaseCreate?.()
    },
    failNextCreate: () => {
      failCreate = true
    }
  }
}

test.describe('desktop worktree terminal UI', () => {
  test.skip(({ isMobile }) => Boolean(isMobile))

  test('navigates projects, worktrees, and persistent terminal output', async ({
    page
  }) => {
    await mockApp(page)
    await expect(page.getByText('example')).toBeVisible()
    await expect(page.getByText('topic', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'example', exact: true }).click()
    await expect(page.getByText('topic', { exact: true })).toBeHidden()
    await page.getByRole('button', { name: 'example', exact: true }).click()
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await expect(page.locator('.xterm')).toBeVisible()
    await expect(page.locator('.xterm-rows')).toContainText(
      'same persistent terminal session'
    )
    await expect(
      page.getByRole('tab', { name: /zsh · \/worktrees\/topic/ })
    ).toHaveAttribute('data-state', 'active')
    await expect(
      page
        .getByRole('button', {
          name: 'zsh · /worktrees/topic, running',
          exact: true
        })
        .last()
    ).toBeVisible()
    await expect(
      page.locator('select[name="terminal-selector"] option:checked')
    ).toHaveText('zsh · /worktrees/topic')
    await expect(page.locator('.pr-badge')).toHaveCount(0)
  })

  test('remembers collapsed projects after a refresh', async ({ page }) => {
    await mockApp(page)
    const project = page.getByRole('button', { name: 'example', exact: true })
    const worktree = page.getByText('topic', { exact: true })

    await project.click()
    await expect(worktree).toBeHidden()
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('tasktty-collapsed-projects'))
      )
      .toBe('proj_1')
    await page.reload()
    await expect(worktree).toBeHidden()

    await project.click()
    await expect(worktree).toBeVisible()
    await page.reload()
    await expect(worktree).toBeVisible()
  })

  test('assigns a project color to its chevron and subtree rail', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    const projectTree = page
      .locator('.project-tree')
      .filter({ hasText: 'example' })
    await projectTree.locator('.project-row').hover()
    const trigger = page.getByRole('button', {
      name: 'Change color for example'
    })
    await trigger.click()
    await page.mouse.move(700, 700)
    await expect(trigger).toHaveCSS('opacity', '1')
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()

    await trigger.click()
    await page.getByRole('button', { name: 'Violet', exact: true }).click()

    await expect.poll(() => mocked.state.color).toBe('violet')
    await expect(
      page.getByRole('button', { name: 'example', exact: true }).locator('svg')
    ).toHaveClass(/fill-violet-400/)
    await expect(projectTree.locator('ul').first()).toHaveClass(
      /border-violet-400\/50/
    )
  })

  test('opens OSC 8 links in a new tab on Cmd-click', async ({ page }) => {
    await mockApp(page)
    await page.evaluate(() => {
      ;(window as any).__openedTerminalLink = null
      window.open = (...args) => {
        ;(window as any).__openedTerminalLink = args
        return null
      }
    })
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await page.evaluate(() => {
      const socket = (window as any).__wsInstances.find((item: any) =>
        item.url.includes('term_pi')
      )
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 2,
          data: '\x1b]8;;https://example.test/pr/123\x1b\\#123 ↗\x1b]8;;\x1b\\\r\n'
        })
      })
    })

    const linkedText = page
      .locator('.xterm-rows span')
      .filter({ hasText: '#123' })
      .last()
    await expect(linkedText).toBeVisible()
    await linkedText.click({ modifiers: ['Meta'] })
    await expect
      .poll(() => page.evaluate(() => (window as any).__openedTerminalLink))
      .toEqual(['https://example.test/pr/123', '_blank', 'noopener,noreferrer'])
  })

  test('synchronizes fallback, runtime, and cleared titles across every desktop consumer', async ({
    page
  }) => {
    await mockApp(page)
    await page.evaluate(() => ((window as any).__suppressInitialTitle = true))
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()

    await expect(page.getByRole('tab', { name: 'Pi, running' })).toBeVisible()
    await expect(page.locator('main[aria-label="Pi terminal"]')).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Pi, running', exact: true }).last()
    ).toBeVisible()

    await page.evaluate(() => {
      const socket = (window as any).__wsInstances.find((item: any) =>
        item.url.includes('term_pi')
      )
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'title',
          title: 'runtime · /repo'
        })
      })
    })
    await expect(
      page.getByRole('tab', { name: 'runtime · /repo, running' })
    ).toBeVisible()
    await expect(
      page.locator('main[aria-label="runtime · /repo terminal"]')
    ).toBeVisible()
    await expect(
      page
        .getByRole('button', { name: 'runtime · /repo, running', exact: true })
        .last()
    ).toBeVisible()
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('runtime · /repo')
      await dialog.dismiss()
    })
    await page.getByRole('button', { name: 'Close runtime · /repo' }).click()

    await page.evaluate(() => {
      const socket = (window as any).__wsInstances.find((item: any) =>
        item.url.includes('term_pi')
      )
      socket.onmessage?.({
        data: JSON.stringify({ version: 1, type: 'title', title: '' })
      })
    })
    await expect(page.getByRole('tab', { name: 'Pi, running' })).toBeVisible()
    await expect(page.locator('main[aria-label="Pi terminal"]')).toBeVisible()
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('Pi')
      await dialog.dismiss()
    })
    await page.getByRole('button', { name: 'Close Pi' }).click()
  })

  test('loads title and progress on first render before a terminal is selected', async ({
    page
  }) => {
    await mockApp(page, [
      {
        terminalId: 'term_pi',
        title: 'background · /repo',
        progress: { state: 'normal', value: 42 }
      }
    ])

    const background = page.getByRole('button', {
      name: /background · \/repo.*42% complete/
    })
    await expect(background).toBeVisible()
    await expect(background.locator('svg')).toHaveClass(/animate-spin/)
    expect(
      await page.evaluate(() =>
        ((window as any).__wsInstances || []).some((socket: { url: string }) =>
          socket.url.includes('term_pi')
        )
      )
    ).toBe(false)
  })

  test('traps modal focus, closes on Escape, and restores its trigger', async ({
    page
  }) => {
    await mockApp(page)
    const trigger = page.getByRole('button', { name: 'New worktree' })
    await trigger.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Worktree name').fill('focus-test')
    const submit = dialog.getByRole('button', { name: 'Create worktree' })
    await expect(submit).toBeEnabled()
    await submit.focus()
    await submit.press('Tab')
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test('refreshes the metadata snapshot whenever SSE reconnects', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    await expect(page.getByText('example')).toBeVisible()
    await expect.poll(() => mocked.projectRequests()).toBeGreaterThan(1)
    await page.waitForTimeout(150)
    const before = mocked.projectRequests()
    await page.evaluate(() => (window as any).__eventSource.emit('connected'))
    await expect.poll(() => mocked.projectRequests()).toBeGreaterThan(before)
  })

  test('reconnects and allows a viewer to take control without relaunching', async ({
    page
  }) => {
    await mockApp(page)
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Take control' })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Take control' }).click()
    await expect(
      page.getByRole('button', { name: 'Take control' })
    ).toHaveCount(0)
    const before = await page.evaluate(
      () => (window as any).__wsInstances.length
    )
    await page.evaluate(() => (window as any).__lastWs.onclose())
    await expect
      .poll(() => page.evaluate(() => (window as any).__wsInstances.length))
      .toBeGreaterThan(before)
  })

  test('does not automatically retry a fatal terminal error', async ({
    page
  }) => {
    await mockApp(page)
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Take control' })
    ).toBeVisible()
    await page.evaluate(() => {
      const socket = (window as any).__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'error',
          code: 'ATTACH_FAILED',
          message: 'Terminal unavailable',
          retryable: false
        })
      })
      socket.close()
    })
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
    const before = await page.evaluate(
      () => (window as any).__wsInstances.length
    )
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await page.waitForTimeout(750)
    expect(
      await page.evaluate(() => (window as any).__wsInstances.length)
    ).toBe(before)
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect
      .poll(() => page.evaluate(() => (window as any).__wsInstances.length))
      .toBeGreaterThan(before)
  })

  test('surfaces BEL attention from a retained background terminal', async ({
    page
  }) => {
    await mockApp(page)
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await expect(
      page.getByRole('tab', { name: /zsh · \/worktrees\/topic/ })
    ).toBeVisible()
    await page.getByRole('button', { name: 'New terminal' }).click()
    await expect(
      page.getByRole('tab', { name: /dev · \/worktrees\/topic/ })
    ).toHaveAttribute('data-state', 'active')
    await page.evaluate(() => {
      const socket = (window as any).__wsInstances.find((item: any) =>
        item.url.includes('term_pi')
      )
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 2,
          data: '\u0007'
        })
      })
    })
    const piTab = page.getByRole('tab', {
      name: /zsh · \/worktrees\/topic.*bell/
    })
    const piTreeRow = page.getByRole('button', {
      name: /zsh · \/worktrees\/topic.*bell/
    })
    await expect(piTab).toBeVisible()
    await expect(piTreeRow).toBeVisible()
    await expect(piTreeRow.locator('.status-dot')).toHaveClass(/bg-amber-300/)
    await piTreeRow.click()
    await expect(
      page.getByRole('tab', { name: /zsh · \/worktrees\/topic.*bell/ })
    ).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: /zsh · \/worktrees\/topic.*bell/ })
    ).toHaveCount(0)
  })

  test('creates and selects a login shell terminal without prompting', async ({
    page
  }) => {
    await mockApp(page)
    await page.locator('.worktree-row').filter({ hasText: 'topic' }).click()
    await expect(
      page.getByRole('button', { name: 'Terminal', exact: true })
    ).toHaveCount(0)
    const requestPromise = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/worktrees/wt_topic/terminals'
    )
    await page.getByRole('button', { name: 'New terminal' }).click()
    const request = await requestPromise
    expect(request.postDataJSON()).toEqual({ name: 'Terminal' })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.terminal-row.selected')).toBeVisible()

    await expect(
      page.getByRole('tab', { name: /^dev · \/worktrees\/topic,/ })
    ).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    const socketsBeforeSwitch = await page.evaluate(
      () => (window as any).__wsInstances.length
    )
    await page.getByRole('tab', { name: /^zsh · \/worktrees\/topic,/ }).click()
    await expect
      .poll(() => page.evaluate(() => (window as any).__wsInstances.length))
      .toBe(socketsBeforeSwitch)
    await expect(
      page.getByRole('tab', { name: /^dev · \/worktrees\/topic,/ })
    ).toBeVisible()

    const terminalId = 'term_dev'
    page.once('dialog', (dialog) => dialog.accept())
    const closeRequest = page.waitForRequest(
      (request) =>
        request.method() === 'DELETE' &&
        new URL(request.url()).pathname === `/api/terminals/${terminalId}`
    )
    await page
      .getByRole('button', { name: /^Close dev · \/worktrees\/topic$/ })
      .click()
    await closeRequest
    await expect(
      page.getByRole('tab', { name: /^dev · \/worktrees\/topic,/ })
    ).toHaveCount(0)
  })

  test('preserves modified terminal keys used by macOS and Pi', async ({
    page
  }) => {
    await mockApp(page)
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await page.getByRole('button', { name: 'Take control' }).click()
    await page.locator('.xterm-helper-textarea').focus()
    await page.evaluate(() => {
      ;(window as any).__wsSent = []
    })

    await page.keyboard.press('Shift+Enter')
    await page.keyboard.press('Meta+ArrowLeft')
    await page.keyboard.press('Meta+ArrowRight')

    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__wsSent
            .filter((message: any) => message.type === 'input')
            .map((message: any) => message.data)
        )
      )
      .toEqual(['\u001b[13;2u', '\u001b[H', '\u001b[F'])
  })

  test('keeps plain dragged text selected while tmux mouse reporting is active', async ({
    page
  }) => {
    await mockApp(page)
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await page.getByRole('button', { name: 'Take control' }).click()
    await page.evaluate(() => {
      const socket = (window as any).__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 2,
          data: '\u001b[?1000h\u001b[?1006h'
        })
      })
      ;(window as any).__wsSent = []
    })
    await expect(page.locator('.xterm.enable-mouse-events')).toBeVisible()

    const screen = page.locator('.xterm-screen')
    const bounds = await screen.boundingBox()
    expect(bounds).not.toBeNull()
    await page.mouse.move(bounds!.x + 8, bounds!.y + 8)
    await page.mouse.down()
    await page.mouse.move(bounds!.x + 160, bounds!.y + 8, { steps: 5 })
    await page.mouse.up()

    const copied = await page
      .locator('.xterm-helper-textarea')
      .evaluate((textarea) => {
        const clipboard = new DataTransfer()
        textarea.dispatchEvent(
          new ClipboardEvent('copy', {
            bubbles: true,
            cancelable: true,
            clipboardData: clipboard
          })
        )
        return clipboard.getData('text/plain')
      })
    expect(copied.length).toBeGreaterThan(0)
    const sent = await page.evaluate(() => (window as any).__wsSent)
    expect(
      sent.some((message: any) => String(message.data).includes('\u001b[<'))
    ).toBe(false)
  })

  test('forwards application wheel events while hiding the inactive cursor', async ({
    page
  }) => {
    await mockApp(page)
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await page.getByRole('button', { name: 'Take control' }).click()
    await page.locator('.xterm-helper-textarea').focus()
    await page.evaluate(() => {
      const socket = (window as any).__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 2,
          data: '\u001b[?1000h\u001b[?1006h'
        })
      })
      ;(window as any).__wsSent = []
    })
    await page.locator('.xterm-screen').dispatchEvent('wheel', { deltaY: -120 })
    const terminalHost = page.locator('.terminal-session-host')
    await expect(terminalHost).toHaveClass(/terminal-scrolling/)
    await expect(page.locator('.xterm-cursor')).toHaveCSS(
      'visibility',
      'hidden'
    )
    await expect
      .poll(() => page.evaluate(() => (window as any).__wsSent))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: expect.stringMatching(/input|binary/)
          })
        ])
      )
    const sent = await page.evaluate(() => (window as any).__wsSent)
    expect(sent.some((message: any) => message.data === '\u001b[A')).toBe(false)
    expect(
      sent.some((message: any) => String(message.data).includes('\u001b[<'))
    ).toBe(true)

    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.press('q')
    await expect(terminalHost).not.toHaveClass(/terminal-scrolling/)
    await expect(page.locator('.xterm-cursor')).not.toHaveCSS(
      'visibility',
      'hidden'
    )
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).__wsSent
              .filter((message: any) => message.type === 'input')
              .at(-1)?.data
        )
      )
      .toBe(`${TERMINAL_SCROLL_EXIT_SEQUENCE}q`)
  })

  test('resizes the sidebar with an accessible panel handle', async ({
    page
  }) => {
    await mockApp(page)
    const separator = page.getByRole('separator', { name: 'Resize sidebar' })
    await expect(separator).toHaveAttribute('aria-valuenow', '272')
    await separator.press('ArrowRight')
    await expect(separator).toHaveAttribute('aria-valuenow', '288')
  })

  test('uses one removal action, live preview state, and places New worktree last', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    await expect(page.getByRole('button', { name: 'Diagnostics' })).toHaveCount(
      0
    )
    await expect(
      page.getByRole('button', { name: /Clean merged/ })
    ).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Finish' })).toHaveCount(0)
    const projectList = page.locator('.project-tree ul').first()
    await expect(projectList.locator(':scope > li').last()).toContainText(
      'New worktree'
    )

    mocked.setRemovePreview({
      branch: null,
      detached: true,
      head: 'cccccccc',
      detachedHeadReachable: false,
      warnings: ['Detached commits may become unreachable after removal'],
      confirmationToken: 'b'.repeat(64)
    })
    await page.locator('.worktree-row').filter({ hasText: 'topic' }).hover()
    await page.getByRole('button', { name: 'Remove topic' }).click()
    await expect(
      page.getByRole('heading', { name: 'Remove worktree' })
    ).toBeVisible()
    await expect(
      page.getByText('/worktrees/topic', { exact: true })
    ).toBeVisible()
    await expect(page.getByText('Detached at cccccccc')).toBeVisible()
    await expect(page.getByText('Pi', { exact: true }).last()).toBeVisible()
    const removeRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname.endsWith('/remove')
    )
    await page.getByRole('button', { name: 'Remove anyway' }).click()
    expect((await removeRequest).postDataJSON()).toEqual({
      confirmationToken: 'b'.repeat(64),
      confirmDestructive: true
    })
  })

  test('removes a clean worktree without a dialog and blocks repeated requests', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    mocked.setRemovePreviewDelay(200)
    const releaseRemove = mocked.delayNextRemove()
    const removeButton = page.getByRole('button', { name: 'Remove topic' })
    await page.locator('.worktree-row').filter({ hasText: 'topic' }).hover()
    await removeButton.evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })

    await expect(page.getByText('Preparing removal…')).toBeVisible()
    await expect(removeButton).toBeDisabled()
    await expect.poll(() => mocked.removePreviewRequests()).toBe(1)
    await expect(page.getByText('Removing…')).toBeVisible()
    await removeButton.evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
    await expect.poll(() => mocked.removeRequests()).toBe(1)
    await expect(
      page.getByRole('heading', { name: 'Remove worktree' })
    ).toHaveCount(0)
    expect(mocked.removeRequestBodies()).toEqual([
      {
        confirmationToken: 'a'.repeat(64),
        confirmDestructive: false
      }
    ])
    releaseRemove()
  })

  test('retries one stale clean preview without opening a dialog', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    mocked.staleNextRemoveWithPreview({
      confirmationToken: 'c'.repeat(64)
    })
    await page.locator('.worktree-row').filter({ hasText: 'topic' }).hover()
    await page.getByRole('button', { name: 'Remove topic' }).click()

    await expect.poll(() => mocked.removeRequests()).toBe(2)
    expect(mocked.removeRequestBodies()).toEqual([
      {
        confirmationToken: 'a'.repeat(64),
        confirmDestructive: false
      },
      {
        confirmationToken: 'c'.repeat(64),
        confirmDestructive: false
      }
    ])
    await expect(
      page.getByRole('heading', { name: 'Remove worktree' })
    ).toHaveCount(0)
  })

  test('refreshes a stale clean preview and requires confirmation when it becomes dirty', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    mocked.staleNextRemoveWithPreview({
      dirty: {
        dirty: true,
        staged: 0,
        unstaged: 0,
        untracked: 1,
        conflicts: 0,
        total: 1
      },
      forceRequired: true,
      warnings: ['1 untracked file(s) will be lost'],
      confirmationToken: 'c'.repeat(64)
    })
    await page.locator('.worktree-row').filter({ hasText: 'topic' }).hover()
    await page.getByRole('button', { name: 'Remove topic' }).click()

    await expect(
      page.getByRole('heading', { name: 'Remove worktree' })
    ).toBeVisible()
    await expect(
      page.getByText('1 untracked file(s) will be lost')
    ).toBeVisible()
    expect(mocked.removeRequests()).toBe(1)
    const secondRemove = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname.endsWith('/remove')
    )
    await page.getByRole('button', { name: 'Remove anyway' }).click()
    expect((await secondRemove).postDataJSON()).toEqual({
      confirmationToken: 'c'.repeat(64),
      confirmDestructive: true
    })
    await expect.poll(() => mocked.removeRequests()).toBe(2)
  })

  test('renders authoritative removal progress and a retryable failure', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    const requestsBeforeStarted = mocked.projectRequests()
    mocked.state.worktrees[1]!.status = 'cleaning'
    await page.evaluate(() =>
      (window as any).__eventSource.emit('remove.started')
    )
    await expect
      .poll(() => mocked.projectRequests())
      .toBeGreaterThan(requestsBeforeStarted)
    await expect(page.getByText('Removing…')).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Remove topic' })
    ).toBeDisabled()

    mocked.state.worktrees[1]!.status = 'cleanup_failed'
    mocked.state.worktrees[1]!.cleanupError =
      'Terminals were stopped, but Git removal failed'
    await page.evaluate(() =>
      (window as any).__eventSource.emit('remove.failed')
    )
    await expect(page.getByText(/Removal failed:/)).toContainText(
      'Git removal failed'
    )
    const retry = page.getByRole('button', {
      name: 'Retry removal for topic'
    })
    await expect(retry).toBeEnabled()
    await retry.click()
    await expect.poll(() => mocked.removeRequests()).toBe(1)

    mocked.state.worktrees[1]!.status = 'cleanup_failed'
    mocked.state.worktrees[1]!.cleanupError =
      'Terminals were stopped, but Git removal failed again'
    await page.evaluate(() =>
      (window as any).__eventSource.emit('remove.failed')
    )
    await expect(
      page.getByRole('button', { name: 'Retry removal for topic' })
    ).toBeEnabled()

    mocked.state.worktrees[1]!.cleanupError =
      'Manual cleanup required: the checkout Git marker changed'
    await page.evaluate(() =>
      (window as any).__eventSource.emit('remove.failed')
    )
    await expect(
      page.getByRole('button', {
        name: 'Manual cleanup required for topic'
      })
    ).toBeDisabled()
  })

  test('closes immediately, shows the typed name, and selects the created terminal', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    const releaseCreate = mocked.delayNextCreate()
    await page.getByRole('button', { name: 'New worktree' }).click()
    await page.getByLabel('Worktree name').fill('new topic')
    await expect(
      page.getByText('Destination: /worktrees/new-topic/repo')
    ).toBeVisible()
    const requestPromise = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/projects/proj_1/worktrees'
    )
    await page.getByRole('button', { name: 'Create worktree' }).click()
    const request = await requestPromise
    expect(request.postDataJSON()).toEqual({
      name: 'new topic',
      base: 'default',
      initialTerminal: { name: 'Terminal' }
    })
    await expect(
      page.getByRole('heading', { name: 'Create worktree' })
    ).toHaveCount(0)
    const pending = page.getByRole('status', {
      name: 'Creating worktree new topic'
    })
    await expect(pending).toHaveText('new topic')
    await expect(pending.locator('.animate-spin')).toBeVisible()
    await expect(pending).toBeFocused()
    const projectRequestsBeforeEvent = mocked.projectRequests()
    await page.evaluate(() =>
      (window as any).__eventSource.emit('worktree.created')
    )
    await expect
      .poll(() => mocked.projectRequests())
      .toBeGreaterThan(projectRequestsBeforeEvent)
    await expect(pending).toBeVisible()

    releaseCreate()
    await expect(pending).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'new-topic', exact: true })
    ).toHaveCount(1)
    await expect
      .poll(() =>
        page.evaluate(() =>
          ((window as any).__wsInstances || []).some(
            (socket: { url: string }) => socket.url.includes('term_new')
          )
        )
      )
      .toBe(true)
    const terminalOutput = page.locator('.xterm-rows')
    await expect(terminalOutput).toContainText('SETUP_OUTPUT')
    await expect(terminalOutput).toContainText('SHELL_READY')
    const text = await terminalOutput.textContent()
    expect(text?.indexOf('SETUP_OUTPUT')).toBeLessThan(
      text?.indexOf('SHELL_READY') ?? -1
    )
  })

  test('keeps the create dialog closed and removes the typed row on failure', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    const releaseCreate = mocked.delayNextCreate()
    mocked.failNextCreate()
    await page.getByRole('button', { name: 'New worktree' }).click()
    await page.getByLabel('Worktree name').fill('will fail')
    await expect(
      page.getByText('Destination: /worktrees/will-fail/repo')
    ).toBeVisible()
    await page.getByRole('button', { name: 'Create worktree' }).click()
    await expect(
      page.getByRole('heading', { name: 'Create worktree' })
    ).toHaveCount(0)
    const pending = page.getByRole('status', {
      name: 'Creating worktree will fail'
    })
    await expect(pending).toHaveText('will fail')

    releaseCreate()
    await expect(pending).toHaveCount(0)
    await expect(page.getByRole('alert')).toContainText('create failed')
  })
})

test.describe('mobile terminal UI', () => {
  test.skip(({ isMobile }) => !isMobile)

  test('closes only a nested modal on Escape and restores its drawer trigger', async ({
    page
  }) => {
    await mockApp(page)
    const drawer = page.locator('.sidebar')
    await page.getByLabel('Open worktree drawer').click()
    const trigger = page.getByRole('button', { name: 'New worktree' })
    await trigger.click()
    await expect(page.getByRole('dialog')).toHaveCount(2)
    await page.keyboard.press('Escape')
    await expect(
      page.getByRole('heading', { name: 'Create worktree' })
    ).toHaveCount(0)
    await expect(drawer).toHaveClass(/open/)
    await expect(trigger).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(drawer).not.toHaveClass(/open/)
  })

  test('keeps the drawer open while choosing or dismissing a project color', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    const drawer = page.locator('.sidebar')
    await page.getByLabel('Open worktree drawer').click()
    const trigger = page.getByRole('button', {
      name: 'Change color for example'
    })
    await expect(trigger).toBeVisible()

    await trigger.click()
    await expect(page.getByText('Project color')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByText('Project color')).toHaveCount(0)
    await expect(drawer).toHaveClass(/open/)
    await expect(trigger).toBeFocused()

    await trigger.click()
    await page.getByRole('button', { name: 'Cyan', exact: true }).click()
    await expect.poll(() => mocked.state.color).toBe('cyan')
    await expect(drawer).toHaveClass(/open/)
    await expect(trigger).toBeFocused()
  })

  test('closes the drawer and exposes a create failure alert', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    mocked.failNextCreate()
    const drawer = page.locator('.sidebar')
    await page.getByLabel('Open worktree drawer').click()
    await page.getByRole('button', { name: 'New worktree' }).click()
    await page.getByLabel('Worktree name').fill('mobile failure')
    await expect(
      page.getByText('Destination: /worktrees/mobile-failure/repo')
    ).toBeVisible()
    await page.getByRole('button', { name: 'Create worktree' }).click()

    await expect(drawer).not.toHaveClass(/open/)
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('create failed')
    await expect(alert).not.toHaveAttribute('inert', '')
    await expect(alert).not.toHaveAttribute('aria-hidden', 'true')
  })

  test('makes sync controls inert while the mobile drawer is open', async ({
    page
  }) => {
    await mockApp(page)
    await page.evaluate(() => (window as any).__eventSource.emit('error'))
    const status = page.locator('[role="status"]')
    await expect(status).toBeVisible({ timeout: 5_000 })
    await page.getByLabel('Open worktree drawer').click()
    await expect(status).toHaveAttribute('inert', '')
    await expect(status).toHaveAttribute('aria-hidden', 'true')
  })

  test('scrolls tmux history with a one-finger terminal swipe', async ({
    page
  }) => {
    await mockApp(page)
    await page.getByLabel('Open worktree drawer').click()
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await page.getByRole('button', { name: 'Take control' }).click()
    await page.evaluate(() => {
      const socket = (window as any).__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 2,
          data: '\u001b[?1049h\u001b[?1000h\u001b[?1006h'
        })
      })
      ;(window as any).__wsSent = []
    })
    const screen = page.locator('.xterm-screen')
    await expect(page.locator('.xterm.enable-mouse-events')).toBeVisible()
    const bounds = await screen.boundingBox()
    const row = await page.locator('.xterm-rows > div').first().boundingBox()
    expect(bounds).not.toBeNull()
    expect(row).not.toBeNull()
    const client = await page.context().newCDPSession(page)
    const x = bounds!.x + bounds!.width / 2
    const startY = bounds!.y + row!.height * 2
    const positions = [0, 4, 8, 12].map((rows) => startY + row!.height * rows)
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: positions[0]! }]
    })
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: positions[1]! }]
    })
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).__wsSent.filter((message: any) =>
              String(message.data).includes('\u001b[<64;')
            ).length
        )
      )
      .toBe(1)

    await page.evaluate(() => {
      const socket = (window as any).__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 3,
          data: '\u001b[?1000l'
        })
      })
    })
    await expect(page.locator('.xterm.enable-mouse-events')).toHaveCount(0)
    const messagesBeforeModeChange = await page.evaluate(
      () => (window as any).__wsSent.length
    )

    for (const y of positions.slice(2)) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y }]
      })
    }
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: []
    })

    const terminalHost = page.locator('.terminal-session-host')
    await expect(terminalHost).toHaveClass(/terminal-scrolling/)
    await expect
      .poll(() =>
        page.evaluate(
          (previousCount) =>
            (window as any).__wsSent.filter(
              (message: any) => message.type === 'input'
            ).length > previousCount,
          messagesBeforeModeChange
        )
      )
      .toBe(true)
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__wsSent.some(
            (message: any) => message.data === '\u001b[A'
          )
        )
      )
      .toBe(true)

    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.press('q')
    await expect(terminalHost).not.toHaveClass(/terminal-scrolling/)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).__wsSent
              .filter((message: any) => message.type === 'input')
              .at(-1)?.data
        )
      )
      .toBe(`${TERMINAL_SCROLL_EXIT_SEQUENCE}q`)
  })

  test('uses an accessible drawer, synchronized titles, control takeover, and accessory keys', async ({
    page
  }) => {
    await mockApp(page)
    const drawer = page.locator('.sidebar')
    const trigger = page.getByLabel('Open worktree drawer')
    await expect(drawer).toHaveAttribute('inert', '')
    await trigger.click()
    await expect(drawer).toHaveClass(/open/)
    await expect(drawer).not.toHaveAttribute('inert', '')
    await expect(page.getByLabel('Close drawer')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveAttribute('inert', '')
    await expect(trigger).toBeFocused()

    await trigger.click()
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await expect(page.locator('.xterm')).toBeVisible()
    await expect(
      page.locator('select[name="terminal-selector"] option:checked')
    ).toHaveText('zsh · /worktrees/topic')
    await page.evaluate(() => {
      const socket = (window as any).__wsInstances.find((item: any) =>
        item.url.includes('term_pi')
      )
      socket.onmessage?.({
        data: JSON.stringify({ version: 1, type: 'title', title: '' })
      })
    })
    await expect(
      page.locator('select[name="terminal-selector"] option:checked')
    ).toHaveText('Pi')
    await page.getByRole('button', { name: 'Take control' }).click()
    await page.getByRole('button', { name: 'Esc' }).click()
    await page.evaluate(() => {
      const socket = (window as any).__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 2,
          data: '\u001b[?1h'
        })
      })
    })
    await page.waitForTimeout(50)
    await page.getByRole('button', { name: 'Arrow up' }).click()
    const sent = await page.evaluate(() => (window as any).__wsSent)
    expect(sent).toEqual(
      expect.arrayContaining([
        { version: 1, type: 'input', data: '\u001b' },
        { version: 1, type: 'input', data: '\u001bOA' }
      ])
    )
  })
})
