import { expect, test, type Page } from '@playwright/test'
import type {
  ProjectColor,
  RecentProjectRecord,
  TerminalRuntimeMetadata
} from '@tasktty/shared'

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
  initialTerminalMetadata: TerminalRuntimeMetadata[] = [],
  options: {
    keyboardPlatform?: string
    startClosed?: boolean
    terminalFree?: boolean
    includeSecondProject?: boolean
  } = {}
) {
  if (options.keyboardPlatform) {
    await page.addInitScript((platform) => {
      Object.defineProperty(navigator, 'platform', {
        configurable: true,
        value: platform
      })
    }, options.keyboardPlatform)
  }

  await page.addInitScript((initialMetadata) => {
    class MockWebSocket {
      static OPEN = 1
      readyState = 0
      binaryType = 'arraybuffer'
      onopen: (() => void) | null = null
      onerror: (() => void) | null = null
      clientId = ''
      terminalId = ''
      namespace = ''
      streamId = crypto.randomUUID()
      generation = 1
      private messageHandler: ((event: { data: string }) => void) | null = null
      private closeHandler: (() => void) | null = null

      constructor(public url: string) {
        const scope = window as any
        scope.__controllerClientId ||= 'other'
        scope.__wsInstances = [...(scope.__wsInstances || []), this]
        scope.__lastWs = this
        setTimeout(() => {
          this.readyState = 1
          this.onopen?.()
          this.deliver(
            `0${JSON.stringify({
              sid: crypto.randomUUID(),
              upgrades: [],
              pingInterval: 25_000,
              pingTimeout: 20_000,
              maxPayload: 128 * 1024
            })}`
          )
        }, 10)
      }

      set onmessage(handler: ((event: { data: string }) => void) | null) {
        this.messageHandler = handler
      }

      get onmessage() {
        return (event: { data: string }) => {
          let message: any = null
          try {
            message = JSON.parse(String(event.data))
          } catch {
            this.messageHandler?.(event)
            return
          }
          if (!message?.type || this.namespace !== '/terminals') {
            this.messageHandler?.(event)
            return
          }

          const type =
            message.type === 'error' ? 'terminal_error' : message.type
          const { type: _type, version: _version, ...payload } = message
          if (type === 'control' && payload.generation === undefined) {
            payload.generation = this.generation
          }

          this.deliverSocket(type, payload)
        }
      }

      set onclose(handler: (() => void) | null) {
        this.closeHandler = handler
      }

      get onclose() {
        return () => {
          this.readyState = 3
          this.closeHandler?.()
        }
      }

      send(data: string) {
        const scope = window as any
        if (data === '2') {
          this.deliver('3')
          return
        }

        if (data.startsWith('40/events')) {
          this.namespace = '/events'
          this.deliver(
            `40/events,${JSON.stringify({ sid: crypto.randomUUID() })}`
          )
          scope.__eventSource = {
            disconnect: () => this.deliver('41/events,'),
            emit: (name: string, source = '{}') => {
              if (name === 'error') {
                this.close()
                return
              }

              const value = JSON.parse(source)
              if (name === 'connected') {
                this.deliverSocket('snapshot', value)
                return
              }

              const event = value?.type
                ? value
                : {
                    id: crypto.randomUUID(),
                    type: name,
                    at: new Date().toISOString(),
                    data: value?.data ?? value
                  }
              this.deliverSocket('product_event', event)
            }
          }
          this.deliverSocket('snapshot', {
            at: new Date().toISOString(),
            terminalMetadata: initialMetadata
          })
          return
        }

        if (data.startsWith('40/terminals')) {
          this.namespace = '/terminals'
          const separator = data.indexOf(',')
          const auth = JSON.parse(data.slice(separator + 1))
          this.clientId = auth.clientId
          this.terminalId = auth.terminalId
          this.url = `${this.url}#${this.terminalId}`
          this.deliver(
            `40/terminals,${JSON.stringify({ sid: crypto.randomUUID() })}`
          )
          const controller = scope.__controllerClientId === this.clientId
          this.deliverSocket('ready', {
            connectionId: crypto.randomUUID(),
            streamId: this.streamId,
            generation: this.generation,
            controller,
            reset: 'full'
          })
          this.deliverSocket('output', {
            streamId: this.streamId,
            sequence: 1,
            data:
              this.terminalId === 'term_new'
                ? '[TaskTTY setup] bootstrap\\r\\nSETUP_OUTPUT\\r\\n[TaskTTY setup] bootstrap complete\\r\\nSHELL_READY\\r\\n'
                : 'same persistent terminal session\\r\\n'
          })
          if (!scope.__suppressInitialTitle) {
            this.deliverSocket('title', {
              title:
                this.terminalId === 'term_dev'
                  ? 'dev · /worktrees/topic'
                  : 'zsh · /worktrees/topic'
            })
          }

          return
        }

        if (!data.startsWith('42/terminals,')) {
          return
        }

        const [type, payload = {}] = JSON.parse(
          data.slice('42/terminals,'.length)
        )
        const message = { type, ...payload }
        scope.__wsSent = [...(scope.__wsSent || []), message]
        if (type === 'take_control') {
          scope.__controllerClientId = this.clientId
          this.generation += 1
          this.deliverSocket('control', {
            generation: this.generation,
            controller: true
          })
        }
      }

      close() {
        this.readyState = 3
        this.closeHandler?.()
      }

      private deliver(data: string): void {
        queueMicrotask(() => this.messageHandler?.({ data }))
      }

      private deliverSocket(type: string, payload: unknown): void {
        this.deliver(`42${this.namespace},${JSON.stringify([type, payload])}`)
      }
    }
    Object.assign(window, { WebSocket: MockWebSocket })
  }, initialTerminalMetadata)
  const state = structuredClone(project)
  if (options.terminalFree) {
    for (const worktree of state.worktrees) {
      worktree.terminals = []
    }
  }

  const secondState = structuredClone(project)
  secondState.id = 'proj_2'
  secondState.name = 'another-project'
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
  const openProjects = options.startClosed
    ? []
    : [state, ...(options.includeSecondProject ? [secondState] : [])]
  const recentProjects: RecentProjectRecord[] = options.startClosed
    ? [
        {
          id: state.id,
          name: state.name,
          repositoryPath: state.repositoryPath,
          lastOpenedAt: state.updatedAt
        }
      ]
    : []
  let projectRequests = 0
  let closeRequests = 0
  let failClose = false
  let removePreviewRequests = 0
  let removePreviewDelayMs = 0
  let removePreviewOverride: Record<string, unknown> = {}
  let fileUploadRequests = 0
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
    if (
      pathname === '/api/projects/recent' &&
      route.request().method() === 'GET'
    ) {
      await route.fulfill({ json: { projects: recentProjects } })
      return
    }

    if (pathname === '/api/projects' && route.request().method() === 'GET') {
      projectRequests += 1
      await route.fulfill({ json: { projects: openProjects } })
      return
    }

    if (pathname === '/api/projects' && route.request().method() === 'POST') {
      if (!openProjects.some((candidate) => candidate.id === state.id)) {
        openProjects.push(state)
      }

      const recentIndex = recentProjects.findIndex(
        (candidate) => candidate.id === state.id
      )
      if (recentIndex >= 0) {
        recentProjects.splice(recentIndex, 1)
      }

      await route.fulfill({ status: 201, json: { project: state } })
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
              code: 'PROJECT_CLOSE_FAILED',
              message:
                'Some terminal sessions could not be stopped; the project remains open',
              details: { terminalsMayHaveStopped: true }
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
      /^\/api\/terminals\/[^/]+\/files$/.test(pathname) &&
      route.request().method() === 'POST'
    ) {
      fileUploadRequests += 1
      const extension =
        route.request().headers()['x-tasktty-file-extension'] || 'bin'
      await route.fulfill({
        status: 201,
        json: {
          file: {
            path: `/tmp/tasktty-upload-${fileUploadRequests}.${extension}`
          }
        }
      })
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
    recentProjects,
    projectRequests: () => projectRequests,
    closeRequests: () => closeRequests,
    failNextClose: () => {
      failClose = true
    },
    removePreviewRequests: () => removePreviewRequests,
    fileUploadRequests: () => fileUploadRequests,
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
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project example'
      })
    ).toBeVisible()
    await expect(page.getByText('topic', { exact: true })).toBeVisible()
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

  test('reopens a recent project by durable ID', async ({ page }) => {
    await mockApp(page, [], { startClosed: true, terminalFree: true })
    await expect(
      page.getByText('Open a Git repository to begin.')
    ).toBeVisible()

    await page.getByRole('button', { name: 'Open project' }).click()
    await expect(page.getByText('Recent projects')).toBeVisible()
    await expect(page.getByText('/repo')).toHaveCount(0)
    await page.getByRole('button', { name: 'example', exact: true }).click()

    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project example'
      })
    ).toBeVisible()
  })

  test('opens a project by repository path', async ({ page }) => {
    await mockApp(page, [], { startClosed: true, terminalFree: true })
    await page.getByRole('button', { name: 'Open project' }).click()
    await page.getByRole('button', { name: 'Open project…' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Open by repository path').fill('/repo')
    await dialog.getByRole('button', { name: 'Open project' }).click()

    await expect(dialog).toHaveCount(0)
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project example'
      })
    ).toBeVisible()
  })

  test('closes a terminal-bearing project only after confirmation', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('tasktty-terminal')))
      .toBe('term_shell')
    await page
      .getByRole('button', {
        name: 'Switch project, current project example'
      })
      .click()
    const projectOption = page
      .getByRole('listitem')
      .filter({ hasText: 'example' })
    await projectOption.hover()
    const close = page.getByRole('button', {
      name: 'Close project example'
    })

    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('2 TaskTTY terminal sessions')
      expect(dialog.message()).toContain('Recent projects')
      await dialog.dismiss()
    })
    await close.click()
    expect(mocked.closeRequests()).toBe(0)

    page.once('dialog', (dialog) => dialog.accept())
    await close.click()
    await expect(
      page.getByRole('button', { name: 'Open project' })
    ).toBeFocused()
    expect(mocked.closeRequests()).toBe(1)
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('tasktty-terminal')))
      .toBeNull()
    await expect
      .poll(() =>
        page.evaluate(() =>
          ((window as any).__wsInstances ?? [])
            .filter((socket: WebSocket) =>
              socket.url.includes('/api/terminals/')
            )
            .every((socket: WebSocket) => socket.readyState === 3)
        )
      )
      .toBe(true)
  })

  test('closes a terminal-free project without confirmation', async ({
    page
  }) => {
    const mocked = await mockApp(page, [], { terminalFree: true })
    let confirmationShown = false
    page.on('dialog', async (dialog) => {
      confirmationShown = true
      await dialog.dismiss()
    })
    await page
      .getByRole('button', {
        name: 'Switch project, current project example'
      })
      .click()
    const projectOption = page
      .getByRole('listitem')
      .filter({ hasText: 'example' })
    await projectOption.hover()
    await page.getByRole('button', { name: 'Close project example' }).click()

    await expect(
      page.getByRole('button', { name: 'Open project' })
    ).toBeVisible()
    expect(confirmationShown).toBe(false)
    expect(mocked.closeRequests()).toBe(1)
  })

  test('keeps a project visible when terminal shutdown is partial', async ({
    page
  }) => {
    const mocked = await mockApp(page, [], { terminalFree: true })
    mocked.failNextClose()
    await page
      .getByRole('button', {
        name: 'Switch project, current project example'
      })
      .click()
    const projectOption = page
      .getByRole('listitem')
      .filter({ hasText: 'example' })
    await projectOption.hover()
    await page.getByRole('button', { name: 'Close project example' }).click()

    await expect(page.getByRole('alert')).toContainText(
      'Some terminal sessions could not be stopped'
    )
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project example'
      })
    ).toBeVisible()
  })

  test('searches projects and closes the switcher from the terminal', async ({
    page
  }) => {
    await mockApp(page)
    await page
      .getByRole('button', {
        name: 'Switch project, current project example'
      })
      .click()
    const search = page.getByLabel('Search projects')
    await search.fill('missing')
    await expect(page.getByText('No open projects found.')).toBeVisible()
    await search.fill('example')
    await expect(
      page.getByRole('button', { name: 'example', exact: true })
    ).toBeVisible()

    await page.locator('.xterm-screen').click()
    await expect(search).toHaveCount(0)
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
  })

  test('shows one active project and persists project switching', async ({
    page
  }) => {
    await mockApp(page, [], { includeSecondProject: true })
    const switcher = page.getByRole('button', {
      name: 'Switch project, current project example'
    })
    await expect(page.getByText('topic', { exact: true })).toBeVisible()

    await switcher.click()
    await page
      .getByRole('button', { name: 'another-project', exact: true })
      .click()

    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project another-project'
      })
    ).toBeVisible()
    await expect(page.getByText('topic', { exact: true })).toHaveCount(0)
    await expect(page.getByText('another topic', { exact: true })).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('tasktty-active-project'))
      )
      .toBe('proj_2')

    await page.reload()
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project another-project'
      })
    ).toBeVisible()
    await expect(page.getByText('another topic', { exact: true })).toBeVisible()
  })

  test('detects plain web URLs and opens them only on platform modifier-click', async ({
    page
  }) => {
    await mockApp(page, [], { keyboardPlatform: 'Linux x86_64' })
    expect(await page.evaluate(() => navigator.platform)).toBe('Linux x86_64')
    await page.evaluate(() => {
      ;(window as any).__openedTerminalLinks = []
      window.open = (...args) => {
        ;(window as any).__openedTerminalLinks.push(args)
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
          data: '\u001b[2J\u001b[Hhttps://example.test/docs.\r\nhttp://example.test/help,\r\n'
        })
      })
    })

    const httpsText = page
      .locator('.xterm-rows span')
      .filter({ hasText: 'https://example.test/docs' })
      .last()
    await expect(httpsText).toBeVisible()
    await httpsText.hover({ position: { x: 16, y: 8 } })
    await expect(page.locator('.xterm-screen')).toHaveClass(
      /xterm-cursor-pointer/
    )
    await expect(httpsText).toHaveCSS('text-decoration-line', 'underline')

    await httpsText.click({ position: { x: 16, y: 8 } })
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await httpsText.click({
      modifiers: ['Meta'],
      position: { x: 16, y: 8 }
    })
    expect(
      await page.evaluate(() => (window as any).__openedTerminalLinks)
    ).toEqual([])

    await httpsText.click({
      modifiers: ['Control'],
      position: { x: 16, y: 8 }
    })
    const httpText = page
      .locator('.xterm-rows span')
      .filter({ hasText: 'http://example.test/help' })
      .last()
    await expect(httpText).toBeVisible()
    await httpText.hover({ position: { x: 16, y: 8 } })
    await httpText.click({
      modifiers: ['Control'],
      position: { x: 16, y: 8 }
    })
    await expect
      .poll(() => page.evaluate(() => (window as any).__openedTerminalLinks))
      .toEqual([
        ['https://example.test/docs', '_blank', 'noopener,noreferrer'],
        ['http://example.test/help', '_blank', 'noopener,noreferrer']
      ])
  })

  test('opens OSC 8 links in a new tab on Apple Cmd-click', async ({
    page
  }) => {
    await mockApp(page, [], { keyboardPlatform: 'MacIntel' })
    expect(await page.evaluate(() => navigator.platform)).toBe('MacIntel')
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
    await linkedText.click({
      modifiers: ['Meta'],
      position: { x: 8, y: 8 }
    })
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

  test('keeps a daemon clear authoritative over delayed terminal progress', async ({
    page
  }) => {
    await mockApp(page, [
      {
        terminalId: 'term_pi',
        title: 'background · /repo',
        progress: { state: 'normal', value: 42 }
      }
    ])

    await page
      .getByRole('button', { name: /background · \/repo.*42% complete/ })
      .click()
    await expect(page.getByRole('tab', { name: /42% complete/ })).toBeVisible()
    await page.evaluate(() =>
      (window as any).__eventSource.emit(
        'terminal.metadata',
        JSON.stringify({
          data: {
            terminalId: 'term_pi',
            title: 'background · /repo',
            progress: null,
            progressStartedAt: '2026-01-01T00:00:00.000Z',
            progressClearedAt: '2026-01-01T00:00:01.000Z',
            bell: null
          }
        })
      )
    )
    await expect(
      page.getByRole('button', { name: /42% complete/ })
    ).toHaveCount(0)
    await expect(page.getByRole('tab', { name: /42% complete/ })).toHaveCount(0)

    await page.evaluate(() => {
      const socket = (window as any).__wsInstances.find((item: any) =>
        item.url.includes('term_pi')
      )
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'progress',
          progress: { state: 'indeterminate', value: null }
        })
      })
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 2,
          data: '\u001b]9;4;3\u0007'
        })
      })
    })
    await expect(page.getByRole('button', { name: /working/ })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: /working/ })).toHaveCount(0)

    await page.evaluate(() =>
      (window as any).__eventSource.emit(
        'terminal.metadata',
        JSON.stringify({
          data: {
            terminalId: 'term_pi',
            title: 'background · /repo',
            progress: { state: 'normal', value: 75 },
            progressStartedAt: '2026-01-01T00:00:02.000Z',
            progressClearedAt: '2026-01-01T00:00:01.000Z',
            bell: null
          }
        })
      )
    )
    await expect(
      page.getByRole('button', { name: /75% complete/ })
    ).toBeVisible()
    await expect(page.getByRole('tab', { name: /75% complete/ })).toBeVisible()
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

  test('refreshes projects and replaces retained progress whenever Socket.IO reconnects', async ({
    page
  }) => {
    const mocked = await mockApp(page, [
      {
        terminalId: 'term_pi',
        title: 'background · /repo',
        progress: { state: 'indeterminate', value: null }
      }
    ])
    await expect(page.getByText('example')).toBeVisible()
    await expect(
      page.getByRole('button', { name: /background · \/repo.*working/ })
    ).toBeVisible()
    await expect.poll(() => mocked.projectRequests()).toBeGreaterThan(1)
    await page.waitForTimeout(150)
    const before = mocked.projectRequests()
    await page.evaluate(() =>
      (window as any).__eventSource.emit(
        'connected',
        JSON.stringify({
          at: new Date().toISOString(),
          terminalMetadata: [
            {
              terminalId: 'term_pi',
              title: 'background · /repo',
              progress: null,
              progressStartedAt: '2026-01-01T00:00:00.000Z',
              progressClearedAt: '2026-01-01T00:00:01.000Z',
              bell: null
            }
          ]
        })
      )
    )
    await expect.poll(() => mocked.projectRequests()).toBeGreaterThan(before)
    await expect(
      page.getByRole('button', { name: /background · \/repo.*working/ })
    ).toHaveCount(0)
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
    await page.evaluate(async () => {
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
      await new Promise((resolve) => setTimeout(resolve))
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

  test('uploads pasted and dropped files and pastes their server paths', async ({
    page
  }) => {
    const mocked = await mockApp(page)
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
          data: '\u001b[?2004h'
        })
      })
      ;(window as any).__wsSent = []
    })

    const paste = await page
      .locator('.xterm-helper-textarea')
      .evaluate((textarea) => {
        const clipboard = new DataTransfer()
        clipboard.items.add(
          new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', {
            type: 'image/png'
          })
        )
        const event = new Event('paste', { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'clipboardData', { value: clipboard })
        return {
          files: clipboard.files.length,
          prevented: !textarea.dispatchEvent(event)
        }
      })
    expect(paste).toEqual({ files: 1, prevented: true })

    await expect.poll(mocked.fileUploadRequests).toBe(1)
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__wsSent
            .filter((message: any) => message.type === 'input')
            .map((message: any) => message.data)
            .join('')
        )
      )
      .toContain('\u001b[200~/tmp/tasktty-upload-1.png\u001b[201~')

    const drop = await page
      .locator('.terminal-session-host')
      .evaluate((terminalHost) => {
        const transfer = new DataTransfer()
        transfer.items.add(
          new File(['hello'], 'notes.txt', { type: 'text/plain' })
        )
        const dragoverPrevented = !terminalHost.dispatchEvent(
          new DragEvent('dragover', {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer
          })
        )
        const highlighted =
          terminalHost.classList.contains('terminal-file-drag')
        const dropPrevented = !terminalHost.dispatchEvent(
          new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer
          })
        )
        return { dragoverPrevented, dropPrevented, highlighted }
      })
    expect(drop).toEqual({
      dragoverPrevented: true,
      dropPrevented: true,
      highlighted: true
    })

    await expect.poll(mocked.fileUploadRequests).toBe(2)
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__wsSent
            .filter((message: any) => message.type === 'input')
            .map((message: any) => message.data)
            .join('')
        )
      )
      .toContain('/tmp/tasktty-upload-2.txt')
  })

  test('keeps plain dragged text selected while tmux mouse reporting is active', async ({
    page
  }) => {
    await mockApp(page)
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await page.getByRole('button', { name: 'Take control' }).click()
    await page.evaluate(() => {
      ;(window as any).__openedTerminalLinks = []
      window.open = (...args) => {
        ;(window as any).__openedTerminalLinks.push(args)
        return null
      }
      const socket = (window as any).__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 2,
          data: '\u001b[2J\u001b[Hhttps://example.test/select-me\r\n\u001b[?1000h\u001b[?1006h'
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
    expect(copied).toContain('example.tes')
    expect(
      await page.evaluate(() => (window as any).__openedTerminalLinks)
    ).toEqual([])
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

  test('renders daemon progress clears in the worktree drawer', async ({
    page
  }) => {
    await mockApp(page, [
      {
        terminalId: 'term_pi',
        title: 'background · /repo',
        progress: { state: 'normal', value: 42 }
      }
    ])
    await page.getByLabel('Open worktree drawer').click()
    await expect(
      page.getByRole('button', { name: /background · \/repo.*42% complete/ })
    ).toBeVisible()

    await page.evaluate(() =>
      (window as any).__eventSource.emit(
        'terminal.metadata',
        JSON.stringify({
          data: {
            terminalId: 'term_pi',
            title: 'background · /repo',
            progress: null,
            progressStartedAt: '2026-01-01T00:00:00.000Z',
            progressClearedAt: '2026-01-01T00:00:01.000Z',
            bell: null
          }
        })
      )
    )
    await expect(
      page.getByRole('button', {
        name: 'background · /repo, running'
      })
    ).toBeVisible()
  })

  test('keeps the project close action visible and usable by touch', async ({
    page
  }) => {
    await mockApp(page, [], { terminalFree: true })
    await page.getByLabel('Open worktree drawer').click()
    await page
      .getByRole('button', {
        name: 'Switch project, current project example'
      })
      .click()
    const close = page.getByRole('button', { name: 'Close project example' })
    await expect(close).toBeVisible()
    await expect(close).toHaveCSS('opacity', '1')
    await close.click()
    await expect(
      page.getByRole('button', { name: 'Open project' })
    ).toBeVisible()
  })

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
    await page.evaluate(() => (window as any).__eventSource.disconnect())
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
    const inputMessagesBeforeModeChange = await page.evaluate(
      () =>
        (window as any).__wsSent.filter(
          (message: any) => message.type === 'input'
        ).length
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
          inputMessagesBeforeModeChange
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

  test('sends Shift+Tab from the horizontally scrollable accessory row', async ({
    page
  }) => {
    await page.setViewportSize({ width: 320, height: 700 })
    await mockApp(page)
    await page.getByLabel('Open worktree drawer').click()
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await page.getByRole('button', { name: 'Take control' }).click()

    const accessoryRow = page.locator('.accessory-row')
    const ctrl = page.getByRole('button', { name: 'Ctrl', exact: true })
    const alt = page.getByRole('button', { name: 'Alt', exact: true })
    const shiftTab = page.getByRole('button', {
      name: 'Shift+Tab',
      exact: true
    })
    await expect(shiftTab).toBeVisible()
    const rowWidth = await accessoryRow.evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth
    }))
    expect(rowWidth.scroll).toBeGreaterThan(rowWidth.client)
    const buttonWidth = await shiftTab.evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth
    }))
    expect(buttonWidth.scroll).toBeLessThanOrEqual(buttonWidth.client)

    await alt.click()
    await ctrl.click()
    await expect(alt).toHaveClass(/latched/)
    await expect(ctrl).toHaveClass(/latched/)
    await page.evaluate(() => {
      ;(window as any).__wsSent = []
    })
    await accessoryRow.evaluate((element) => {
      element.scrollLeft = element.scrollWidth
    })
    await expect
      .poll(() => accessoryRow.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0)
    await shiftTab.scrollIntoViewIfNeeded()
    await expect(shiftTab).toBeInViewport()
    await shiftTab.click()

    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__wsSent
            .filter((message: any) => message.type === 'input')
            .map((message: any) => message.data)
        )
      )
      .toEqual(['\u001b[Z'])
    await expect(alt).not.toHaveClass(/latched/)
    await expect(ctrl).not.toHaveClass(/latched/)
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
        expect.objectContaining({ type: 'input', data: '\u001b' }),
        expect.objectContaining({ type: 'input', data: '\u001bOA' })
      ])
    )
  })
})
