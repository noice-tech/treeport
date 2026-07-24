import { expect, test, type Locator, type Page } from '@playwright/test'
import type {
  ProjectColor,
  RecentProjectRecord,
  TerminalPreset,
  TerminalRuntimeMetadata
} from '@tasktty/shared'

const TERMINAL_SCROLL_EXIT_SEQUENCE = '\u001b[9000~'

async function terminalTextPoint(
  locator: Locator,
  offset: { x: number; y: number }
): Promise<{ x: number; y: number }> {
  let point: { x: number; y: number } | null = null
  await expect
    .poll(async () => {
      const bounds = await locator.boundingBox()
      point = bounds ? { x: bounds.x + offset.x, y: bounds.y + offset.y } : null
      return point
    })
    .not.toBeNull()
  return point!
}

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
    worktreeFree?: boolean
    includeSecondProject?: boolean
    desktopBridge?: boolean
    initialPath?: string
    delayProjects?: boolean
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

  if (options.desktopBridge) {
    await page.addInitScript(() => {
      const scope = window as any
      let listener:
        | ((command: 'new-terminal' | 'close-terminal') => void)
        | null = null
      let fullscreenListener: ((fullscreen: boolean) => void) | null = null
      scope.__openedDesktopFileUrls = []
      scope.taskttyDesktop = Object.freeze({
        platform: 'darwin',
        openFileUrl(url: string) {
          scope.__openedDesktopFileUrls.push(url)
          return Promise.resolve(true)
        },
        onFullscreenChange(next: (fullscreen: boolean) => void) {
          fullscreenListener = next
          return () => {
            if (fullscreenListener === next) {
              fullscreenListener = null
            }
          }
        },
        onTerminalCommand(
          next: (command: 'new-terminal' | 'close-terminal') => void
        ) {
          listener = next
          return () => {
            if (listener === next) {
              listener = null
            }
          }
        }
      })
      scope.__dispatchDesktopCommand = (
        command: 'new-terminal' | 'close-terminal'
      ) => listener?.(command)
      scope.__dispatchDesktopFullscreen = (fullscreen: boolean) =>
        fullscreenListener?.(fullscreen)
    })
  }

  await page.addInitScript((initialMetadata) => {
    const terminalStatePrefix = '__tasktty_terminal_state__:'
    const readTerminalState = (terminalId: string) => {
      const stored = localStorage.getItem(`${terminalStatePrefix}${terminalId}`)
      return stored ? JSON.parse(stored) : null
    }
    const notifyTerminalState = (state: any) => {
      const scope = window as any
      for (const socket of scope.__wsInstances || []) {
        if (
          socket.namespace !== '/terminals' ||
          socket.terminalId !== state.terminalId
        ) {
          continue
        }

        socket.applyTerminalState(state)
      }
    }
    const storeTerminalState = (state: any) => {
      localStorage.setItem(
        `${terminalStatePrefix}${state.terminalId}`,
        JSON.stringify(state)
      )
      notifyTerminalState(state)
    }
    const scope = window as any
    if (!scope.__terminalStateListener) {
      scope.__terminalStateListener = true
      window.addEventListener('storage', (event) => {
        if (!event.key?.startsWith(terminalStatePrefix) || !event.newValue) {
          return
        }

        notifyTerminalState(JSON.parse(event.newValue))
      })
    }

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
      cols = 100
      rows = 30
      revision = 1
      private messageHandler: ((event: { data: string }) => void) | null = null
      private closeHandler: (() => void) | null = null

      constructor(public url: string) {
        const scope = window as any
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
          let terminalState = readTerminalState(this.terminalId)
          if (!terminalState) {
            terminalState = {
              terminalId: this.terminalId,
              cols: auth.cols,
              rows: auth.rows,
              revision: 1,
              generation: 1,
              controllerClientId: 'other'
            }
            localStorage.setItem(
              `${terminalStatePrefix}${this.terminalId}`,
              JSON.stringify(terminalState)
            )
          }

          this.cols = terminalState.cols
          this.rows = terminalState.rows
          this.revision = terminalState.revision
          this.generation = terminalState.generation
          this.url = `${this.url}#${this.terminalId}`
          this.deliver(
            `40/terminals,${JSON.stringify({ sid: crypto.randomUUID() })}`
          )
          const controller = terminalState.controllerClientId === this.clientId
          this.deliverSocket('ready', {
            connectionId: crypto.randomUUID(),
            streamId: this.streamId,
            generation: this.generation,
            controller,
            reset: 'full',
            cols: this.cols,
            rows: this.rows,
            revision: this.revision
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
        if (type === 'resize' || type === 'take_control') {
          const terminalState = readTerminalState(this.terminalId)
          if (!terminalState) {
            throw new Error('Missing mock terminal state')
          }

          if (payload.cols !== this.cols || payload.rows !== this.rows) {
            terminalState.cols = payload.cols
            terminalState.rows = payload.rows
            terminalState.revision += 1
          }

          if (type === 'take_control') {
            terminalState.controllerClientId = this.clientId
            terminalState.generation += 1
          }

          storeTerminalState(terminalState)
        }
      }

      applyTerminalState(state: any) {
        const dimensionsChanged =
          state.cols !== this.cols ||
          state.rows !== this.rows ||
          state.revision !== this.revision
        this.cols = state.cols
        this.rows = state.rows
        this.revision = state.revision
        this.generation = state.generation
        if (this.readyState !== 1) {
          return
        }

        if (dimensionsChanged) {
          this.deliverSocket('dimensions', {
            cols: this.cols,
            rows: this.rows,
            revision: this.revision
          })
        }

        this.deliverSocket('control', {
          generation: this.generation,
          controller: state.controllerClientId === this.clientId
        })
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
  const terminalPresets: TerminalPreset[] = [
    {
      id: 'preset_hunk',
      name: 'Hunk',
      executable: 'npx',
      args: ['--yes', 'hunkdiff@0.17.3', 'diff', 'HEAD', '--watch'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
  ]
  if (options.terminalFree) {
    for (const worktree of state.worktrees) {
      worktree.terminals = []
    }
  }

  if (options.worktreeFree) {
    state.worktrees = []
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
  let releaseProjects: (() => void) | null = null
  const projectsGate = options.delayProjects
    ? new Promise<void>((resolve) => {
        releaseProjects = resolve
      })
    : null
  let closeRequests = 0
  let failClose = false
  let removePreviewRequests = 0
  let removePreviewDelayMs = 0
  let removePreviewOverride: Record<string, unknown> = {}
  let fileUploadRequests = 0
  let terminalCreations = 0
  let terminalCreateGate: Promise<void> | null = null
  let releaseTerminalCreate: (() => void) | null = null
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
      pathname === '/api/terminal-presets' &&
      route.request().method() === 'GET'
    ) {
      await route.fulfill({ json: { presets: terminalPresets } })
      return
    }

    if (
      pathname === '/api/terminal-presets' &&
      route.request().method() === 'POST'
    ) {
      const body = route.request().postDataJSON() as Pick<
        TerminalPreset,
        'name' | 'executable' | 'args'
      >
      const preset: TerminalPreset = {
        id: `preset_${terminalPresets.length + 1}`,
        ...body,
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z'
      }
      terminalPresets.push(preset)
      await route.fulfill({ status: 201, json: { preset } })
      return
    }

    if (
      pathname.startsWith('/api/terminal-presets/') &&
      route.request().method() === 'PATCH'
    ) {
      const presetId = pathname.split('/').at(-1)!
      const body = route.request().postDataJSON() as Pick<
        TerminalPreset,
        'name' | 'executable' | 'args'
      > & { expectedUpdatedAt: string }
      const { expectedUpdatedAt, ...input } = body
      const index = terminalPresets.findIndex(
        (preset) => preset.id === presetId
      )
      if (index < 0) {
        await route.fulfill({
          status: 404,
          json: {
            error: {
              code: 'TERMINAL_PRESET_NOT_FOUND',
              message: 'Terminal preset not found'
            }
          }
        })
        return
      }

      if (terminalPresets[index]!.updatedAt !== expectedUpdatedAt) {
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'TERMINAL_PRESET_CHANGED',
              message: 'Terminal preset changed'
            }
          }
        })
        return
      }

      const preset: TerminalPreset = {
        ...terminalPresets[index]!,
        ...input,
        updatedAt: '2026-01-03T00:00:00.000Z'
      }
      terminalPresets[index] = preset
      await route.fulfill({ json: { preset } })
      return
    }

    if (
      pathname.startsWith('/api/terminal-presets/') &&
      route.request().method() === 'DELETE'
    ) {
      const presetId = pathname.split('/').at(-1)!
      const body = route.request().postDataJSON() as {
        expectedUpdatedAt: string
      }
      const index = terminalPresets.findIndex(
        (preset) => preset.id === presetId
      )
      if (index < 0) {
        await route.fulfill({
          status: 404,
          json: {
            error: {
              code: 'TERMINAL_PRESET_NOT_FOUND',
              message: 'Terminal preset not found'
            }
          }
        })
        return
      }

      if (terminalPresets[index]!.updatedAt !== body.expectedUpdatedAt) {
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'TERMINAL_PRESET_CHANGED',
              message: 'Terminal preset changed'
            }
          }
        })
        return
      }

      terminalPresets.splice(index, 1)
      await route.fulfill({ json: { ok: true } })
      return
    }

    if (
      pathname === '/api/projects/recent' &&
      route.request().method() === 'GET'
    ) {
      await route.fulfill({ json: { projects: recentProjects } })
      return
    }

    if (pathname === '/api/projects' && route.request().method() === 'GET') {
      projectRequests += 1
      if (projectsGate) {
        await projectsGate
      }

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
        initialTerminal?: {
          name: string
          argv?: string[]
          returnToShell?: boolean
        }
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
        name: body.initialTerminal?.name ?? 'Shell',
        tmuxSessionName: 'tasktty-term-new',
        argv: body.initialTerminal?.argv ?? ['/bin/zsh', '-l'],
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
      terminalCreations += 1
      if (terminalCreateGate) {
        await terminalCreateGate
      }

      terminalCreateGate = null
      releaseTerminalCreate = null
      const terminal = {
        id:
          terminalCreations === 1
            ? 'term_dev'
            : `term_dev_${terminalCreations}`,
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
  await page.goto(options.initialPath ?? '/')
  return {
    state,
    terminalPresets,
    recentProjects,
    projectRequests: () => projectRequests,
    releaseProjects: () => releaseProjects?.(),
    closeRequests: () => closeRequests,
    failNextClose: () => {
      failClose = true
    },
    removePreviewRequests: () => removePreviewRequests,
    fileUploadRequests: () => fileUploadRequests,
    terminalCreations: () => terminalCreations,
    delayNextTerminalCreate: () => {
      terminalCreateGate = new Promise<void>((resolve) => {
        releaseTerminalCreate = resolve
      })
      return () => releaseTerminalCreate?.()
    },
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

  test('keeps one live project event socket under Strict Mode', async ({
    page
  }) => {
    await mockApp(page)
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project example'
      })
    ).toBeVisible()

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            ((window as any).__wsInstances ?? []).filter(
              (socket: { namespace: string; readyState: number }) =>
                socket.namespace === '/events' && socket.readyState === 1
            ).length
        )
      )
      .toBe(1)
  })

  test('migrates legacy workspace storage into one validated route hint', async ({
    page
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('tasktty-active-project', 'proj_1')
      localStorage.setItem('tasktty-terminal', 'term_pi')
    })
    await mockApp(page)

    await expect(page).toHaveURL(
      /\/projects\/proj_1\/worktrees\/wt_topic\/terminals\/term_pi$/
    )
    await expect
      .poll(() =>
        page.evaluate(() => ({
          activeProject: localStorage.getItem('tasktty-active-project'),
          terminal: localStorage.getItem('tasktty-terminal'),
          route: localStorage.getItem('tasktty-last-workspace-route')
        }))
      )
      .toEqual({
        activeProject: null,
        terminal: null,
        route: '/projects/proj_1/worktrees/wt_topic/terminals/term_pi'
      })
  })

  test('keeps a direct terminal route while project metadata loads', async ({
    page
  }) => {
    const pathname = '/projects/proj_1/worktrees/wt_topic/terminals/term_pi'
    const mocked = await mockApp(page, [], {
      initialPath: pathname,
      delayProjects: true
    })

    expect(new URL(page.url()).pathname).toBe(pathname)
    await expect(page.getByText('Loading repositories…')).toBeVisible()
    await expect(
      page.getByRole('status', { name: 'Loading workspace' })
    ).toBeVisible()
    await expect(page.getByText('Choose a worktree.')).toHaveCount(0)
    mocked.releaseProjects()
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project example'
      })
    ).toBeVisible()
    await expect(page.locator('.terminal-row.selected')).toContainText(
      'zsh · /worktrees/topic'
    )
    expect(new URL(page.url()).pathname).toBe(pathname)
  })

  test('keeps an empty project route canonical', async ({ page }) => {
    await mockApp(page, [], {
      worktreeFree: true,
      initialPath: '/projects/proj_1'
    })
    await expect(page).toHaveURL(/\/projects\/proj_1$/)
    await expect(page.getByText('Open a Git repository to begin.')).toHaveCount(
      0
    )
  })

  test('keeps an empty worktree route canonical', async ({ page }) => {
    await mockApp(page, [], {
      terminalFree: true,
      initialPath: '/projects/proj_1/worktrees/wt_topic'
    })
    await expect(page).toHaveURL(/\/projects\/proj_1\/worktrees\/wt_topic$/)
    await expect(page.getByText('topic', { exact: true })).toBeVisible()
  })

  test('replaces invalid entity IDs with a deterministic valid route', async ({
    page
  }) => {
    await mockApp(page, [], {
      initialPath: '/projects/missing/worktrees/missing/terminals/missing'
    })

    await expect(page).toHaveURL(
      /\/projects\/proj_1\/worktrees\/wt_main\/terminals\/term_shell$/
    )
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project example'
      })
    ).toBeVisible()
  })

  test('uses push history for choices and replace history for route repair', async ({
    page
  }) => {
    await mockApp(page)
    await expect(page).toHaveURL(
      /\/projects\/proj_1\/worktrees\/wt_main\/terminals\/term_shell$/
    )

    const piTerminal = page.getByRole('button', {
      name: 'Pi, running',
      exact: true
    })
    await piTerminal.click()
    await expect(page).toHaveURL(
      /\/projects\/proj_1\/worktrees\/wt_topic\/terminals\/term_pi$/
    )
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    await page.locator('.terminal-row.selected').click()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    const terminalSockets = await page.evaluate(
      () =>
        ((window as any).__wsInstances ?? []).filter(
          (socket: { url: string }) => socket.url.includes('#term_')
        ).length
    )
    await page.goBack()
    await expect(page).toHaveURL(
      /\/projects\/proj_1\/worktrees\/wt_main\/terminals\/term_shell$/
    )
    await page.goForward()
    await expect(page).toHaveURL(
      /\/projects\/proj_1\/worktrees\/wt_topic\/terminals\/term_pi$/
    )
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            ((window as any).__wsInstances ?? []).filter(
              (socket: { url: string }) => socket.url.includes('#term_')
            ).length
        )
      )
      .toBe(terminalSockets)

    await page.goto('/projects/proj_1/worktrees/wt_main/terminals/term_pi')
    await expect(page).toHaveURL(
      /\/projects\/proj_1\/worktrees\/wt_main\/terminals\/term_shell$/
    )
    await page.goBack()
    await expect(page).toHaveURL(
      /\/projects\/proj_1\/worktrees\/wt_topic\/terminals\/term_pi$/
    )
  })

  test('navigates and persists a desktop workspace', async ({ page }) => {
    await mockApp(page, [], { includeSecondProject: true })
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project example'
      })
    ).toBeVisible()
    await expect(page.getByText('topic', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await expect(page.locator('.xterm')).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
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
    const switcher = page.getByRole('button', {
      name: 'Switch project, current project example'
    })
    await expect(page.getByText('topic', { exact: true })).toBeVisible()

    await switcher.click()
    const projectSearch = page.getByLabel('Search projects')
    await projectSearch.fill('another')
    const highlightedProject = page.getByRole('button', {
      name: 'another-project',
      exact: true
    })
    await expect(highlightedProject).toHaveAttribute('data-highlighted', 'true')
    await projectSearch.press('Enter')

    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project another-project'
      })
    ).toBeVisible()
    await expect(page.getByText('topic', { exact: true })).toHaveCount(0)
    await expect(page.getByText('another topic', { exact: true })).toBeVisible()
    await expect(page).toHaveURL(
      /\/projects\/proj_2\/worktrees\/second_wt_main\/terminals\/second_term_shell$/
    )
    await expect
      .poll(() =>
        page.evaluate(() =>
          localStorage.getItem('tasktty-last-workspace-route')
        )
      )
      .toBe(
        '/projects/proj_2/worktrees/second_wt_main/terminals/second_term_shell'
      )

    await page.reload()
    await expect(page).toHaveURL(
      /\/projects\/proj_2\/worktrees\/second_wt_main\/terminals\/second_term_shell$/
    )
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project another-project'
      })
    ).toBeVisible()
    await expect(page.getByText('another topic', { exact: true })).toBeVisible()

    await page
      .getByRole('button', {
        name: 'Switch project, current project another-project'
      })
      .click()
    await page.getByRole('button', { name: 'example', exact: true }).click()
    await expect(page).toHaveURL(
      /\/projects\/proj_1\/worktrees\/wt_topic\/terminals\/term_pi$/
    )

    const separator = page.getByRole('separator', { name: 'Resize sidebar' })
    await expect(separator).toHaveAttribute('aria-valuenow', '272')
    await separator.press('ArrowRight')
    await expect(separator).toHaveAttribute('aria-valuenow', '288')
  })
  test('replaces a removed selected project with its adjacent project', async ({
    page
  }) => {
    await mockApp(page, [], { includeSecondProject: true })
    await expect(page).toHaveURL(
      /\/projects\/proj_1\/worktrees\/wt_main\/terminals\/term_shell$/
    )

    await page
      .getByRole('button', {
        name: 'Switch project, current project example'
      })
      .click()
    const projectOption = page
      .getByRole('listitem')
      .filter({ hasText: 'example' })
    await projectOption.hover()
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: 'Close project example' }).click()

    await expect(page).toHaveURL(
      /\/projects\/proj_2\/worktrees\/second_wt_main\/terminals\/second_term_shell$/
    )
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project another-project'
      })
    ).toBeVisible()
  })

  test('repairs the route after authoritative worktree removal', async ({
    page
  }) => {
    const mocked = await mockApp(page, [], {
      initialPath: '/projects/proj_1/worktrees/wt_topic/terminals/term_pi'
    })
    await expect(page.getByText('topic', { exact: true })).toBeVisible()

    mocked.state.worktrees.splice(1, 1)
    await page.evaluate(() =>
      (window as any).__eventSource.emit('worktree.removed')
    )

    await expect(page).toHaveURL(
      /\/projects\/proj_1\/worktrees\/wt_main\/terminals\/term_shell$/
    )
    await expect(page.getByText('topic', { exact: true })).toHaveCount(0)
  })

  test('opens and closes a project across its full lifecycle', async ({
    page
  }) => {
    const mocked = await mockApp(page, [], { startClosed: true })
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
    await expect(page).toHaveURL(
      /\/projects\/proj_1\/worktrees\/wt_main\/terminals\/term_shell$/
    )

    const openSwitcher = () =>
      page
        .getByRole('button', {
          name: 'Switch project, current project example'
        })
        .click()
    const closeProject = async () => {
      const projectOption = page
        .getByRole('listitem')
        .filter({ hasText: 'example' })

      if (!(await projectOption.isVisible())) {
        await openSwitcher()
      }

      await projectOption.hover()
      await page.getByRole('button', { name: 'Close project example' }).click()
    }
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('2 TaskTTY terminal sessions')
      expect(dialog.message()).toContain('Recent projects')
      await dialog.dismiss()
    })
    await closeProject()
    expect(mocked.closeRequests()).toBe(0)

    mocked.failNextClose()
    page.once('dialog', (dialog) => dialog.accept())
    await closeProject()
    await expect(page.getByRole('alert')).toContainText(
      'Some terminal sessions could not be stopped'
    )
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project example'
      })
    ).toBeVisible()

    page.once('dialog', (dialog) => dialog.accept())
    await closeProject()
    await expect(
      page.getByRole('button', { name: 'Open project' })
    ).toBeFocused()
    expect(mocked.closeRequests()).toBe(2)
    await expect(page).toHaveURL(/\/$/)
    await expect
      .poll(() =>
        page.evaluate(() =>
          localStorage.getItem('tasktty-last-workspace-route')
        )
      )
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

    let confirmationShown = false
    page.on('dialog', async (confirmation) => {
      confirmationShown = true
      await confirmation.dismiss()
    })
    await closeProject()
    await expect(
      page.getByRole('button', { name: 'Open project' })
    ).toBeVisible()
    expect(confirmationShown).toBe(false)
    expect(mocked.closeRequests()).toBe(3)
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
    // xterm 6 makes rendered rows ignore pointer events; links are hit-tested
    // from coordinates on the screen element instead.
    const httpsPoint = await terminalTextPoint(httpsText, { x: 16, y: 8 })
    await page.mouse.move(httpsPoint.x, httpsPoint.y)
    await expect(page.locator('.xterm-screen')).toHaveClass(
      /xterm-cursor-pointer/
    )
    await expect(httpsText).toHaveCSS('text-decoration-line', 'underline')

    await page.mouse.click(httpsPoint.x, httpsPoint.y)
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await page.keyboard.down('Meta')
    await page.mouse.click(httpsPoint.x, httpsPoint.y)
    await page.keyboard.up('Meta')
    expect(
      await page.evaluate(() => (window as any).__openedTerminalLinks)
    ).toEqual([])

    await page.keyboard.down('Control')
    await page.mouse.click(httpsPoint.x, httpsPoint.y)
    await page.keyboard.up('Control')
    const httpText = page
      .locator('.xterm-rows span')
      .filter({ hasText: 'http://example.test/help' })
      .last()
    await expect(httpText).toBeVisible()
    const httpPoint = await terminalTextPoint(httpText, { x: 16, y: 8 })
    await page.mouse.move(httpPoint.x, httpPoint.y)
    await page.keyboard.down('Control')
    await page.mouse.click(httpPoint.x, httpPoint.y)
    await page.keyboard.up('Control')
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
    const linkedPoint = await terminalTextPoint(linkedText, { x: 8, y: 8 })
    await page.keyboard.down('Meta')
    await page.mouse.click(linkedPoint.x, linkedPoint.y)
    await page.keyboard.up('Meta')
    await expect
      .poll(() => page.evaluate(() => (window as any).__openedTerminalLink))
      .toEqual(['https://example.test/pr/123', '_blank', 'noopener,noreferrer'])
  })

  test('opens OSC 8 file links with the default desktop app on Cmd-click', async ({
    page
  }) => {
    await mockApp(page, [], {
      desktopBridge: true,
      keyboardPlatform: 'MacIntel'
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
          data: '\x1b]8;;file:///Users/example/project/readme%20draft.md\x1b\\readme draft.md\x1b]8;;\x1b\\\r\n'
        })
      })
    })

    const linkedText = page
      .locator('.xterm-rows span')
      .filter({ hasText: 'readme draft.md' })
      .last()
    await expect(linkedText).toBeVisible()
    const linkedPoint = await terminalTextPoint(linkedText, { x: 8, y: 8 })
    await page.mouse.click(linkedPoint.x, linkedPoint.y)
    expect(
      await page.evaluate(() => (window as any).__openedDesktopFileUrls)
    ).toEqual([])

    await page.keyboard.down('Meta')
    await page.mouse.click(linkedPoint.x, linkedPoint.y)
    await page.keyboard.up('Meta')
    await expect
      .poll(() => page.evaluate(() => (window as any).__openedDesktopFileUrls))
      .toEqual(['file:///Users/example/project/readme%20draft.md'])
  })

  test('synchronizes fallback, runtime, and cleared titles across every desktop consumer', async ({
    page
  }) => {
    await mockApp(page, [
      {
        terminalId: 'term_pi',
        title: null,
        hasForegroundProcess: true,
        progress: null,
        progressStartedAt: null,
        progressClearedAt: null,
        bell: null
      }
    ])
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

  test('reconciles terminal metadata in chronological order', async ({
    page
  }) => {
    const mocked = await mockApp(page, [
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
    await expect(page.getByText('example')).toBeVisible()
    await expect(
      page.getByRole('button', { name: /background · \/repo.*75% complete/ })
    ).toBeVisible()
    await expect.poll(() => mocked.projectRequests()).toBeGreaterThan(1)
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
      page.getByRole('button', { name: /background · \/repo.*75% complete/ })
    ).toHaveCount(0)
  })

  test('creates worktrees with focus, rollback, retry, and preset snapshots', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    {
      const trigger = page.getByRole('button', { name: 'New worktree' })
      await trigger.click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog.getByLabel('Worktree name')).toBeFocused()
      await dialog.getByLabel('Worktree name').fill('focus-test')
      const submit = dialog.getByRole('button', { name: 'Create worktree' })
      await expect(submit).toBeEnabled()
      await submit.focus()
      await submit.press('Tab')
      await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(trigger).toBeFocused()
    }
    {
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
    }
    {
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
        initialTerminal: { name: 'Shell' }
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
    }
    {
      await page.getByRole('button', { name: 'New worktree' }).click()
      await page.getByLabel('Worktree name').fill('preset topic')
      await page.getByLabel('Initial terminal').selectOption({ label: 'Hunk' })
      await expect(
        page.getByText('Destination: /worktrees/preset-topic/repo')
      ).toBeVisible()
      const requestPromise = page.waitForRequest(
        (request) =>
          request.method() === 'POST' &&
          new URL(request.url()).pathname === '/api/projects/proj_1/worktrees'
      )
      await page.getByRole('button', { name: 'Create worktree' }).click()
      expect((await requestPromise).postDataJSON()).toEqual({
        name: 'preset topic',
        base: 'default',
        initialTerminal: expect.objectContaining({
          name: 'Hunk',
          returnToShell: true
        })
      })
    }
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

  test('broadcasts canonical dimensions and controller takeover across two viewers', async ({
    context,
    page
  }) => {
    const viewer = await context.newPage()
    await mockApp(page)
    await mockApp(viewer)
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await viewer
      .getByRole('button', { name: 'Pi, running', exact: true })
      .click()

    await page.getByRole('button', { name: 'Take control' }).click()
    await expect(
      page.getByRole('button', { name: 'Take control' })
    ).toHaveCount(0)
    await expect(
      viewer.getByRole('button', { name: 'Take control' })
    ).toBeVisible()
    await page.waitForTimeout(250)
    const beforeControllerResize = await page.evaluate(() =>
      JSON.parse(
        localStorage.getItem('__tasktty_terminal_state__:term_pi') || '{}'
      )
    )
    await page.setViewportSize({ width: 1_100, height: 720 })
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(
              localStorage.getItem('__tasktty_terminal_state__:term_pi') || '{}'
            ).revision
        )
      )
      .toBeGreaterThan(beforeControllerResize.revision)
    const afterControllerResize = await page.evaluate(() =>
      JSON.parse(
        localStorage.getItem('__tasktty_terminal_state__:term_pi') || '{}'
      )
    )
    const viewerSocketState = await viewer.evaluate(() => {
      const socket = (window as any).__lastWs
      return {
        cols: socket.cols,
        rows: socket.rows,
        revision: socket.revision
      }
    })
    expect(viewerSocketState).toEqual({
      cols: afterControllerResize.cols,
      rows: afterControllerResize.rows,
      revision: afterControllerResize.revision
    })
    await expect
      .poll(() =>
        viewer.locator('.terminal-session-host').evaluate((element) => ({
          cols: Number((element as HTMLElement).dataset.terminalCols),
          rows: Number((element as HTMLElement).dataset.terminalRows),
          revision: Number((element as HTMLElement).dataset.terminalRevision)
        }))
      )
      .toEqual(viewerSocketState)

    await viewer.setViewportSize({ width: 760, height: 640 })
    await viewer.waitForTimeout(250)
    const afterViewerResize = await page.evaluate(() =>
      JSON.parse(
        localStorage.getItem('__tasktty_terminal_state__:term_pi') || '{}'
      )
    )
    expect(afterViewerResize).toEqual(afterControllerResize)

    await viewer.getByRole('button', { name: 'Take control' }).click()
    await expect(
      viewer.getByRole('button', { name: 'Take control' })
    ).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'Take control' })
    ).toBeVisible()
    const takeoverState = await viewer.evaluate(() => {
      const socket = (window as any).__lastWs
      return {
        state: JSON.parse(
          localStorage.getItem('__tasktty_terminal_state__:term_pi') || '{}'
        ),
        clientId: socket.clientId
      }
    })
    expect(takeoverState.state.controllerClientId).toBe(takeoverState.clientId)
    expect(takeoverState.state.generation).toBeGreaterThan(
      afterViewerResize.generation
    )

    await viewer.setViewportSize({ width: 980, height: 700 })
    await expect
      .poll(() =>
        viewer.evaluate(
          () =>
            JSON.parse(
              localStorage.getItem('__tasktty_terminal_state__:term_pi') || '{}'
            ).revision
        )
      )
      .toBeGreaterThan(takeoverState.state.revision)
    const finalState = await viewer.evaluate(() =>
      JSON.parse(
        localStorage.getItem('__tasktty_terminal_state__:term_pi') || '{}'
      )
    )
    for (const target of [page, viewer]) {
      const expectedGrid = {
        cols: finalState.cols,
        rows: finalState.rows,
        revision: finalState.revision
      }
      await expect
        .poll(() =>
          target.evaluate(() => {
            const socket = (window as any).__lastWs
            return {
              cols: socket.cols,
              rows: socket.rows,
              revision: socket.revision
            }
          })
        )
        .toEqual(expectedGrid)
      await expect
        .poll(() =>
          target.locator('.terminal-session-host').evaluate((element) => ({
            cols: Number((element as HTMLElement).dataset.terminalCols),
            rows: Number((element as HTMLElement).dataset.terminalRows),
            revision: Number((element as HTMLElement).dataset.terminalRevision)
          }))
        )
        .toEqual(expectedGrid)
    }
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

  test('distinguishes durable daemon BEL from foreground xterm BEL', async ({
    page
  }) => {
    const bellMetadata = {
      terminalId: 'term_pi',
      title: 'zsh · /worktrees/topic',
      progress: null,
      progressStartedAt: null,
      progressClearedAt: null,
      bell: {
        sequence: 4,
        at: '2026-01-01T00:02:00.000Z',
        unread: true
      }
    } satisfies TerminalRuntimeMetadata
    await mockApp(page, [bellMetadata])

    const piTreeRow = page.getByRole('button', {
      name: /zsh · \/worktrees\/topic.*bell/
    })
    await expect(piTreeRow).toBeVisible()
    await page.reload()
    await expect(piTreeRow).toBeVisible()

    const acknowledgement = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname ===
          '/api/terminals/term_pi/bell/acknowledge'
    )
    await piTreeRow.click()
    const request = await acknowledgement
    expect(request.postDataJSON()).toEqual({ sequence: 4 })
    await expect(piTreeRow).toBeVisible()

    await page.evaluate(() =>
      (window as any).__eventSource.emit(
        'terminal.metadata',
        JSON.stringify({
          data: {
            terminalId: 'term_pi',
            title: 'zsh · /worktrees/topic',
            progress: null,
            progressStartedAt: null,
            progressClearedAt: null,
            bell: {
              sequence: 4,
              at: '2026-01-01T00:02:00.000Z',
              unread: false
            }
          }
        })
      )
    )
    await expect(
      page.getByRole('button', { name: /zsh · \/worktrees\/topic.*bell/ })
    ).toHaveCount(0)
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

    await expect(page.locator('.terminal-shell')).toHaveClass(/terminal-bell/)
    await expect(
      page.getByRole('button', { name: /zsh · \/worktrees\/topic.*bell/ })
    ).toHaveCount(0)
  })

  test('manages global terminal presets without a selected worktree', async ({
    page
  }) => {
    await mockApp(page, [], { worktreeFree: true })
    const trigger = page.getByRole('button', { name: 'New terminal' })
    await expect(trigger).toBeEnabled()
    await trigger.click()
    await expect(page.getByRole('menuitem', { name: 'Shell' })).toHaveAttribute(
      'data-disabled',
      ''
    )
    await page.getByRole('menuitem', { name: 'Manage presets' }).click()
    const dialog = page.getByRole('dialog', { name: 'Terminal presets' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'New' })).toBeVisible()
    await expect(
      dialog.getByRole('button', { name: 'Delete Shell' })
    ).toHaveCount(0)

    await dialog.getByLabel('Name').fill('Review tool')
    await dialog.getByLabel('Command').fill('npx "semi;$HOME" --yes')
    const createRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/terminal-presets'
    )
    await dialog.getByRole('button', { name: 'Create preset' }).click()
    expect((await createRequest).postDataJSON()).toEqual({
      name: 'Review tool',
      executable: 'npx',
      args: ['semi;$HOME', '--yes']
    })
    const presetRow = dialog.getByRole('button', { name: /^Review tool/ })
    await expect(presetRow).toBeVisible()
    await presetRow.click()

    await dialog.getByLabel('Name').fill('Review updated')
    await dialog.getByLabel('Command').fill('npx "semi;$HOME"')
    const updateRequest = page.waitForRequest(
      (request) =>
        request.method() === 'PATCH' &&
        new URL(request.url()).pathname === '/api/terminal-presets/preset_2'
    )
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    expect((await updateRequest).postDataJSON()).toEqual({
      name: 'Review updated',
      executable: 'npx',
      args: ['semi;$HOME'],
      expectedUpdatedAt: '2026-01-02T00:00:00.000Z'
    })

    page.once('dialog', (confirmation) => confirmation.accept())
    const deleteRequest = page.waitForRequest(
      (request) =>
        request.method() === 'DELETE' &&
        new URL(request.url()).pathname === '/api/terminal-presets/preset_2'
    )
    await dialog.getByRole('button', { name: 'Delete Review updated' }).click()
    expect((await deleteRequest).postDataJSON()).toEqual({
      expectedUpdatedAt: '2026-01-03T00:00:00.000Z'
    })
    await expect(
      dialog.getByRole('button', { name: /^Review updated/ })
    ).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'New terminal' })
    ).toBeFocused()
  })
  test('launches Shell and a configured terminal preset', async ({ page }) => {
    await mockApp(page, [
      {
        terminalId: 'term_dev',
        title: null,
        hasForegroundProcess: false,
        progress: null,
        progressStartedAt: null,
        progressClearedAt: null,
        bell: null
      }
    ])
    await page.locator('.worktree-row').filter({ hasText: 'topic' }).click()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await expect(
      page.getByRole('button', { name: 'Terminal', exact: true })
    ).toHaveCount(0)
    const requestPromise = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/worktrees/wt_topic/terminals'
    )
    await page.getByRole('button', { name: 'New terminal' }).click()
    await page.getByRole('menuitem', { name: 'Shell' }).click()
    const request = await requestPromise
    expect(request.postDataJSON()).toEqual({ name: 'Shell' })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.terminal-row.selected')).toBeVisible()

    await expect(
      page.getByRole('tab', { name: /^dev · \/worktrees\/topic,/ })
    ).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    const socketsBeforeSwitch = await page.evaluate(
      () => (window as any).__wsInstances.length
    )
    const zshTab = page.getByRole('tab', {
      name: /^zsh · \/worktrees\/topic,/
    })
    await zshTab.click()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await zshTab.click()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await expect
      .poll(() => page.evaluate(() => (window as any).__wsInstances.length))
      .toBe(socketsBeforeSwitch)
    await expect(
      page.getByRole('tab', { name: /^dev · \/worktrees\/topic,/ })
    ).toBeVisible()

    const terminalId = 'term_dev'
    let confirmationShown = false
    page.once('dialog', (dialog) => {
      confirmationShown = true
      void dialog.accept()
    })
    const closeRequest = page.waitForRequest(
      (request) =>
        request.method() === 'DELETE' &&
        new URL(request.url()).pathname === `/api/terminals/${terminalId}`
    )
    await page
      .getByRole('button', { name: /^Close dev · \/worktrees\/topic$/ })
      .click()
    await closeRequest
    expect(confirmationShown).toBe(false)
    await expect(
      page.getByRole('tab', { name: /^dev · \/worktrees\/topic,/ })
    ).toHaveCount(0)
    const presetRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/worktrees/wt_topic/terminals'
    )
    await page.getByRole('button', { name: 'New terminal' }).click()
    const presetItem = page.getByRole('menuitem', { name: 'Hunk', exact: true })
    await expect(presetItem).not.toContainText('npx')
    await presetItem.click()
    const presetRequest = await presetRequestPromise
    expect(presetRequest.postDataJSON()).toEqual({
      name: 'Hunk',
      argv: ['npx', '--yes', 'hunkdiff@0.17.3', 'diff', 'HEAD', '--watch'],
      returnToShell: true
    })
    await expect(page.locator('.terminal-row.selected')).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
  })

  test('confirms before closing a terminal with a foreground process', async ({
    page
  }) => {
    await mockApp(page, [
      {
        terminalId: 'term_pi',
        title: null,
        hasForegroundProcess: true,
        progress: null,
        progressStartedAt: null,
        progressClearedAt: null,
        bell: null
      }
    ])
    await page.locator('.worktree-row').filter({ hasText: 'topic' }).click()
    const closeButton = page.getByRole('button', {
      name: /^Close zsh · \/worktrees\/topic$/
    })
    await expect(closeButton).toBeVisible()

    let confirmationShown = false
    page.once('dialog', async (dialog) => {
      confirmationShown = true
      await dialog.dismiss()
    })
    await closeButton.click()
    expect(confirmationShown).toBe(true)
    await expect(closeButton).toBeVisible()

    page.once('dialog', (dialog) => dialog.accept())
    const closeRequest = page.waitForRequest(
      (request) =>
        request.method() === 'DELETE' &&
        new URL(request.url()).pathname === '/api/terminals/term_pi'
    )
    await closeButton.click()
    await closeRequest
    await expect(closeButton).toHaveCount(0)
    await expect(page).toHaveURL(/\/projects\/proj_1\/worktrees\/wt_topic$/)
  })

  test('handles Electron terminal commands through the existing tab flows', async ({
    page
  }) => {
    const mocked = await mockApp(page, [], { desktopBridge: true })
    const desktopTitlebar = page.locator('[data-tasktty-desktop-titlebar]')
    await expect(desktopTitlebar).toBeVisible()
    await page.evaluate(() => (window as any).__dispatchDesktopFullscreen(true))
    await expect(desktopTitlebar).toHaveCount(0)
    await page.evaluate(() =>
      (window as any).__dispatchDesktopFullscreen(false)
    )
    await expect(desktopTitlebar).toBeVisible()
    await page.locator('.worktree-row').filter({ hasText: 'topic' }).click()

    const releaseCreate = mocked.delayNextTerminalCreate()
    const createRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/worktrees/wt_topic/terminals'
    )
    await page.evaluate(() =>
      (window as any).__dispatchDesktopCommand('new-terminal')
    )
    expect((await createRequest).postDataJSON()).toEqual({ name: 'Shell' })
    await page.evaluate(() =>
      (window as any).__dispatchDesktopCommand('new-terminal')
    )
    await expect.poll(() => mocked.terminalCreations()).toBe(1)
    releaseCreate()

    await expect(
      page.getByRole('tab', { name: /^dev · \/worktrees\/topic,/ })
    ).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    const closeRequest = page.waitForRequest(
      (request) =>
        request.method() === 'DELETE' &&
        new URL(request.url()).pathname === '/api/terminals/term_dev'
    )
    await page.evaluate(() =>
      (window as any).__dispatchDesktopCommand('close-terminal')
    )
    await closeRequest
    await expect(
      page.getByRole('tab', { name: /^dev · \/worktrees\/topic,/ })
    ).toHaveCount(0)
    await expect(
      page.getByRole('tab', { name: /^zsh · \/worktrees\/topic,/ })
    ).toHaveAttribute('data-state', 'active')
    await expect(page).toHaveURL(
      /\/projects\/proj_1\/worktrees\/wt_topic\/terminals\/term_pi$/
    )
  })

  test('reconciles remote preset edits and deletion', async ({ page }) => {
    await page.clock.install()
    const mocked = await mockApp(page)
    await page.getByRole('button', { name: 'New terminal' }).click()
    await page.getByRole('menuitem', { name: 'Manage presets' }).click()
    const dialog = page.getByRole('dialog', { name: 'Terminal presets' })
    await dialog.getByRole('button', { name: /^Hunk/ }).click()
    await dialog.getByLabel('Name').fill('Unsaved local name')
    mocked.terminalPresets[0] = {
      ...mocked.terminalPresets[0]!,
      name: 'Remote Hunk',
      updatedAt: '2026-02-01T00:00:00.000Z'
    }
    await page.clock.fastForward(5_000)
    await expect(dialog.getByLabel('Name')).toHaveValue('Remote Hunk')
    await expect(dialog.getByRole('status')).toContainText(
      'latest saved values were loaded'
    )
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()

    await page.getByRole('button', { name: 'New worktree' }).click()
    await page
      .getByLabel('Initial terminal')
      .selectOption({ label: 'Remote Hunk' })
    mocked.terminalPresets.splice(0)
    await page.clock.fastForward(5_000)
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'selected preset was deleted' })
    ).toBeVisible()
    await expect(page.getByLabel('Initial terminal')).toHaveValue('shell')
  })
  test('preserves modified terminal keys used by macOS and Pi', async ({
    page
  }) => {
    await mockApp(page, [], { keyboardPlatform: 'MacIntel' })
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await page.getByRole('button', { name: 'Take control' }).click()
    await page.locator('.xterm-helper-textarea').focus()
    await page.evaluate(() => {
      ;(window as any).__wsSent = []
    })

    await page.keyboard.press('Shift+Enter')
    await page.keyboard.press('Meta+ArrowLeft')
    await page.keyboard.press('Meta+ArrowRight')
    await page.keyboard.press('Alt+ArrowLeft')
    await page.keyboard.press('Alt+ArrowRight')

    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__wsSent
            .filter((message: any) => message.type === 'input')
            .map((message: any) => message.data)
        )
      )
      .toEqual(['\u001b[13;2u', '\u001b[H', '\u001b[F', '\u001bb', '\u001bf'])
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

  test('selects with Mac Option-drag and forwards application wheel events', async ({
    page
  }) => {
    await mockApp(page, [], { keyboardPlatform: 'MacIntel' })
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
    await page.keyboard.down('Alt')
    await page.mouse.down()
    await page.mouse.move(bounds!.x + 160, bounds!.y + 8, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.up('Alt')

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

    await page.reload()
    await expect(page.locator('.xterm')).toBeVisible()
    const takeControl = page.getByRole('button', { name: 'Take control' })
    if ((await takeControl.count()) > 0) {
      await takeControl.click()
    }

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
    const wheelSent = await page.evaluate(() => (window as any).__wsSent)
    expect(wheelSent.some((message: any) => message.data === '\u001b[A')).toBe(
      false
    )
    expect(
      wheelSent.some((message: any) =>
        String(message.data).includes('\u001b[<')
      )
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

  test('uses one removal action, live preview state, and places New worktree last', async ({
    page
  }) => {
    const mocked = await mockApp(page)
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
})

test.describe('mobile terminal UI', () => {
  test.skip(({ isMobile }) => !isMobile)

  test('uses the mobile drawer and terminal controls end to end', async ({
    page
  }) => {
    await mockApp(page, [
      {
        terminalId: 'term_pi',
        title: 'background · /repo',
        progress: { state: 'normal', value: 42 }
      }
    ])
    const drawer = page.locator('.sidebar')
    const trigger = page.getByLabel('Open worktree drawer')
    await expect(drawer).toHaveAttribute('inert', '')
    await trigger.click()
    await expect(drawer).toHaveClass(/open/)
    await expect(drawer).not.toHaveAttribute('inert', '')
    await expect(page.getByLabel('Close drawer')).toBeFocused()
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
      page.getByRole('button', { name: 'background · /repo, running' })
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveAttribute('inert', '')
    await expect(trigger).toBeFocused()

    await trigger.click()
    await page
      .getByRole('button', { name: 'background · /repo, running', exact: true })
      .click()
    await expect(page.locator('.xterm')).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
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
    await page.getByRole('button', { name: 'Arrow up' }).click()
    await expect
      .poll(() => page.evaluate(() => (window as any).__wsSent))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'input', data: '\u001b' }),
          expect.objectContaining({ type: 'input', data: '\u001bOA' })
        ])
      )

    await page.setViewportSize({ width: 320, height: 700 })
    const accessoryRow = page.locator('.accessory-row')
    const ctrl = page.getByRole('button', { name: 'Ctrl', exact: true })
    const alt = page.getByRole('button', { name: 'Alt', exact: true })
    const shiftTab = page.getByRole('button', {
      name: 'Shift+Tab',
      exact: true
    })
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
    await shiftTab.scrollIntoViewIfNeeded()
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

    await page.setViewportSize({ width: 412, height: 915 })
    const presetRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/worktrees/wt_topic/terminals'
    )
    await page.getByRole('button', { name: 'New terminal' }).click()
    await page.getByRole('menuitem', { name: 'Hunk' }).click()
    expect((await presetRequest).postDataJSON()).toMatchObject({ name: 'Hunk' })
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    await trigger.click()
    await page
      .getByRole('button', { name: 'Switch project, current project example' })
      .click()
    await expect(page.getByLabel('Search projects')).not.toBeFocused()
    const close = page.getByRole('button', { name: 'Close project example' })
    await expect(close).toBeVisible()
    await expect(close).toHaveCSS('opacity', '1')
    page.once('dialog', (dialog) => dialog.accept())
    await close.click()
    await expect(
      page.getByRole('button', { name: 'Open project' })
    ).toBeVisible()
  })

  test('keeps mobile modal and drawer accessibility state coherent', async ({
    page
  }) => {
    const mocked = await mockApp(page)
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

    mocked.failNextCreate()
    await page.getByLabel('Open worktree drawer').click()
    await trigger.click()
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

    await page.clock.install()
    await page.evaluate(() => (window as any).__eventSource.disconnect())
    await page.clock.fastForward(3_000)
    const status = page.locator('[role="status"]')
    await expect(status).toBeVisible()
    await page.getByLabel('Open worktree drawer').click()
    await expect(status).toHaveAttribute('inert', '')
    await expect(status).toHaveAttribute('aria-hidden', 'true')
  })

  test('scrolls tmux history with a one-finger swipe across mouse modes', async ({
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
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: []
    })

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

    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: positions[2]! }]
    })
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: positions[3]! }]
    })
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
})
