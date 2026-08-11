import { expect, type Locator, type Page } from '@playwright/test'
import {
  type OperationRecord,
  type ProjectColor,
  type RecentProjectRecord,
  type RemovePreview,
  type RepositoryTerminalPresetDiagnostic,
  type TerminalPreset,
  type TerminalPresetDefinition,
  type TerminalRuntimeMetadata
} from '@treeport/shared'

export async function terminalTextPoint(
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

export async function openWorktreeContextMenu(
  page: Page,
  worktreeName: string
) {
  await page
    .getByRole('button', { name: new RegExp(`^${worktreeName}(?:,|\\s|$)`) })
    .click({ button: 'right' })
  return page.getByRole('menu')
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
      prunable: false,
      kind: 'main',
      tmuxSocketName: 'treeport-wt-main',
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
      panels: [],
      terminals: [
        {
          id: 'term_shell',
          worktreeId: 'wt_main',
          name: 'Shell',
          tmuxSessionName: 'treeport-term-shell',
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
      prunable: false,
      kind: 'linked',
      tmuxSocketName: 'treeport-wt-topic',
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
      panels: [],
      terminals: [
        {
          id: 'term_pi',
          worktreeId: 'wt_topic',
          name: 'Pi',
          tmuxSessionName: 'treeport-term-pi',
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

export async function mockApp(
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
    transientProjectFailures?: number
    repositoryTerminalPresets?: TerminalPresetDefinition[]
    repositoryPresetDiagnostics?: RepositoryTerminalPresetDiagnostic[]
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
      type DesktopCommand =
        | 'new-worktree'
        | 'new-terminal'
        | 'new-panel'
        | 'close-panel'
      const listeners = new Set<(command: DesktopCommand) => void>()
      const terminalSelectionReleaseListeners = new Set<() => void>()
      let fullscreenListener: ((fullscreen: boolean) => void) | null = null
      scope.__attentionRequests = 0
      scope.__openedDesktopFileUrls = []
      scope.treeportDesktop = Object.freeze({
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
        onCommand(next: (command: DesktopCommand) => void) {
          listeners.add(next)
          return () => listeners.delete(next)
        },
        setTerminalSelectionActive() {},
        onTerminalSelectionRelease(next: () => void) {
          terminalSelectionReleaseListeners.add(next)
          return () => terminalSelectionReleaseListeners.delete(next)
        },
        requestAttention() {
          scope.__attentionRequests += 1
        }
      })
      scope.__dispatchDesktopCommand = (command: DesktopCommand) =>
        listeners.forEach((listener) => listener(command))
      scope.__dispatchTerminalSelectionRelease = () =>
        terminalSelectionReleaseListeners.forEach((listener) => listener())
      scope.__dispatchDesktopFullscreen = (fullscreen: boolean) =>
        fullscreenListener?.(fullscreen)
    })
  }

  await page.addInitScript((initialMetadata) => {
    const terminalStatePrefix = '__treeport_terminal_state__:'
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
                this.deliverSocket('snapshot', { webPanels: [], ...value })
                return
              }

              const data = value?.data ?? value
              const event = value?.type
                ? value
                : {
                    id: crypto.randomUUID(),
                    type: name,
                    at: new Date().toISOString(),
                    data: {
                      ...data,
                      worktreeId: data.worktreeId ?? null
                    }
                  }
              this.deliverSocket('product_event', event)
            }
          }
          this.deliverSocket('snapshot', {
            at: new Date().toISOString(),
            terminalMetadata: initialMetadata,
            webPanels: []
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
                ? '[Treeport setup] bootstrap\\r\\nSETUP_OUTPUT\\r\\n[Treeport setup] bootstrap complete\\r\\nSHELL_READY\\r\\n'
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
          const applyTerminalUpdate = () => {
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
          if (type === 'take_control' && scope.__delayTakeControl) {
            scope.__releaseTakeControl = () => {
              scope.__delayTakeControl = false
              scope.__releaseTakeControl = null
              applyTerminalUpdate()
            }
          } else {
            applyTerminalUpdate()
          }
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
  const repositoryTerminalPresets = [
    ...(options.repositoryTerminalPresets ?? [])
  ]
  const repositoryPresetDiagnostics = [
    ...(options.repositoryPresetDiagnostics ?? [])
  ]
  const terminalPresets: TerminalPreset[] = [
    {
      id: 'preset_hunk',
      name: 'Hunk',
      executable: 'npx',
      args: ['--yes', 'hunkdiff@0.17.3', 'diff', 'HEAD', '--watch'],
      closeOnSuccess: false,
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
  let transientProjectFailures = options.transientProjectFailures ?? 0
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
  let removePreviewRequests = 0
  let removePreviewDelayMs = 0
  let removePreviewOverride: Partial<RemovePreview> = {}
  let fileUploadRequests = 0
  let terminalCreations = 0
  let terminalCreateGate: Promise<void> | null = null
  let releaseTerminalCreate: (() => void) | null = null
  let failTerminalCreate = false
  let failTerminalCreateWithGateway = false
  let failTerminalCreateWithNetwork = false
  let terminalDeleteGate: Promise<void> | null = null
  let releaseTerminalDelete: (() => void) | null = null
  let failTerminalDelete = false
  let webPanelCreations = 0
  let webPanelHasStorage = false
  const webPanelStorage = new Map<string, Map<string, unknown>>()
  const webPanelDefinitions = [
    {
      id: 'package:npm:@treeport/web-panel-browser:web-panel:browser',
      title: 'Browser',
      source: {
        type: 'package' as const,
        packageId: 'npm:@treeport/web-panel-browser',
        source: 'npm:@treeport/web-panel-browser',
        scope: 'global' as const
      },
      sandbox: { allowSameOrigin: true }
    },
    {
      id: 'project:review',
      title: 'Review',
      source: { type: 'project' as const },
      sandbox: { allowSameOrigin: false }
    }
  ]
  let staleRemovePreview: Partial<RemovePreview> | null = null
  let removeRequests = 0
  const removeRequestBodies: unknown[] = []
  let removeGate: Promise<void> | null = null
  let releaseRemove: (() => void) | null = null
  let createGate: Promise<void> | null = null
  let releaseCreate: (() => void) | null = null
  let failCreate = false
  let creationSequence = 0
  const creationOperations = new Map<string, OperationRecord>()
  let removeOperation: OperationRecord | null = null
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const pathname = url.pathname
    if (
      pathname === '/api/terminal-preset-definitions' &&
      route.request().method() === 'GET'
    ) {
      await route.fulfill({
        json: {
          definitions: [
            ...(url.searchParams.has('worktreeId')
              ? repositoryTerminalPresets
              : []),
            ...terminalPresets.map((preset) => ({
              id: preset.id,
              name: preset.name,
              executable: preset.executable,
              args: preset.args,
              closeOnSuccess: preset.closeOnSuccess,
              source: { type: 'user' as const }
            }))
          ],
          diagnostics: url.searchParams.has('worktreeId')
            ? repositoryPresetDiagnostics
            : []
        }
      })
      return
    }

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
        'name' | 'executable' | 'args' | 'closeOnSuccess'
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
        'name' | 'executable' | 'args' | 'closeOnSuccess'
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
      const exactPaths: Record<string, string[]> = {
        '~': ['Projects'],
        '/home/test': ['Projects'],
        '/home/test/Projects': ['example'],
        '/repo': ['src']
      }
      const exact = input in exactPaths
      const partialProjects = input === '/home/test/Pro'
      const directoryPath = partialProjects
        ? '/home/test'
        : input === '~'
          ? '/home/test'
          : input
      const entryNames = partialProjects
        ? ['Projects']
        : [...(exactPaths[input] ?? []), ...(showHidden ? ['.hidden'] : [])]
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
      if (transientProjectFailures > 0) {
        transientProjectFailures -= 1
        await route.fulfill({
          status: 503,
          json: { error: { code: 'UNAVAILABLE', message: 'Try again later' } }
        })
        return
      }

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
      registeredProjectPaths.push(
        (route.request().postDataJSON() as { path: string }).path
      )
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

    if (pathname === '/api/operations' && route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          operations: [
            ...creationOperations.values(),
            ...(removeOperation ? [removeOperation] : [])
          ].filter(
            (operation) =>
              operation.status === 'pending' || operation.status === 'running'
          )
        }
      })
      return
    }

    const operationMatch = pathname.match(/^\/api\/operations\/([^/]+)$/)
    if (operationMatch && route.request().method() === 'GET') {
      await route.fulfill({
        json: { operation: creationOperations.get(operationMatch[1]!) }
      })
      return
    }

    if (
      pathname === '/api/projects/proj_1/worktree-operations' &&
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
      const operation: OperationRecord = {
        id: `op_create_${++creationSequence}`,
        kind: 'create',
        projectId: 'proj_1',
        worktreeId: null,
        status: 'pending',
        request: body,
        result: null,
        error: null,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01'
      }
      creationOperations.set(operation.id, operation)
      await route.fulfill({ status: 202, json: { operation } })

      void (async () => {
        operation.status = 'running'

        if (createGate) {
          await createGate
        }

        createGate = null
        releaseCreate = null

        if (failCreate) {
          failCreate = false
          operation.status = 'failed'
          operation.error = 'create failed'
          return
        }

        const canonicalName = body.name.trim().replace(/\s+/g, '-')
        const terminal = {
          id: 'term_new',
          worktreeId: 'wt_new',
          name: body.initialTerminal?.name ?? 'Shell',
          tmuxSessionName: 'treeport-term-new',
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
          terminals: [terminal],
          panels: []
        }
        const existingIndex = state.worktrees.findIndex(
          (item) => item.id === worktree.id
        )
        if (existingIndex >= 0) {
          state.worktrees[existingIndex] = worktree
        } else {
          state.worktrees.push(worktree)
        }

        operation.status = 'completed'
        operation.worktreeId = worktree.id
        operation.result = {
          worktreeId: worktree.id,
          terminalId: terminal.id,
          terminalError: null,
          setupError: null
        }
      })()
      return
    }

    if (
      /^\/api\/web-panels\/[^/]+\/assets\/$/.test(pathname) &&
      route.request().method() === 'GET'
    ) {
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><body>
          <form><input type="url" aria-label="Application URL" value="http://localhost:3000/" required></form>
          <div role="alert" hidden><strong>Load failed</strong><span>Check that the application is running and reachable.</span></div>
          <iframe title="Browser target" src="about:blank"></iframe>
          <script>
            const pending = new Map(); let serial = 0;
            const call = (method, values = {}) => new Promise((resolve, reject) => {
              const id = String(++serial); pending.set(id, { resolve, reject });
              parent.postMessage({ source: 'treeport-panel-v1', id, method, ...values }, '*');
            });
            const frame = document.querySelector('iframe');
            addEventListener('message', (event) => {
              if (event.source === parent && event.data?.source === 'treeport-host-v1' && event.data.id) {
                const request = pending.get(event.data.id); if (!request) return;
                pending.delete(event.data.id);
                event.data.ok ? request.resolve(event.data.value) : request.reject(new Error(event.data.error));
                return;
              }
              if (event.source === frame.contentWindow && event.data?.source === 'treeport-panel-v1' && event.data.method === 'panel.title.set') {
                parent.postMessage(event.data, '*');
              }
            });
            Promise.all([call('context'), call('storage.get', { key: 'browser-state' })]).then(([context, stored]) => {
              const input = document.querySelector('input');
              const failure = document.querySelector('[role="alert"]');
              const navigate = (url) => {
                failure.hidden = true;
                fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' }).then(
                  () => { frame.src = url; },
                  () => { failure.hidden = false; }
                );
              };
              const url = stored?.url || context.launch.input?.url || '';
              if (url) input.value = url;
              if (url) navigate(url);
              if (url) parent.postMessage({ source: 'treeport-panel-v1', method: 'panel.title.set', title: context.launch.input?.title || new URL(url).host }, '*');
              document.querySelector('form').addEventListener('submit', (event) => {
                event.preventDefault();
                const url = new URL(input.value).href;
                call('storage.set', { key: 'browser-state', value: { url, launchUpdatedAt: context.panel.updatedAt } }).then(() => {
                  navigate(url);
                  parent.postMessage({ source: 'treeport-panel-v1', method: 'panel.title.set', title: new URL(url).host }, '*');
                });
              });
            });
          </script>
        </body></html>`
      })
      return
    }

    if (
      /^\/api\/worktrees\/[^/]+\/web-panel-definitions$/.test(pathname) &&
      route.request().method() === 'GET'
    ) {
      await route.fulfill({ json: { definitions: webPanelDefinitions } })
      return
    }

    if (
      /^\/api\/worktrees\/[^/]+\/panels$/.test(pathname) &&
      route.request().method() === 'POST'
    ) {
      const worktreeId = pathname.split('/')[3]!
      const body = route.request().postDataJSON() as {
        definitionId: string
        input?: { url?: string; title?: string } | null
        launchCwd?: string | null
      }
      const worktree = state.worktrees.find(
        (candidate) => candidate.id === worktreeId
      )!
      const definition = webPanelDefinitions.find(
        (candidate) => candidate.id === body.definitionId
      )!
      const panel = {
        id: `panel_${++webPanelCreations}`,
        kind: 'web' as const,
        worktreeId,
        definitionId: body.definitionId,
        title: definition.title,
        launch: {
          input: body.input ?? null,
          cwd: body.launchCwd ?? null
        },
        sandbox: definition.sandbox,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
      worktree.panels.push(panel)
      await route.fulfill({ status: 201, json: { panel } })
      return
    }

    if (
      /^\/api\/panels\/[^/]+\/context$/.test(pathname) &&
      route.request().method() === 'GET'
    ) {
      const panelId = pathname.split('/')[3]!
      const worktree = state.worktrees.find((candidate) =>
        candidate.panels.some((panel) => panel.id === panelId)
      )!
      const panel = worktree.panels.find(
        (candidate) => candidate.id === panelId
      )!
      await route.fulfill({
        json: {
          context: {
            apiVersion: 1,
            panel,
            launch: panel.launch,
            project: {
              id: state.id,
              name: state.name,
              defaultBranch: state.defaultBranch
            },
            worktree: {
              id: worktree.id,
              name: worktree.name,
              branch: worktree.branch,
              head: worktree.head
            }
          }
        }
      })
      return
    }

    if (
      /^\/api\/panels\/[^/]+\/launch$/.test(pathname) &&
      route.request().method() === 'PUT'
    ) {
      const panelId = pathname.split('/')[3]!
      const body = route.request().postDataJSON() as {
        input: { url?: string; title?: string } | null
        launchCwd: string | null
      }
      const panel = state.worktrees
        .flatMap((worktree) => worktree.panels)
        .find((candidate) => candidate.id === panelId)!

      panel.launch = { input: body.input, cwd: body.launchCwd }
      panel.updatedAt = new Date(
        Date.parse(panel.updatedAt) + 1_000
      ).toISOString()
      await route.fulfill({ json: { panel } })
      return
    }

    if (
      /^\/api\/panels\/[^/]+\/storage\/get$/.test(pathname) &&
      route.request().method() === 'POST'
    ) {
      const panelId = pathname.split('/')[3]!
      const body = route.request().postDataJSON() as { key: string }
      await route.fulfill({
        json: { value: webPanelStorage.get(panelId)?.get(body.key) }
      })
      return
    }

    if (
      /^\/api\/panels\/[^/]+\/storage$/.test(pathname) &&
      route.request().method() === 'PUT'
    ) {
      const panelId = pathname.split('/')[3]!
      const body = route.request().postDataJSON() as {
        key: string
        value: unknown
      }
      const storage = webPanelStorage.get(panelId) ?? new Map<string, unknown>()
      storage.set(body.key, body.value)
      webPanelStorage.set(panelId, storage)
      webPanelHasStorage = true
      await route.fulfill({ json: { ok: true } })
      return
    }

    if (
      /^\/api\/panels\/[^/]+\/storage$/.test(pathname) &&
      route.request().method() === 'GET'
    ) {
      await route.fulfill({ json: { hasData: webPanelHasStorage } })
      return
    }

    if (
      /^\/api\/panels\/[^/]+$/.test(pathname) &&
      route.request().method() === 'DELETE'
    ) {
      const panelId = pathname.split('/').at(-1)
      for (const worktree of state.worktrees) {
        worktree.panels = worktree.panels.filter(
          (panel) => panel.id !== panelId
        )
      }
      await route.fulfill({ json: { ok: true } })
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
        tmuxSessionName: 'treeport-term-dev',
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
      const worktree = state.worktrees[1]!
      removeOperation = {
        id: 'op_1',
        kind: 'remove',
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        status: 'pending',
        request: {
          confirmation: null,
          confirmationToken: 'a'.repeat(64),
          confirmDestructive: false,
          preview: {
            worktreeId: worktree.id,
            name: worktree.name,
            path: worktree.path,
            head: worktree.head,
            branch: worktree.branch,
            detached: worktree.detached,
            locked: worktree.locked,
            lockReason: worktree.lockReason,
            dirty: {
              dirty: false,
              staged: 0,
              unstaged: 0,
              untracked: 0,
              conflicts: 0,
              total: 0
            },
            detachedHeadReachable: true,
            forceRequired: false,
            eligible: true,
            reasons: [],
            warnings: [],
            terminals: [],
            confirmationToken: 'a'.repeat(64)
          },
          checkoutIdentity: null,
          prunable: false,
          gitWorktreeKey: 'worktrees/feature',
          repositoryIdentity: 'repository',
          phase: 'accepted',
          tmuxSocketName: worktree.tmuxSocketName,
          managedWrapperPath: worktree.managedWrapperPath
        },
        result: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      await route.fulfill({ status: 202, json: { operation: removeOperation } })
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
    repositoryTerminalPresets,
    repositoryPresetDiagnostics,
    recentProjects,
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
    removePreviewRequests: () => removePreviewRequests,
    fileUploadRequests: () => fileUploadRequests,
    terminalCreations: () => terminalCreations,
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
    },
    setWebPanelHasStorage: (value: boolean) => {
      webPanelHasStorage = value
    },
    setRemovePreview: (value: Partial<RemovePreview>) => {
      removePreviewOverride = value
    },
    setRemovePreviewDelay: (value: number) => {
      removePreviewDelayMs = value
    },
    removeRequests: () => removeRequests,
    removeRequestBodies: () => [...removeRequestBodies],
    completeRemoval: () => {
      const worktree = state.worktrees[1]
      if (worktree && removeOperation?.kind === 'remove') {
        state.worktrees.splice(1, 1)
        removeOperation = {
          ...removeOperation,
          worktreeId: null,
          status: 'completed',
          result: {
            removed: true,
            worktreeId: worktree.id,
            name: worktree.name,
            branchPreserved: worktree.branch,
            path: worktree.path,
            recovered: false,
            cleanup: {
              status: 'completed',
              residualPath: null,
              warning: null
            }
          },
          updatedAt: new Date().toISOString()
        }
      }
    },
    staleNextRemoveWithPreview: (value: Partial<RemovePreview>) => {
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

export async function waitForTerminalControl(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const terminalId = location.pathname.split('/').at(-1)
        const socket = [...((window as any).__wsInstances ?? [])]
          .reverse()
          .find(
            (candidate: any) =>
              candidate.namespace === '/terminals' &&
              candidate.terminalId === terminalId
          )
        const state = terminalId
          ? JSON.parse(
              localStorage.getItem(
                `__treeport_terminal_state__:${terminalId}`
              ) || '{}'
            )
          : null
        return Boolean(socket && state?.controllerClientId === socket.clientId)
      })
    )
    .toBe(true)
}

export async function requestTerminalControl(page: Page) {
  await page.locator('.xterm-screen').click({ position: { x: 4, y: 4 } })
  await waitForTerminalControl(page)
}
