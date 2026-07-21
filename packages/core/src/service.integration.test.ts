import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandRequest, CommandResult, CommandRunner } from './command.js'
import { TaskTTYDatabase } from './database.js'
import { GhAdapter } from './gh.js'
import { GitAdapter } from './git.js'
import { TaskTTYService } from './service.js'
import { TmuxAdapter } from './tmux.js'
import type { AppConfig } from './config.js'

const directories: string[] = []
const databases: TaskTTYDatabase[] = []
afterEach(async () => {
  databases.splice(0).forEach((database) => database.close())
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

interface FakeWorktree {
  path: string
  gitWorktreeKey: string
  head: string
  branch: string | null
  locked?: boolean
  prunable?: boolean
}

class SystemDouble implements CommandRunner {
  readonly calls: CommandRequest[] = []
  readonly worktrees: FakeWorktree[]
  readonly sessions = new Map<
    string,
    {
      alive: boolean
      exitCode: number | null
      created: number
      options: Record<string, string>
    }
  >()
  dirtyPaths = new Set<string>()
  dirtyStatuses = new Map<string, string>()
  reachable = true
  removeFails = false
  listWorktreesFails = false
  tmuxKillFails = false
  readonly tmuxKillFailureSockets = new Set<string>()
  statusGate: Promise<void> | null = null
  worktreeListGate: Promise<void> | null = null
  worktreeAddGate: Promise<void> | null = null
  tmuxCreateGate: Promise<void> | null = null
  setupGate: Promise<void> | null = null

  constructor(readonly main: string) {
    this.worktrees = [
      {
        path: main,
        gitWorktreeKey: path.join(main, '.git'),
        head: 'main-head',
        branch: 'trunk'
      }
    ]
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(structuredClone(request))
    const args = [...request.args]
    const ok = (stdout = ''): CommandResult => ({
      stdout,
      stderr: '',
      exitCode: 0
    })
    const fail = (stderr: string): CommandResult => ({
      stdout: '',
      stderr,
      exitCode: 1
    })
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return ok(`${this.main}\n`)
    }

    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return ok('base-commit\n')
    }

    if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
      const worktree = (
        await Promise.all(
          this.worktrees.map(async (candidate) => ({
            candidate,
            canonicalPath: await fs
              .realpath(candidate.path)
              .catch(() => path.resolve(candidate.path))
          }))
        )
      ).find(({ canonicalPath }) => canonicalPath === request.cwd)?.candidate
      return worktree ? ok(`${worktree.gitWorktreeKey}\n`) : fail('missing')
    }

    if (args[0] === 'worktree' && args[1] === 'list') {
      if (this.listWorktreesFails) {
        return fail('repository unavailable')
      }

      const worktrees = structuredClone(this.worktrees)
      if (this.worktreeListGate) {
        await this.worktreeListGate
      }

      return ok(
        worktrees
          .map(
            (worktree) =>
              `worktree ${worktree.path}\nHEAD ${worktree.head}\n${worktree.branch ? `branch refs/heads/${worktree.branch}` : 'detached'}${worktree.locked ? '\nlocked editor' : ''}${worktree.prunable ? '\nprunable missing' : ''}\n`
          )
          .join('\n')
      )
    }

    if (args[0] === 'worktree' && args[1] === 'add') {
      if (this.worktreeAddGate) {
        await this.worktreeAddGate
      }

      const worktreePath = args.at(-2)!
      const head = args.at(-1)!
      await fs.mkdir(worktreePath, { recursive: true })
      this.worktrees.push({
        path: worktreePath,
        gitWorktreeKey: path.join(
          this.main,
          '.git',
          'worktrees',
          path.basename(path.dirname(worktreePath))
        ),
        head,
        branch: null
      })
      return ok()
    }

    if (args[0] === 'worktree' && args[1] === 'remove') {
      if (this.removeFails) {
        return fail('git remove failed')
      }

      const worktreePath = args.at(-1)!
      const index = this.worktrees.findIndex(
        (worktree) => worktree.path === worktreePath
      )
      if (index === -1) {
        return fail('missing')
      }

      this.worktrees.splice(index, 1)
      await fs.rm(worktreePath, { recursive: true, force: true })
      return ok()
    }

    if (args[0] === 'branch' && args[1] === '--show-current') {
      return ok('trunk\n')
    }

    if (args[0] === 'ls-remote') {
      return ok('ref: refs/heads/trunk\tHEAD\nabc\tHEAD\n')
    }

    if (args[0] === 'symbolic-ref') {
      return ok('refs/remotes/origin/trunk\n')
    }

    if (args[0] === 'fetch') {
      return ok()
    }

    if (args[0] === 'status') {
      if (this.statusGate) {
        await this.statusGate
      }

      return ok(
        this.dirtyStatuses.get(request.cwd ?? '') ??
          (this.dirtyPaths.has(request.cwd ?? '') ? '?? dirty file.txt\0' : '')
      )
    }

    if (args[0] === 'for-each-ref') {
      return ok(this.reachable ? 'refs/remotes/origin/trunk\n' : '')
    }

    if (request.executable === 'hold-setup') {
      if (this.setupGate) {
        await this.setupGate
      }

      return ok()
    }

    if (args[0] === 'auth') {
      return fail('not authenticated')
    }

    if (args.includes('new-session')) {
      if (this.tmuxCreateGate) {
        await this.tmuxCreateGate
      }

      const session = args[args.indexOf('-s') + 1]!
      const socket = args[args.indexOf('-L') + 1]!
      this.sessions.set(`${socket}/${session}`, {
        alive: true,
        exitCode: null,
        created: Math.floor(Date.now() / 1_000),
        options: {}
      })
      return ok()
    }

    if (args.includes('set-option')) {
      const session = args[args.indexOf('-t') + 1]!
      const socket = args[args.indexOf('-L') + 1]!
      const state = this.sessions.get(`${socket}/${session}`)
      if (!state) {
        return fail('missing')
      }

      const key = args[args.indexOf('-t') + 2]!
      const value = args[args.indexOf('-t') + 3]!
      state.options[key] = value
      return ok()
    }

    if (args.includes('source-file')) {
      return ok()
    }

    if (args.includes('list-panes') && args.includes('-a')) {
      const socket = args[args.indexOf('-L') + 1]!
      const lines = [...this.sessions.entries()]
        .filter(([key]) => key.startsWith(`${socket}/`))
        .map(([key, state]) => {
          const session = key.slice(socket.length + 1)
          return [
            session,
            state.options['@tasktty-terminal-id'] ?? '',
            state.options['@tasktty-worktree-id'] ?? '',
            state.options['@tasktty-name'] ?? '',
            state.options['@tasktty-argv'] ?? '',
            state.options['@tasktty-created-at'] ?? '',
            state.options['@tasktty-updated-at'] ?? '',
            String(state.created),
            state.alive ? '0' : '1',
            state.exitCode === null ? '' : String(state.exitCode)
          ].join('\t')
        })
      return lines.length ? ok(`${lines.join('\n')}\n`) : fail('no sessions')
    }

    if (args.includes('list-panes')) {
      const session = args[args.indexOf('-t') + 1]!
      const socket = args[args.indexOf('-L') + 1]!
      const state = this.sessions.get(`${socket}/${session}`)
      return state
        ? ok(state.alive ? '0\t\n' : `1\t${state.exitCode ?? 0}\n`)
        : fail('missing')
    }

    if (args.includes('kill-session')) {
      const session = args[args.indexOf('-t') + 1]!
      const socket = args[args.indexOf('-L') + 1]!
      this.sessions.delete(`${socket}/${session}`)
      return ok()
    }

    if (args.includes('list-sessions')) {
      const socket = args[args.indexOf('-L') + 1]!
      return [...this.sessions.keys()].some((key) =>
        key.startsWith(`${socket}/`)
      )
        ? ok('session\n')
        : fail('no sessions')
    }

    if (args.includes('kill-server')) {
      const socket = args[args.indexOf('-L') + 1]!
      if (this.tmuxKillFails || this.tmuxKillFailureSockets.has(socket)) {
        return fail('tmux shutdown failed')
      }

      for (const key of [...this.sessions.keys()]) {
        if (key.startsWith(`${socket}/`)) {
          this.sessions.delete(key)
        }
      }
      return ok()
    }

    return fail(`Unexpected command: ${request.executable} ${args.join(' ')}`)
  }
}

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'tasktty integration with spaces ')
  )
  directories.push(root)
  const main = path.join(root, 'main checkout')
  const runtime = path.join(root, 'runtime')
  await fs.mkdir(main, { recursive: true })
  const runner = new SystemDouble(main)
  const database = new TaskTTYDatabase(path.join(root, 'tasktty.db'))
  databases.push(database)
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 4780,
    authToken: null,
    databasePath: database.filePath,
    dataDir: root,
    runtimeDir: runtime,
    shell: '/bin/zsh',
    tmuxPath: 'tmux',
    gitPath: 'git',
    ghPath: 'gh',
    apiUrl: 'http://127.0.0.1:4780'
  }
  const git = new GitAdapter(runner)
  const tmux = new TmuxAdapter(
    runner,
    runtime,
    'tmux',
    '/launcher with spaces.js'
  )
  const gh = new GhAdapter(runner)
  const service = new TaskTTYService({
    config,
    database,
    runner,
    git,
    tmux,
    gh
  })
  await service.initialize()
  return { root, main, runner, service, database, config }
}

