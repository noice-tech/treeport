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
  worktreeRepairFails = false
  tmuxKillFails = false
  readonly tmuxKillFailureSockets = new Set<string>()
  statusGate: Promise<void> | null = null
  worktreeListGate: Promise<void> | null = null
  worktreeAddGate: Promise<void> | null = null
  tmuxCreateGate: Promise<void> | null = null
  tmuxStateGate: Promise<void> | null = null
  setupGate: Promise<void> | null = null
  removeAfterDeregisterGate: Promise<void> | null = null
  worktreeDeregistered: (() => void) | null = null

  constructor(main: string) {
    this.main = main
    this.worktrees = [
      {
        path: main,
        gitWorktreeKey: path.join(main, '.git'),
        head: 'main-head',
        branch: 'trunk'
      }
    ]
  }

  main: string

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

    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
      return ok(`${path.join(this.main, '.git')}\n`)
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

    if (args[0] === 'worktree' && args[1] === 'repair') {
      if (this.worktreeRepairFails) {
        return fail('worktree repair failed')
      }

      for (const [index, worktree] of this.worktrees.entries()) {
        const adminName = path.basename(worktree.gitWorktreeKey)
        worktree.gitWorktreeKey =
          index === 0
            ? path.join(this.main, '.git')
            : path.join(this.main, '.git', 'worktrees', adminName)
      }
      return ok()
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
      const gitWorktreeKey = path.join(
        this.main,
        '.git',
        'worktrees',
        path.basename(path.dirname(worktreePath))
      )
      await fs.mkdir(worktreePath, { recursive: true })
      await fs.writeFile(
        path.join(worktreePath, '.git'),
        `gitdir: ${gitWorktreeKey}\n`
      )
      this.worktrees.push({
        path: worktreePath,
        gitWorktreeKey,
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
      this.worktreeDeregistered?.()
      if (this.removeAfterDeregisterGate) {
        await this.removeAfterDeregisterGate
      }

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
      if (this.tmuxStateGate) {
        await this.tmuxStateGate
      }

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

  it('recovers a renamed main checkout and preserves its bindings and terminals', async () => {
    const { root, main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const originalMain = project.worktrees.find(
      (worktree) => worktree.kind === 'main'
    )!
    const linked = (
      await service.createWorktree(project.id, 'main-rename-linked', 'default')
    ).worktree
    const terminal = await service.createTerminal(linked.id, 'Preserved')
    const prunable = (
      await service.createWorktree(
        project.id,
        'missing-during-repair',
        'default'
      )
    ).worktree
    runner.worktrees.find(
      (worktree) => worktree.path === prunable.path
    )!.prunable = true
    await fs.rm(prunable.path, { recursive: true, force: true })
    const renamedMain = path.join(root, 'renamed main checkout')
    await fs.rename(main, renamedMain)
    runner.main = renamedMain
    runner.worktrees[0]!.path = renamedMain

    const recovered = await service.getProjectSnapshot(project.id)
    const recoveredMain = recovered.worktrees.find(
      (worktree) => worktree.kind === 'main'
    )!
    const recoveredLinked = recovered.worktrees.find(
      (worktree) => worktree.id === linked.id
    )!
    expect(recovered).toMatchObject({
      id: project.id,
      name: 'renamed main checkout',
      repositoryPath: await fs.realpath(renamedMain),
      mainWorktreePath: await fs.realpath(renamedMain),
      availability: { state: 'available', message: null }
    })
    expect(recoveredMain).toMatchObject({
      id: originalMain.id,
      path: await fs.realpath(renamedMain),
      tmuxSocketName: originalMain.tmuxSocketName
    })
    expect(recoveredLinked).toMatchObject({
      id: linked.id,
      tmuxSocketName: linked.tmuxSocketName
    })
    expect(recoveredLinked.terminals.map((item) => item.id)).toContain(
      terminal.id
    )
    expect(
      recovered.worktrees.find((worktree) => worktree.id === prunable.id)
    ).toMatchObject({ id: prunable.id, prunable: true })
    expect(
      runner.calls.some(
        (call) =>
          call.args[0] === 'worktree' &&
          call.args[1] === 'repair' &&
          call.args.length === 2
      )
    ).toBe(true)
  })

  it('recovers a stopped-daemon main and linked-worktree rename', async () => {
    const { root, main, runner, service, database, config } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'restart-main-rename', 'default')
    ).worktree
    const terminal = await service.createTerminal(linked.id, 'Preserved')
    const linkedGitKey = runner.worktrees.find(
      (worktree) => worktree.path === linked.path
    )!.gitWorktreeKey
    database.close()
    databases.splice(databases.indexOf(database), 1)

    const renamedMain = path.join(root, 'renamed while daemon stopped')
    const movedLinked = path.join(root, 'linked moved while daemon stopped')
    await fs.rename(main, renamedMain)
    await fs.rename(linked.path, movedLinked)
    runner.main = renamedMain
    runner.worktrees[0]!.path = renamedMain
    runner.worktrees.find(
      (worktree) => worktree.gitWorktreeKey === linkedGitKey
    )!.path = movedLinked

    const restartedDatabase = new TaskTTYDatabase(config.databasePath)
    databases.push(restartedDatabase)
    const restarted = new TaskTTYService({
      config,
      database: restartedDatabase,
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

    const recovered = await restarted.getProjectSnapshot(project.id)
    expect(recovered).toMatchObject({
      id: project.id,
      repositoryPath: await fs.realpath(renamedMain),
      availability: { state: 'available' }
    })
    expect(
      recovered.worktrees.find((worktree) => worktree.id === linked.id)
    ).toMatchObject({
      id: linked.id,
      path: await fs.realpath(movedLinked),
      tmuxSocketName: linked.tmuxSocketName,
      terminals: expect.arrayContaining([
        expect.objectContaining({ id: terminal.id })
      ])
    })
    expect(
      restartedDatabase.connection
        .prepare('SELECT git_worktree_key FROM worktrees WHERE id=?')
        .pluck()
        .get(linked.id)
    ).toBe(`worktrees/${path.basename(linkedGitKey)}`)
  })

  it('preserves metadata when Git repair fails during main rename recovery', async () => {
    const { root, main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'repair-failure', 'default')
    ).worktree
    const terminal = await service.createTerminal(linked.id, 'Preserved')
    const renamedMain = path.join(root, 'repair failure rename')
    await fs.rename(main, renamedMain)
    runner.main = renamedMain
    runner.worktrees[0]!.path = renamedMain
    runner.worktreeRepairFails = true

    const unavailable = await service.getProjectSnapshot(project.id)
    expect(unavailable.availability).toMatchObject({
      state: 'unavailable',
      message: expect.stringContaining('worktree repair failed')
    })
    expect(database.project(project.id)?.repositoryPath).toBe(
      project.repositoryPath
    )
    expect(database.worktree(linked.id)).toMatchObject({
      path: linked.path,
      tmuxSocketName: linked.tmuxSocketName
    })
    expect(
      [...runner.sessions.keys()].some((key) =>
        key.endsWith(`/${terminal.tmuxSessionName}`)
      )
    ).toBe(true)
  })

  it('preserves an explicit project name equal to the original folder name', async () => {
    const { root, main, runner, service } = await fixture()
    const project = await service.registerProject(main, path.basename(main))
    const renamedMain = path.join(root, 'renamed custom checkout')
    await fs.rename(main, renamedMain)
    runner.main = renamedMain
    runner.worktrees[0]!.path = renamedMain

    await expect(service.getProjectSnapshot(project.id)).resolves.toMatchObject(
      {
        id: project.id,
        name: path.basename(main),
        repositoryPath: await fs.realpath(renamedMain),
        availability: { state: 'available' }
      }
    )
  })

  it('refuses to adopt a different repository placed at a registered path', async () => {
    const { root, main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const renamedMain = path.join(root, 'original repository renamed')
    await fs.rename(main, renamedMain)
    await fs.mkdir(main)
    runner.main = main
    runner.worktrees[0] = {
      path: main,
      gitWorktreeKey: path.join(main, '.git'),
      head: 'replacement-head',
      branch: 'trunk'
    }

    await expect(service.registerProject(main)).rejects.toMatchObject({
      code: 'PROJECT_PATH_CONFLICT',
      status: 409
    })
    expect(database.project(project.id)).toMatchObject({
      id: project.id,
      repositoryPath: project.repositoryPath,
      mainWorktreePath: project.mainWorktreePath
    })
  })

  it('keeps an unknown-parent move unavailable until re-registration recovers it', async () => {
    const { root, main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const originalMain = project.worktrees.find(
      (worktree) => worktree.kind === 'main'
    )!
    const linked = (
      await service.createWorktree(project.id, 'reregister-linked', 'default')
    ).worktree
    const terminal = await service.createTerminal(linked.id, 'Preserved')
    const destinationParent = path.join(root, 'elsewhere')
    const movedMain = path.join(destinationParent, 'moved repository')
    await fs.mkdir(destinationParent)
    await fs.rename(main, movedMain)
    await fs.mkdir(main)
    runner.main = movedMain
    runner.worktrees[0]!.path = movedMain
    runner.calls.length = 0

    const unavailable = await service.getProjectSnapshot(project.id)
    expect(unavailable).toMatchObject({
      id: project.id,
      repositoryPath: project.repositoryPath,
      availability: { state: 'unavailable' }
    })
    expect(database.project(project.id)?.repositoryPath).toBe(
      project.repositoryPath
    )
    expect(
      runner.calls.some(
        (call) =>
          call.cwd === main &&
          call.args[0] === 'worktree' &&
          call.args[1] === 'list'
      )
    ).toBe(false)
    expect(
      [...runner.sessions.keys()].some((key) =>
        key.endsWith(`/${terminal.tmuxSessionName}`)
      )
    ).toBe(true)

    await fs.rm(main, { recursive: true })
    const recovered = await service.registerProject(movedMain)
    expect(recovered).toMatchObject({
      id: project.id,
      name: 'moved repository',
      repositoryPath: await fs.realpath(movedMain),
      mainWorktreePath: await fs.realpath(movedMain)
    })
    expect(
      recovered.worktrees.find((worktree) => worktree.kind === 'main')
    ).toMatchObject({
      id: originalMain.id,
      tmuxSocketName: originalMain.tmuxSocketName
    })
    expect(
      recovered.worktrees.find((worktree) => worktree.id === linked.id)
    ).toMatchObject({ tmuxSocketName: linked.tmuxSocketName })
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

  it('keeps an in-flight removal cleaning after Git deregisters it', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'in-flight', 'default')
    ).worktree
    let releaseRemoval!: () => void
    runner.removeAfterDeregisterGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve
    })
    let deregistered!: () => void
    const deregisteredPromise = new Promise<void>((resolve) => {
      deregistered = resolve
    })
    runner.worktreeDeregistered = deregistered
    const events: string[] = []
    const unsubscribe = service.events.subscribe((event) =>
      events.push(event.type)
    )

    const operation = await beginFromPreview(service, linked.id)
    expect(operation.request).toMatchObject({
      checkoutIdentity: {
        path: linked.path,
        device: expect.any(String),
        inode: expect.any(String),
        gitWorktreeKey: expect.any(String),
        gitMarker: expect.stringMatching(/^gitdir: /),
        managedWrapperPath: linked.managedWrapperPath,
        quarantinePath: expect.stringContaining('.tasktty-removing-op_')
      }
    })
    await deregisteredPromise
    const duringRemoval = await service.getProjectSnapshot(project.id)
    expect(
      duringRemoval.worktrees.find((worktree) => worktree.id === linked.id)
    ).toMatchObject({ status: 'cleaning' })
    expect(service.getOperation(operation.id).status).toBe('running')
    await expect(fs.stat(linked.path)).resolves.toBeTruthy()
    expect(events.filter((event) => event === 'remove.completed')).toHaveLength(
      0
    )

    releaseRemoval()
    expect((await waitForOperation(service, operation.id)).status).toBe(
      'completed'
    )
    await expect(fs.stat(linked.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(service.database.worktree(linked.id)).toBeNull()
    expect(events.filter((event) => event === 'remove.completed')).toHaveLength(
      1
    )
    expect(events.filter((event) => event === 'worktree.removed')).toHaveLength(
      1
    )
    unsubscribe()
  })

  it('recovers only an authorized interrupted checkout root', async () => {
    const { main, runner, service, database, config } = await fixture()
    const project = await service.registerProject(main)
    const recoverable = (
      await service.createWorktree(project.id, 'recoverable-root', 'default')
    ).worktree
    const quarantined = (
      await service.createWorktree(project.id, 'quarantined-root', 'default')
    ).worktree
    const replaced = (
      await service.createWorktree(project.id, 'replaced-root', 'default')
    ).worktree
    const repurposed = (
      await service.createWorktree(project.id, 'repurposed-root', 'default')
    ).worktree
    const legacy = (
      await service.createWorktree(project.id, 'legacy-root', 'default')
    ).worktree
    const timestamp = new Date().toISOString()
    const insertInterrupted = async (
      operationId: string,
      worktree: typeof recoverable,
      includeIdentity: boolean
    ) => {
      const preview = await service.removePreview(worktree.id)
      const checkout = await fs.lstat(worktree.path, { bigint: true })
      const gitWorktreeKey = (
        database.connection
          .prepare('SELECT git_worktree_key FROM worktrees WHERE id=?')
          .get(worktree.id) as { git_worktree_key: string }
      ).git_worktree_key
      const gitMarker = await fs.readFile(
        path.join(worktree.path, '.git'),
        'utf8'
      )
      database.connection
        .prepare(
          `INSERT INTO operations(id,kind,project_id,worktree_id,status,request_json,result_json,error,created_at,updated_at)
           VALUES(?,'remove',?,?,'running',?,NULL,NULL,?,?)`
        )
        .run(
          operationId,
          project.id,
          worktree.id,
          JSON.stringify(
            includeIdentity
              ? {
                  preview,
                  checkoutIdentity: {
                    path: worktree.path,
                    device: checkout.dev.toString(),
                    inode: checkout.ino.toString(),
                    gitWorktreeKey,
                    gitMarker,
                    managedWrapperPath: worktree.managedWrapperPath,
                    quarantinePath: path.join(
                      path.dirname(worktree.path),
                      `.${path.basename(worktree.path)}.tasktty-removing-${operationId}`
                    )
                  }
                }
              : {}
          ),
          timestamp,
          timestamp
        )
      database.connection
        .prepare(
          "UPDATE worktrees SET status='cleaning',updated_at=? WHERE id=?"
        )
        .run(timestamp, worktree.id)
    }
    await insertInterrupted('op_recoverable_root', recoverable, true)
    await insertInterrupted('op_quarantined_root', quarantined, true)
    await insertInterrupted('op_replaced_root', replaced, true)
    await insertInterrupted('op_repurposed_root', repurposed, true)
    await insertInterrupted('op_legacy_root', legacy, false)
    runner.worktrees.splice(1, runner.worktrees.length - 1)
    await fs.writeFile(
      path.join(path.dirname(recoverable.path), 'preserve.txt'),
      'preserve wrapper'
    )
    const quarantinePath = (
      service.getOperation('op_quarantined_root').request.checkoutIdentity as {
        quarantinePath: string
      }
    ).quarantinePath
    await fs.rename(quarantined.path, quarantinePath)
    await expect(fs.stat(quarantined.path)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(fs.stat(quarantinePath)).resolves.toBeTruthy()
    await fs.rm(replaced.path, { recursive: true, force: true })
    await fs.mkdir(replaced.path, { recursive: true })
    const replacementMarker = path.join(replaced.path, 'replacement.txt')
    await fs.writeFile(replacementMarker, 'replacement')
    const repurposedInode = (
      await fs.lstat(repurposed.path, { bigint: true })
    ).ino.toString()
    for (const entry of await fs.readdir(repurposed.path)) {
      await fs.rm(path.join(repurposed.path, entry), {
        recursive: true,
        force: true
      })
    }
    await fs.mkdir(path.join(repurposed.path, '.git'))
    const repurposedMarker = path.join(repurposed.path, 'replacement.txt')
    await fs.writeFile(repurposedMarker, 'replacement in the same directory')
    expect(
      (await fs.lstat(repurposed.path, { bigint: true })).ino.toString()
    ).toBe(repurposedInode)

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
    const events: Array<{ type: string; worktreeId: unknown }> = []
    const unsubscribe = restarted.events.subscribe((event) =>
      events.push({ type: event.type, worktreeId: event.data.worktreeId })
    )
    await restarted.initialize()

    await expect(fs.stat(recoverable.path)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(
      fs.readFile(
        path.join(path.dirname(recoverable.path), 'preserve.txt'),
        'utf8'
      )
    ).resolves.toBe('preserve wrapper')
    expect(
      (await fs.readdir(path.dirname(recoverable.path))).some((entry) =>
        entry.includes('.tasktty-removing-')
      )
    ).toBe(false)
    expect(database.worktree(recoverable.id)).toBeNull()
    expect(restarted.getOperation('op_recoverable_root')).toMatchObject({
      status: 'completed',
      result: expect.objectContaining({ removed: true, recovered: true })
    })

    await expect(fs.stat(quarantinePath)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(fs.stat(quarantined.path)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(database.worktree(quarantined.id)).toBeNull()
    expect(restarted.getOperation('op_quarantined_root')).toMatchObject({
      status: 'completed',
      result: expect.objectContaining({ removed: true, recovered: true })
    })

    await expect(fs.readFile(replacementMarker, 'utf8')).resolves.toBe(
      'replacement'
    )
    expect(database.worktree(replaced.id)).toMatchObject({
      status: 'cleanup_failed',
      cleanupError: expect.stringMatching(/different filesystem object/i)
    })
    expect(restarted.getOperation('op_replaced_root')).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/different filesystem object/i)
    })

    await expect(fs.readFile(repurposedMarker, 'utf8')).resolves.toBe(
      'replacement in the same directory'
    )
    expect(database.worktree(repurposed.id)).toMatchObject({
      status: 'cleanup_failed',
      cleanupError: expect.stringMatching(/Git marker/i)
    })
    expect(restarted.getOperation('op_repurposed_root')).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/Git marker/i)
    })

    await expect(fs.stat(legacy.path)).resolves.toBeTruthy()
    expect(database.worktree(legacy.id)).toMatchObject({
      status: 'cleanup_failed',
      cleanupError: expect.stringMatching(/legacy removal/i)
    })
    expect(restarted.getOperation('op_legacy_root').status).toBe('failed')
    const failuresBeforeSecondPoll = events.filter(
      (event) => event.type === 'remove.failed'
    ).length
    await restarted.getProjectSnapshot(project.id)
    expect(
      events.filter((event) => event.type === 'remove.failed')
    ).toHaveLength(failuresBeforeSecondPoll)

    await fs.rm(legacy.path, { recursive: true, force: true })
    await restarted.getProjectSnapshot(project.id)
    expect(database.worktree(legacy.id)).toBeNull()
    expect(restarted.getOperation('op_legacy_root').status).toBe('completed')
    expect(
      events.filter(
        (event) =>
          event.type === 'remove.completed' &&
          event.worktreeId === recoverable.id
      )
    ).toHaveLength(1)
    expect(
      events.filter(
        (event) =>
          event.type === 'remove.completed' && event.worktreeId === legacy.id
      )
    ).toHaveLength(1)
    unsubscribe()
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
    const externalGitWorktreeKey = path.join(
      main,
      '.git',
      'worktrees',
      'external-reuse'
    )
    await fs.writeFile(
      path.join(managed.path, '.git'),
      `gitdir: ${externalGitWorktreeKey}\n`
    )
    runner.worktrees.push({
      path: managed.path,
      gitWorktreeKey: externalGitWorktreeKey,
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

  it("does not release another mutation's project lock after path registration is refused", async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    let releaseAdd!: () => void
    runner.worktreeAddGate = new Promise<void>((resolve) => {
      releaseAdd = resolve
    })
    const creating = service.createWorktree(project.id, 'lock-owner', 'default')
    await vi.waitFor(() =>
      expect(
        runner.calls.some(
          (call) => call.args[0] === 'worktree' && call.args[1] === 'add'
        )
      ).toBe(true)
    )

    await expect(service.registerProject(main)).rejects.toMatchObject({
      code: 'PROJECT_BUSY'
    })
    await expect(service.closeProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_BUSY'
    })

    releaseAdd()
    await expect(creating).resolves.toMatchObject({
      worktree: { name: 'lock-owner' }
    })
    runner.worktreeAddGate = null
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

  it('closes every project worktree and reopens durable identity without terminals', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const mainWorktree = project.worktrees[0]!
    await service.createTerminal(mainWorktree.id, 'Main terminal', ['pi'])
    const linkedResult = await service.createWorktree(
      project.id,
      'close-all',
      'default',
      { name: 'Linked terminal', argv: ['pi'] }
    )
    const linked = linkedResult.worktree
    expect(runner.sessions.size).toBe(2)

    await service.closeProject(project.id)

    expect(await service.listProjects()).toEqual([])
    expect(service.listRecentProjects()).toEqual([
      expect.objectContaining({
        id: project.id,
        repositoryPath: project.repositoryPath
      })
    ])
    expect(runner.sessions.size).toBe(0)
    expect(
      service.database.project(project.id)?.worktrees.map(({ id }) => id)
    ).toEqual(expect.arrayContaining([mainWorktree.id, linked.id]))

    const reopened = await service.openProject(project.id)
    expect(reopened.id).toBe(project.id)
    expect(reopened.worktrees.map(({ id }) => id)).toEqual(
      expect.arrayContaining([mainWorktree.id, linked.id])
    )
    expect(reopened.worktrees.flatMap(({ terminals }) => terminals)).toEqual([])
    expect(service.listRecentProjects()).toEqual([])

    await service.closeProject(project.id)
    const pathReopened = await service.registerProject(main)
    expect(pathReopened.id).toBe(project.id)
    expect(service.database.isProjectOpen(project.id)).toBe(true)
  })

  it('keeps a project open after partial terminal shutdown and retries the close', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const mainWorktree = project.worktrees[0]!
    const mainTerminal = await service.createTerminal(
      mainWorktree.id,
      'Main terminal',
      ['pi']
    )
    const linkedResult = await service.createWorktree(
      project.id,
      'partial-close',
      'default',
      { name: 'Linked terminal', argv: ['pi'] }
    )
    const linked = linkedResult.worktree
    runner.tmuxKillFailureSockets.add(linked.tmuxSocketName)
    const removed: string[] = []
    const unsubscribe = service.events.subscribe((event) => {
      if (event.type === 'terminal.removed') {
        removed.push(String(event.data.terminalId))
      }
    })

    await expect(service.closeProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_CLOSE_FAILED',
      details: {
        failedWorktreeIds: [linked.id],
        terminalsMayHaveStopped: true
      }
    })
    expect(service.database.isProjectOpen(project.id)).toBe(true)
    expect(removed).toContain(mainTerminal.id)
    expect(runner.sessions.size).toBe(1)
    expect(
      (await service.listProjects())[0]!.worktrees.flatMap(
        ({ terminals }) => terminals
      )
    ).toHaveLength(1)

    runner.tmuxKillFailureSockets.clear()
    await expect(service.closeProject(project.id)).resolves.toBeUndefined()
    unsubscribe()
    expect(service.database.isProjectOpen(project.id)).toBe(false)
    expect(runner.sessions.size).toBe(0)
  })

  it('reports a final persistence failure after clearing stopped terminals', async () => {
    const { main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const mainWorktree = project.worktrees[0]!
    const terminal = await service.createTerminal(
      mainWorktree.id,
      'Persistence failure',
      ['pi']
    )
    const setProjectOpen = database.setProjectOpen.bind(database)
    vi.spyOn(database, 'setProjectOpen').mockImplementation(
      (projectId, open, timestamp) => {
        if (!open) {
          throw new Error('database write failed')
        }

        setProjectOpen(projectId, open, timestamp)
      }
    )
    const events: string[] = []
    const unsubscribe = service.events.subscribe((event) => {
      events.push(`${event.type}:${String(event.data.terminalId ?? '')}`)
    })

    await expect(service.closeProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_CLOSE_FAILED',
      details: {
        failedWorktreeIds: [],
        terminalsMayHaveStopped: true
      }
    })
    unsubscribe()
    expect(database.isProjectOpen(project.id)).toBe(true)
    expect(runner.sessions.size).toBe(0)
    expect(events).toContain(`terminal.removed:${terminal.id}`)
    expect(events.some((event) => event.startsWith('project.updated'))).toBe(
      false
    )
  })

  it('waits for in-flight observation before closing a project', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    let releaseObservation!: () => void
    runner.worktreeListGate = new Promise<void>((resolve) => {
      releaseObservation = resolve
    })
    runner.calls.length = 0
    const snapshot = service.listProjects()
    await vi.waitFor(() =>
      expect(
        runner.calls.some(
          (call) => call.args[0] === 'worktree' && call.args[1] === 'list'
        )
      ).toBe(true)
    )

    let closed = false
    const closing = service.closeProject(project.id).then(() => {
      closed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(closed).toBe(false)
    releaseObservation()
    await snapshot
    await closing
    runner.worktreeListGate = null
    expect(await service.listProjects()).toEqual([])
  })

  it('does not let an in-flight terminal poll repopulate state after close', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const terminal = await service.createTerminal(
      project.worktrees[0]!.id,
      'Polled terminal',
      ['pi']
    )
    let releasePoll!: () => void
    runner.calls.length = 0
    runner.tmuxStateGate = new Promise<void>((resolve) => {
      releasePoll = resolve
    })
    const removed: string[] = []
    const unsubscribe = service.events.subscribe((event) => {
      if (event.type === 'terminal.removed') {
        removed.push(String(event.data.terminalId))
      }
    })
    const polling = service.refreshTerminalStatus(terminal.id, false)
    await vi.waitFor(() =>
      expect(
        runner.calls.some(
          (call) =>
            call.args.includes('list-panes') && !call.args.includes('-a')
        )
      ).toBe(true)
    )

    await service.closeProject(project.id)
    releasePoll()
    await expect(polling).rejects.toMatchObject({
      code: expect.stringMatching(/PROJECT_CLOSED|TERMINAL_NOT_FOUND/)
    })
    runner.tmuxStateGate = null
    unsubscribe()
    expect(removed.filter((terminalId) => terminalId === terminal.id)).toEqual([
      terminal.id
    ])
    expect(await service.listProjects()).toEqual([])
  })

  it('keeps a closed registration closed when path-based reopen fails', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    await service.closeProject(project.id)
    const recentBefore = service.listRecentProjects()[0]!
    runner.listWorktreesFails = true

    await expect(service.registerProject(main)).rejects.toThrow(
      'repository unavailable'
    )
    expect(service.database.isProjectOpen(project.id)).toBe(false)
    expect(service.listRecentProjects()).toEqual([recentBefore])
    expect(await service.listProjects()).toEqual([])
  })

  it('opens unavailable registrations but rejects mutations while closed', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const mainWorktree = project.worktrees[0]!
    await service.closeProject(project.id)

    await expect(service.resolveProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_CLOSED'
    })
    await expect(
      service.createWorktree(project.id, 'closed', 'default')
    ).rejects.toMatchObject({ code: 'PROJECT_CLOSED' })
    await expect(
      service.createTerminal(mainWorktree.id, 'Closed', ['pi'])
    ).rejects.toMatchObject({ code: 'PROJECT_CLOSED' })
    expect(() => service.updateProjectColor(project.id, 'violet')).toThrowError(
      expect.objectContaining({ code: 'PROJECT_CLOSED' })
    )

    runner.listWorktreesFails = true
    const reopened = await service.openProject(project.id)
    expect(reopened.availability.state).toBe('unavailable')
    expect(service.database.isProjectOpen(project.id)).toBe(true)
  })

  it('keeps destructive unregister available for a closed registration', async () => {
    const { main, service } = await fixture()
    const project = await service.registerProject(main)
    await service.closeProject(project.id)

    await service.deleteProject(project.id)

    expect(service.database.project(project.id)).toBeNull()
    expect(service.listRecentProjects()).toEqual([])
  })

  it('closes unavailable projects without observing Git', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    runner.calls.length = 0
    runner.listWorktreesFails = true

    await service.closeProject(project.id)

    expect(service.database.isProjectOpen(project.id)).toBe(false)
    expect(
      runner.calls.some(
        (call) => call.args[0] === 'worktree' && call.args[1] === 'list'
      )
    ).toBe(false)
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