async function waitForOperation(service: TaskTTYService, operationId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const operation = service.getOperation(operationId)
    if (operation.status === 'completed' || operation.status === 'failed') {
      return operation
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('operation timeout')
}

async function beginFromPreview(service: TaskTTYService, worktreeId: string) {
  const preview = await service.removePreview(worktreeId)
  return service.beginRemove(worktreeId, {
    confirmationToken: preview.confirmationToken,
    confirmDestructive: preview.warnings.length > 0
  })
}

describe('TaskTTYService with injected command adapters', () => {
  it('shares overlapping project snapshot reconciliation', async () => {
    const { main, runner, service } = await fixture()
    await service.registerProject(main)
    runner.calls.length = 0
    let release!: () => void
    runner.statusGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = service.listProjects()
    const second = service.listProjects()
    await vi.waitFor(() =>
      expect(
        runner.calls.filter((call) => call.args[0] === 'status')
      ).toHaveLength(1)
    )
    release()
    await Promise.all([first, second])
    runner.statusGate = null
  })

  it('invalidates an in-flight project snapshot after a mutation', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    let release!: () => void
    runner.statusGate = new Promise<void>((resolve) => {
      release = resolve
    })

    const stale = service.listProjects()
    await vi.waitFor(() =>
      expect(
        runner.calls.filter((call) => call.args[0] === 'status').length
      ).toBeGreaterThan(0)
    )
    service.updateProjectColor(project.id, 'violet')
    const fresh = service.listProjects()
    expect(fresh).not.toBe(stale)
    release()

    await expect(fresh).resolves.toMatchObject([{ color: 'violet' }])
    await expect(stale).resolves.toMatchObject([{ color: 'violet' }])
    runner.statusGate = null
  })

  it('persists project colors and publishes an update', async () => {
    const { main, service } = await fixture()
    const project = await service.registerProject(main)
    const events: string[] = []
    const unsubscribe = service.events.subscribe((event) =>
      events.push(event.type)
    )

    expect(service.updateProjectColor(project.id, 'violet').color).toBe(
      'violet'
    )
    expect(service.getProject(project.id).color).toBe('violet')
    expect(service.updateProjectColor(project.id, null).color).toBeNull()

    unsubscribe()
    expect(events).toEqual(['project.updated', 'project.updated'])
  })

  it('publishes a terminal only after its tmux session is ready', async () => {
    const { main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const mainWorktree = project.worktrees[0]!
    let releaseTerminal!: () => void
    runner.tmuxCreateGate = new Promise<void>((resolve) => {
      releaseTerminal = resolve
    })

    const creatingTerminal = service.createTerminal(mainWorktree.id, 'Starting')
    await vi.waitFor(() =>
      expect(
        runner.calls.some((call) => call.args.includes('new-session'))
      ).toBe(true)
    )
    const snapshot = await service.listProjects()
    expect(
      snapshot[0]?.worktrees[0]?.terminals.some(
        (terminal) => terminal.name === 'Starting'
      )
    ).toBe(false)

    releaseTerminal()
    const terminal = await creatingTerminal
    runner.tmuxCreateGate = null
    expect(terminal.status).toBe('running')
    expect((await service.getTerminal(terminal.id)).status).toBe('running')
    expect(
      database.connection
        .prepare("SELECT count(*) FROM sqlite_master WHERE name='terminals'")
        .pluck()
        .get()
    ).toBe(0)
  })

  it('derives status and disappearance events from tmux inventory', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const terminal = await service.createTerminal(
      project.worktrees[0]!.id,
      'Observed'
    )
    const events: string[] = []
    const unsubscribe = service.events.subscribe((event) => {
      events.push(event.type)
    })
    const sessionKey = `${project.worktrees[0]!.tmuxSocketName}/${terminal.tmuxSessionName}`
    const state = runner.sessions.get(sessionKey)!
    state.alive = false
    state.exitCode = 23

    await expect(
      service.refreshTerminalStatus(terminal.id)
    ).resolves.toMatchObject({
      status: 'exited',
      exitCode: 23
    })
    runner.sessions.delete(sessionKey)
    await expect(
      service.refreshTerminalStatus(terminal.id)
    ).rejects.toMatchObject({
      code: 'TERMINAL_NOT_FOUND'
    })
    unsubscribe()
    expect(events).toEqual(['terminal.updated', 'terminal.removed'])
  })

  it('keeps metadata polling tmux-only while direct status reads observe Git', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const terminal = await service.createTerminal(
      project.worktrees[0]!.id,
      'Polled'
    )
    runner.calls.splice(0)

    await service.refreshTerminalStatus(terminal.id, false)
    await service.refreshTerminalStatus(terminal.id, false)
    expect(
      runner.calls.filter(
        (call) => call.args[0] === 'worktree' && call.args[1] === 'list'
      )
    ).toHaveLength(0)

    await service.refreshTerminalStatus(terminal.id)
    expect(
      runner.calls.filter(
        (call) => call.args[0] === 'worktree' && call.args[1] === 'list'
      ).length
    ).toBeGreaterThan(0)
  })

  it('preserves bindings and terminals when Git moves a linked worktree', async () => {
    const { root, main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'moving', 'default')
    ).worktree
    const terminal = await service.createTerminal(linked.id, 'Moving terminal')
    const events: string[] = []
    const unsubscribe = service.events.subscribe((event) => {
      if (event.type === 'worktree.updated') {
        events.push(event.type)
      }
    })
    const live = runner.worktrees.find((item) => item.path === linked.path)!
    const movedPath = path.join(root, 'externally moved checkout')
    await fs.rename(linked.path, movedPath)
    live.path = movedPath

    await expect(
      service.refreshTerminalStatus(terminal.id)
    ).resolves.toMatchObject({ id: terminal.id })
    const moved = (await service.getProjectSnapshot(project.id)).worktrees.find(
      (worktree) => worktree.id === linked.id
    )!
    expect(moved).toMatchObject({
      id: linked.id,
      path: await fs.realpath(movedPath),
      tmuxSocketName: linked.tmuxSocketName
    })
    expect(moved.terminals.map((item) => item.id)).toContain(terminal.id)
    expect(service.getWorktree(linked.id).path).toBe(
      await fs.realpath(movedPath)
    )
    expect(events).toEqual(['worktree.updated'])
    unsubscribe()
  })

  it('retires externally removed worktrees only after a successful Git observation', async () => {
    const { main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'external-removal', 'default')
    ).worktree
    await service.createTerminal(linked.id, 'Removed terminal')
    const index = runner.worktrees.findIndex(
      (worktree) => worktree.path === linked.path
    )
    runner.worktrees.splice(index, 1)
    await fs.rm(linked.path, { recursive: true, force: true })

    const refreshed = await service.getProjectSnapshot(project.id)
    expect(refreshed.worktrees.map((worktree) => worktree.id)).not.toContain(
      linked.id
    )
    expect(database.worktree(linked.id)).toBeNull()
    expect(
      [...runner.sessions.keys()].some((key) =>
        key.startsWith(`${linked.tmuxSocketName}/`)
      )
    ).toBe(false)
    const externalOperation = database.connection
      .prepare("SELECT id FROM operations WHERE kind='external_remove'")
      .get() as { id: string }
    expect(service.getOperation(externalOperation.id)).toMatchObject({
      status: 'completed',
      result: expect.objectContaining({
        external: true,
        worktreeId: linked.id,
        path: linked.path
      })
    })
  })

  it('detects external removal through a direct terminal read', async () => {
    const { main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'terminal-removal', 'default')
    ).worktree
    const terminal = await service.createTerminal(linked.id, 'Direct read')
    runner.worktrees.splice(
      runner.worktrees.findIndex((worktree) => worktree.path === linked.path),
      1
    )
    await fs.rm(linked.path, { recursive: true, force: true })

    await expect(service.getTerminal(terminal.id)).rejects.toMatchObject({
      code: 'TERMINAL_NOT_FOUND'
    })
    expect(database.worktree(linked.id)).toBeNull()
  })

  it('preserves bindings and history when external terminal shutdown fails', async () => {
    const { main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'shutdown-failure', 'default')
    ).worktree
    await service.createTerminal(linked.id, 'Still running')
    const events: string[] = []
    const unsubscribe = service.events.subscribe((event) => {
      events.push(event.type)
    })
    runner.worktrees.splice(
      runner.worktrees.findIndex((worktree) => worktree.path === linked.path),
      1
    )
    await fs.rm(linked.path, { recursive: true, force: true })
    runner.tmuxKillFails = true

    const unavailable = await service.getProjectSnapshot(project.id)
    expect(unavailable.availability).toMatchObject({
      state: 'unavailable',
      message: expect.stringContaining('tmux shutdown failed')
    })
    expect(database.worktree(linked.id)).not.toBeNull()
    expect(
      database.connection
        .prepare("SELECT count(*) FROM operations WHERE kind='external_remove'")
        .pluck()
        .get()
    ).toBe(0)
    expect(events).not.toContain('worktree.removed')
    expect(events).not.toContain('terminal.removed')

    runner.tmuxKillFails = false
    await expect(service.getProjectSnapshot(project.id)).resolves.toMatchObject(
      { availability: { state: 'available' } }
    )
    expect(database.worktree(linked.id)).toBeNull()
    unsubscribe()
  })

  it('commits successful external retirements before a later shutdown failure', async () => {
    const { main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const first = (
      await service.createWorktree(project.id, 'removed-first', 'default')
    ).worktree
    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = (
      await service.createWorktree(project.id, 'removed-second', 'default')
    ).worktree
    const firstTerminal = await service.createTerminal(first.id, 'First')
    const secondTerminal = await service.createTerminal(second.id, 'Second')
    const events: Array<{ type: string; worktreeId: unknown }> = []
    const unsubscribe = service.events.subscribe((event) => {
      if (
        event.type === 'terminal.removed' ||
        event.type === 'worktree.removed'
      ) {
        events.push({ type: event.type, worktreeId: event.data.worktreeId })
      }
    })
    runner.worktrees.splice(
      runner.worktrees.findIndex((worktree) => worktree.path === first.path),
      1
    )
    runner.worktrees.splice(
      runner.worktrees.findIndex((worktree) => worktree.path === second.path),
      1
    )
    await Promise.all([
      fs.rm(first.path, { recursive: true, force: true }),
      fs.rm(second.path, { recursive: true, force: true })
    ])
    runner.tmuxKillFailureSockets.add(second.tmuxSocketName)

    const unavailable = await service.getProjectSnapshot(project.id)
    expect(unavailable.availability).toMatchObject({ state: 'unavailable' })
    expect(database.worktree(first.id)).toBeNull()
    expect(database.worktree(second.id)).not.toBeNull()
    const externalOperations = database.connection
      .prepare(
        "SELECT result_json FROM operations WHERE kind='external_remove'"
      )
      .all() as Array<{ result_json: string }>
    expect(
      externalOperations.map(({ result_json }) => JSON.parse(result_json))
    ).toEqual([
      expect.objectContaining({ worktreeId: first.id, external: true })
    ])
    expect(events).toEqual([
      { type: 'terminal.removed', worktreeId: first.id },
      { type: 'worktree.removed', worktreeId: first.id }
    ])
    expect(
      [...runner.sessions.keys()].some((key) =>
        key.endsWith(`/${firstTerminal.tmuxSessionName}`)
      )
    ).toBe(false)
    expect(
      [...runner.sessions.keys()].some((key) =>
        key.endsWith(`/${secondTerminal.tmuxSessionName}`)
      )
    ).toBe(true)

    runner.tmuxKillFailureSockets.delete(second.tmuxSocketName)
    await service.getProjectSnapshot(project.id)
    expect(database.worktree(second.id)).toBeNull()
    unsubscribe()
  })

  it('treats incomplete Git inventories as unavailable without retiring bindings', async () => {
    for (const keepLinked of [false, true]) {
      const { main, runner, service, database } = await fixture()
      const project = await service.registerProject(main)
      const linked = (
        await service.createWorktree(
          project.id,
          keepLinked ? 'missing-main' : 'empty-inventory',
          'default'
        )
      ).worktree
      await service.createTerminal(linked.id, 'Preserved')
      runner.worktrees.splice(
        0,
        runner.worktrees.length,
        ...(keepLinked
          ? runner.worktrees.filter((worktree) => worktree.path === linked.path)
          : [])
      )

      const unavailable = await service.getProjectSnapshot(project.id)
      expect(unavailable.availability).toMatchObject({
        state: 'unavailable',
        message: expect.stringContaining('inventory is incomplete')
      })
      expect(database.worktree(linked.id)).not.toBeNull()
      expect(
        [...runner.sessions.keys()].some((key) =>
          key.startsWith(`${linked.tmuxSocketName}/`)
        )
      ).toBe(true)
      expect(
        database.connection
          .prepare(
            "SELECT count(*) FROM operations WHERE kind='external_remove'"
          )
          .pluck()
          .get()
      ).toBe(0)
    }
  })

  it('serializes project observations so an older scan cannot win', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'serialized', 'default')
    ).worktree
    const live = runner.worktrees.find(
      (worktree) => worktree.path === linked.path
    )!
    let releaseObservation!: () => void
    runner.worktreeListGate = new Promise<void>((resolve) => {
      releaseObservation = resolve
    })
    const callsBefore = runner.calls.filter(
      (call) => call.args[0] === 'worktree' && call.args[1] === 'list'
    ).length
    const older = service.getProjectSnapshot(project.id)
    await vi.waitFor(() =>
      expect(
        runner.calls.filter(
          (call) => call.args[0] === 'worktree' && call.args[1] === 'list'
        ).length
      ).toBeGreaterThan(callsBefore)
    )
    live.head = 'newer-head'
    const newer = service.reconcile()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(
      runner.calls.filter(
        (call) => call.args[0] === 'worktree' && call.args[1] === 'list'
      ).length
    ).toBe(callsBefore + 1)

    releaseObservation()
    await Promise.all([older, newer])
    runner.worktreeListGate = null
    expect(service.getWorktree(linked.id).head).toBe('newer-head')
  })

  it('keeps cached bindings and rejects mutations while Git is unavailable', async () => {
    const { main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'unavailable', 'default')
    ).worktree
    const terminal = await service.createTerminal(linked.id, 'Preserved')
    runner.listWorktreesFails = true

    const unavailable = await service.getProjectSnapshot(project.id)
    expect(unavailable.availability).toMatchObject({
      state: 'unavailable',
      message: expect.stringContaining('repository unavailable')
    })
    expect(unavailable.worktrees.map((worktree) => worktree.id)).toContain(
      linked.id
    )
    expect(database.worktree(linked.id)).not.toBeNull()
    expect(
      [...runner.sessions.keys()].some((key) =>
        key.endsWith(`/${terminal.tmuxSessionName}`)
      )
    ).toBe(true)
    await expect(
      service.createTerminal(linked.id, 'Blocked')
    ).rejects.toMatchObject({ code: 'PROJECT_UNAVAILABLE' })

    runner.listWorktreesFails = false
    await expect(service.getProjectSnapshot(project.id)).resolves.toMatchObject(
      { availability: { state: 'available', message: null } }
    )
  })

  it('keeps Git-reported prunable worktrees visible but disabled', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'prunable', 'default')
    ).worktree
    runner.worktrees.find(
      (worktree) => worktree.path === linked.path
    )!.prunable = true

    const observed = await service.getWorktreeSnapshot(linked.id)
    expect(observed.prunable).toBe(true)
    await expect(service.removePreview(linked.id)).rejects.toMatchObject({
      code: 'WORKTREE_UNAVAILABLE'
    })
  })

  it('creates a detached Zed-style worktree, starts terminals, and removes by path', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const created = await service.createWorktree(
      project.id,
      'feature cache',
      'default'
    )
    expect(created.worktree.name).toBe('feature-cache')
    expect(created.worktree.detached).toBe(true)
    expect(created.worktree.branch).toBeNull()
    const canonicalMain = await fs.realpath(main)
    expect(created.worktree.path).toBe(
      path.join(
        path.dirname(canonicalMain),
        'worktrees',
        path.basename(canonicalMain),
        'feature-cache',
        path.basename(canonicalMain)
      )
    )
    expect(
      runner.calls.some(
        (call) => call.args.slice(0, 4).join(' ') === 'worktree add --detach --'
      )
    ).toBe(true)

    const first = await service.createTerminal(created.worktree.id, 'Pi', [
      'pi'
    ])
    await service.createTerminal(created.worktree.id, 'Dev', ['pnpm', 'dev'])
    expect(runner.sessions.size).toBe(2)
    await service.deleteTerminal(first.id)
    expect(runner.sessions.size).toBe(1)

    const operation = await beginFromPreview(service, created.worktree.id)
    expect((await waitForOperation(service, operation.id)).status).toBe(
      'completed'
    )
    expect(runner.sessions.size).toBe(0)
    expect(service.getProject(project.id).worktrees).toHaveLength(1)
    expect(
      runner.calls.some(
        (call) => call.args.includes('branch') && call.args.includes('-D')
      )
    ).toBe(false)
  })

  it('keeps a created worktree visible and delegates setup to its initial terminal', async () => {
    const { main, runner, service, config } = await fixture()
    await fs.mkdir(path.join(main, '.zed'), { recursive: true })
    await fs.writeFile(
      path.join(main, '.zed', 'tasks.json'),
      JSON.stringify([
        {
          label: 'setup',
          command: 'fail-setup',
          hooks: ['create_worktree']
        }
      ])
    )
    const project = await service.registerProject(main)
    const events: string[] = []
    const unsubscribe = service.events.subscribe((event) =>
      events.push(event.type)
    )
    const result = await service.createWorktree(
      project.id,
      'hook-failure',
      'default',
      {
        name: 'Pi',
        argv: ['pi']
      }
    )
    unsubscribe()
    expect(result.setupError).toBeNull()
    expect(result.terminal).not.toBeNull()
    expect(result.worktree.name).toBe('hook-failure')
    expect(
      service
        .getProject(project.id)
        .worktrees.some((item) => item.id === result.worktree.id)
    ).toBe(true)
    expect(runner.sessions.size).toBe(1)
    expect(events.indexOf('worktree.created')).toBeLessThan(
      events.indexOf('terminal.created')
    )
    const launchSpec = JSON.parse(
      await fs.readFile(
        path.join(
          config.runtimeDir,
          'launch-specs',
          `${result.terminal!.id}.json`
        ),
        'utf8'
      )
    ) as {
      argv: string[]
      setupTasks: Array<{ label: string; argv: string[] }>
    }
    expect(launchSpec.argv).toEqual(['pi'])
    expect(launchSpec.setupTasks).toEqual([
      expect.objectContaining({ label: 'setup', argv: ['fail-setup'] })
    ])
    expect(runner.calls.some((call) => call.executable === 'fail-setup')).toBe(
      false
    )
  })

  it('retains task preparation errors in an initial terminal launch spec', async () => {
    const { main, service, config } = await fixture()
    await fs.mkdir(path.join(main, '.zed'), { recursive: true })
    await fs.writeFile(path.join(main, '.zed', 'tasks.json'), '{ invalid json')
    const project = await service.registerProject(main)
    const result = await service.createWorktree(
      project.id,
      'invalid-setup',
      'default',
      {
        name: 'Terminal'
      }
    )
    expect(result.worktree.name).toBe('invalid-setup')
    expect(result.terminal).not.toBeNull()
    expect(result.setupError).toMatch(/Invalid JSONC/)
    const launchSpec = JSON.parse(
      await fs.readFile(
        path.join(
          config.runtimeDir,
          'launch-specs',
          `${result.terminal!.id}.json`
        ),
        'utf8'
      )
    ) as { setupError: string; argv: string[] }
    expect(launchSpec.setupError).toBe(result.setupError)
    expect(launchSpec.argv).toEqual(['/bin/zsh', '-l'])
  })

  it('requires force for dirty work and preserves explicit failure state', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'failure', 'default')
    ).worktree
    const terminal = await service.createTerminal(linked.id, 'Pi', ['pi'])
    runner.dirtyPaths.add(linked.path)
    const preview = await service.removePreview(linked.id)
    expect(preview.forceRequired).toBe(true)
    await expect(
      service.beginRemove(linked.id, {
        confirmationToken: preview.confirmationToken,
        confirmDestructive: false
      })
    ).rejects.toMatchObject({ code: 'REMOVE_CONFIRMATION_REQUIRED' })

    runner.removeFails = true
    const failed = await waitForOperation(
      service,
      (await beginFromPreview(service, linked.id)).id
    )
    expect(failed.status).toBe('failed')
    expect(service.getWorktree(linked.id).status).toBe('cleanup_failed')
    await expect(service.getTerminal(terminal.id)).rejects.toMatchObject({
      code: 'TERMINAL_NOT_FOUND'
    })
    expect(service.getWorktree(linked.id).cleanupError).toMatch(
      /Terminals were stopped/
    )
  })

  it('rejects removal when reachability, dirty categories, or terminal impact changed', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'stale', 'default')
    ).worktree

    const reachablePreview = await service.removePreview(linked.id)
    runner.reachable = false
    await expect(
      service.beginRemove(linked.id, {
        confirmationToken: reachablePreview.confirmationToken,
        confirmDestructive: false
      })
    ).rejects.toMatchObject({ code: 'REMOVE_PREVIEW_STALE' })

    runner.dirtyStatuses.set(linked.path, '?? untracked.txt\0')
    const untrackedPreview = await service.removePreview(linked.id)
    runner.dirtyStatuses.set(linked.path, ' M modified.txt\0')
    await expect(
      service.beginRemove(linked.id, {
        confirmationToken: untrackedPreview.confirmationToken,
        confirmDestructive: true
      })
    ).rejects.toMatchObject({ code: 'REMOVE_PREVIEW_STALE' })

    runner.dirtyStatuses.set(linked.path, '?? draft.txt\0')
    const pathPreview = await service.removePreview(linked.id)
    runner.dirtyStatuses.set(linked.path, '?? credentials.txt\0')
    await expect(
      service.beginRemove(linked.id, {
        confirmationToken: pathPreview.confirmationToken,
        confirmDestructive: true
      })
    ).rejects.toMatchObject({ code: 'REMOVE_PREVIEW_STALE' })

    runner.dirtyStatuses.delete(linked.path)
    runner.reachable = true
    const terminalPreview = await service.removePreview(linked.id)
    await service.createTerminal(linked.id, 'Late terminal', ['pi'])
    await expect(
      service.beginRemove(linked.id, {
        confirmationToken: terminalPreview.confirmationToken,
        confirmDestructive: false
      })
    ).rejects.toMatchObject({ code: 'REMOVE_PREVIEW_STALE' })
    await expect(
      service.createTerminal(linked.id, 'Locks released', ['pi'])
    ).resolves.toBeTruthy()
  })

  it('preserves pre-existing wrappers and treats managed-wrapper cleanup as best effort', async () => {
    const { main, service } = await fixture()
    const project = await service.registerProject(main)
    const canonicalMain = await fs.realpath(main)
    const repositoryBase = path.join(
      path.dirname(canonicalMain),
      'worktrees',
      path.basename(canonicalMain)
    )

    const existingWrapper = path.join(repositoryBase, 'existing-wrapper')
    await fs.mkdir(existingWrapper, { recursive: true })
    const existing = (
      await service.createWorktree(project.id, 'existing-wrapper', 'default')
    ).worktree
    expect(existing.managedWrapperPath).toBeNull()
    expect(
      (
        await waitForOperation(
          service,
          (
            await beginFromPreview(service, existing.id)
          ).id
        )
      ).status
    ).toBe('completed')
    await expect(fs.stat(existingWrapper)).resolves.toBeTruthy()

    const managed = (
      await service.createWorktree(project.id, 'managed-wrapper', 'default')
    ).worktree
    expect(managed.managedWrapperPath).toBe(path.dirname(managed.path))
    const marker = path.join(path.dirname(managed.path), 'user-marker.txt')
    await fs.writeFile(marker, 'preserve')
    expect(
      (
        await waitForOperation(
          service,
          (
            await beginFromPreview(service, managed.id)
          ).id
        )
      ).status
    ).toBe('completed')
    await expect(fs.readFile(marker, 'utf8')).resolves.toBe('preserve')
    expect(service.getProject(project.id).worktrees).toHaveLength(1)
  })

  it('refreshes live Git worktrees before checking inferred-name collisions', async () => {
    const { root, main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    runner.worktrees.push({
      path: path.join(root, 'external', 'duplicate', path.basename(main)),
      gitWorktreeKey: path.join(main, '.git', 'worktrees', 'duplicate'),
      head: 'external-head',
      branch: null
    })
    await expect(
      service.createWorktree(project.id, 'duplicate', 'default')
    ).rejects.toMatchObject({
      code: 'WORKTREE_EXISTS'
    })
    expect(
      runner.calls.filter(
        (call) => call.args[0] === 'worktree' && call.args[1] === 'add'
      )
    ).toHaveLength(0)
  })

  it('rejects a pre-existing symbolic-link wrapper', async () => {
    if (process.platform === 'win32') {
      return
    }

    const { root, main, service } = await fixture()
    const project = await service.registerProject(main)
    const canonicalMain = await fs.realpath(main)
    const wrapper = path.join(
      path.dirname(canonicalMain),
      'worktrees',
      path.basename(canonicalMain),
      'linked-wrapper'
    )
    const outside = path.join(root, 'outside')
    await fs.mkdir(path.dirname(wrapper), { recursive: true })
    await fs.mkdir(outside)
    await fs.symlink(outside, wrapper, 'dir')
    await expect(
      service.createWorktree(project.id, 'linked-wrapper', 'default')
    ).rejects.toMatchObject({
      code: 'INVALID_WORKTREE_PATH'
    })
  })

  it('recovers interrupted removals on either side of the Git removal boundary', async () => {
    const { main, runner, service, database, config } = await fixture()
    const project = await service.registerProject(main)
    const beforeGit = (
      await service.createWorktree(project.id, 'before-git', 'default')
    ).worktree
    const afterGit = (
      await service.createWorktree(project.id, 'after-git', 'default')
    ).worktree
    const afterGitNonEmpty = (
      await service.createWorktree(project.id, 'after-git-non-empty', 'default')
    ).worktree
    const timestamp = new Date().toISOString()
    const insertInterrupted = (operationId: string, worktreeId: string) => {
      database.connection
        .prepare(
          `INSERT INTO operations(id,kind,project_id,worktree_id,status,request_json,result_json,error,created_at,updated_at)
           VALUES(?,'remove',?,?,'running','{}',NULL,NULL,?,?)`
        )
        .run(operationId, project.id, worktreeId, timestamp, timestamp)
      database.connection
        .prepare(
          "UPDATE worktrees SET status='cleaning',updated_at=? WHERE id=?"
        )
        .run(timestamp, worktreeId)
    }
    insertInterrupted('op_before_git', beforeGit.id)
    insertInterrupted('op_after_git', afterGit.id)
    insertInterrupted('op_after_git_non_empty', afterGitNonEmpty.id)
    for (const worktree of [afterGit, afterGitNonEmpty]) {
      runner.worktrees.splice(
        runner.worktrees.findIndex((item) => item.path === worktree.path),
        1
      )
      await fs.rm(worktree.path, { recursive: true, force: true })
    }
    const preservedMarker = path.join(
      path.dirname(afterGitNonEmpty.path),
      'preserve.txt'
    )
    await fs.writeFile(preservedMarker, 'preserve')

    const restarted = new TaskTTYService({
      config,
      database,
      runner,
      git: new GitAdapter(runner),
      tmux: new TmuxAdapter(
        runner,
        config.runtimeDir,
        'tmux',
        '/launcher with spaces.js'
      ),
      gh: new GhAdapter(runner)
    })
    await restarted.initialize()

    expect(restarted.getWorktree(beforeGit.id).status).toBe('cleanup_failed')
    expect(restarted.getOperation('op_before_git')).toMatchObject({
      status: 'failed'
    })
    expect(database.worktree(afterGit.id)).toBeNull()
    expect(restarted.getOperation('op_after_git')).toMatchObject({
      status: 'completed',
      result: expect.objectContaining({ recovered: true, removed: true }),
      error: null
    })
    await expect(fs.stat(path.dirname(afterGit.path))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(database.worktree(afterGit.id)).toBeNull()
    expect(database.worktree(afterGitNonEmpty.id)).toBeNull()
    expect(restarted.getOperation('op_after_git_non_empty')).toMatchObject({
      status: 'completed',
      result: expect.objectContaining({ recovered: true, removed: true }),
      error: null
    })
    await expect(fs.readFile(preservedMarker, 'utf8')).resolves.toBe('preserve')
    expect(database.worktree(afterGitNonEmpty.id)).toBeNull()
  })

  it('clears managed-wrapper provenance when an external worktree revives a removed path', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const managed = (
      await service.createWorktree(project.id, 'reused-wrapper', 'default')
    ).worktree
    const wrapper = path.dirname(managed.path)
    expect(managed.managedWrapperPath).toBe(wrapper)
    await waitForOperation(
      service,
      (await beginFromPreview(service, managed.id)).id
    )

    await fs.mkdir(managed.path, { recursive: true })
    const marker = path.join(wrapper, 'external-marker.txt')
    await fs.writeFile(marker, 'external')
    runner.worktrees.push({
      path: managed.path,
      gitWorktreeKey: path.join(main, '.git', 'worktrees', 'external-reuse'),
      head: 'external-head',
      branch: null
    })
    await service.refreshProject(project.id)
    const revived = service
      .getProject(project.id)
      .worktrees.find((worktree) => worktree.path === managed.path)!
    expect(revived.id).not.toBe(managed.id)
    expect(revived.managedWrapperPath).toBeNull()

    await waitForOperation(
      service,
      (await beginFromPreview(service, revived.id)).id
    )
    await expect(fs.readFile(marker, 'utf8')).resolves.toBe('external')
  })

  it('keeps removal blocked while headless setup is still running', async () => {
    const { main, runner, service } = await fixture()
    await fs.mkdir(path.join(main, '.zed'), { recursive: true })
    await fs.writeFile(
      path.join(main, '.zed', 'tasks.json'),
      JSON.stringify([
        {
          label: 'held setup',
          command: 'hold-setup',
          hooks: ['create_worktree']
        }
      ])
    )
    const project = await service.registerProject(main)
    let releaseSetup!: () => void
    runner.setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve
    })

    const creating = service.createWorktree(
      project.id,
      'setup-locked',
      'default'
    )
    await vi.waitFor(() =>
      expect(
        runner.calls.some((call) => call.executable === 'hold-setup')
      ).toBe(true)
    )
    const linked = service
      .getProject(project.id)
      .worktrees.find((worktree) => worktree.name === 'setup-locked')!
    const preview = await service.removePreview(linked.id)
    await expect(
      service.beginRemove(linked.id, {
        confirmationToken: preview.confirmationToken,
        confirmDestructive: preview.warnings.length > 0
      })
    ).rejects.toMatchObject({ code: 'REMOVE_IN_PROGRESS' })

    releaseSetup()
    await expect(creating).resolves.toMatchObject({
      worktree: { id: linked.id }
    })
    runner.setupGate = null
  })

  it('serializes project deletion against worktree and terminal creation', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)

    let releaseAdd!: () => void
    runner.worktreeAddGate = new Promise<void>((resolve) => {
      releaseAdd = resolve
    })
    const creatingWorktree = service.createWorktree(
      project.id,
      'concurrent',
      'default'
    )
    await vi.waitFor(() =>
      expect(
        runner.calls.some(
          (call) => call.args[0] === 'worktree' && call.args[1] === 'add'
        )
      ).toBe(true)
    )
    await expect(service.deleteProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_BUSY'
    })
    releaseAdd()
    const linked = (await creatingWorktree).worktree
    runner.worktreeAddGate = null
    await expect(service.deleteProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_HAS_WORKTREES'
    })
    await waitForOperation(
      service,
      (await beginFromPreview(service, linked.id)).id
    )

    const mainWorktree = service.getProject(project.id).worktrees[0]!
    let releaseTerminal!: () => void
    runner.tmuxCreateGate = new Promise<void>((resolve) => {
      releaseTerminal = resolve
    })
    const creatingTerminal = service.createTerminal(
      mainWorktree.id,
      'Concurrent',
      ['pi']
    )
    await vi.waitFor(() =>
      expect(
        runner.calls.some((call) => call.args.includes('new-session'))
      ).toBe(true)
    )
    await expect(service.deleteProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_BUSY'
    })
    releaseTerminal()
    await creatingTerminal
    runner.tmuxCreateGate = null
    await expect(service.deleteProject(project.id)).resolves.toBeUndefined()
  })

  it('refuses main and locked worktrees', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    expect(
      (await service.removePreview(project.worktrees[0]!.id)).eligible
    ).toBe(false)
    const linked = (
      await service.createWorktree(project.id, 'locked', 'default')
    ).worktree
    runner.worktrees.find((item) => item.path === linked.path)!.locked = true
    await service.refreshProject(project.id)
    const preview = await service.removePreview(linked.id)
    expect(preview.eligible).toBe(false)
    expect(preview.reasons.join(' ')).toMatch(/locked/i)
  })
})
