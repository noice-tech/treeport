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
  head: string
  branch: string | null
  locked?: boolean
}

class SystemDouble implements CommandRunner {
  readonly calls: CommandRequest[] = []
  readonly worktrees: FakeWorktree[]
  readonly sessions = new Map<
    string,
    { alive: boolean; exitCode: number | null }
  >()
  dirtyPaths = new Set<string>()
  dirtyStatuses = new Map<string, string>()
  reachable = true
  removeFails = false
  tmuxKillFails = false
  statusGate: Promise<void> | null = null
  worktreeAddGate: Promise<void> | null = null
  tmuxCreateGate: Promise<void> | null = null
  setupGate: Promise<void> | null = null

  constructor(readonly main: string) {
    this.worktrees = [{ path: main, head: 'main-head', branch: 'trunk' }]
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

    if (args[0] === 'worktree' && args[1] === 'list') {
      return ok(
        this.worktrees
          .map(
            (worktree) =>
              `worktree ${worktree.path}\nHEAD ${worktree.head}\n${worktree.branch ? `branch refs/heads/${worktree.branch}` : 'detached'}${worktree.locked ? '\nlocked editor' : ''}\n`
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
      this.worktrees.push({ path: worktreePath, head, branch: null })
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
      this.sessions.set(`${socket}/${session}`, { alive: true, exitCode: null })
      return ok()
    }

    if (args.includes('set-option') || args.includes('source-file')) {
      return ok()
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
      if (this.tmuxKillFails) {
        return fail('tmux shutdown failed')
      }

      const socket = args[args.indexOf('-L') + 1]!
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

  it('does not reconcile a terminal as missing while its tmux session is starting', async () => {
    const { main, runner, service } = await fixture()
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
    const listPanesBeforeSnapshot = runner.calls.filter((call) =>
      call.args.includes('list-panes')
    ).length

    const snapshot = await service.listProjects()
    const snapshotTerminal = snapshot[0]?.worktrees[0]?.terminals.find(
      (terminal) => terminal.name === 'Starting'
    )
    expect(snapshotTerminal?.status).toBe('running')
    expect(
      runner.calls.filter((call) => call.args.includes('list-panes'))
    ).toHaveLength(listPanesBeforeSnapshot)

    releaseTerminal()
    const terminal = await creatingTerminal
    runner.tmuxCreateGate = null
    expect(terminal.status).toBe('running')
    expect(service.getTerminal(terminal.id).status).toBe('running')
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
    expect(service.getTerminal(terminal.id).status).toBe('missing')
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
    expect(database.worktree(afterGit.id)?.status).toBe('removed')
    expect(restarted.getOperation('op_after_git')).toMatchObject({
      status: 'completed',
      result: expect.objectContaining({ recovered: true, removed: true }),
      error: null
    })
    await expect(fs.stat(path.dirname(afterGit.path))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(database.worktree(afterGit.id)?.managedWrapperPath).toBeNull()
    expect(database.worktree(afterGitNonEmpty.id)?.status).toBe('removed')
    expect(restarted.getOperation('op_after_git_non_empty')).toMatchObject({
      status: 'completed',
      result: expect.objectContaining({ recovered: true, removed: true }),
      error: null
    })
    await expect(fs.readFile(preservedMarker, 'utf8')).resolves.toBe('preserve')
    expect(database.worktree(afterGitNonEmpty.id)?.managedWrapperPath).toBe(
      path.dirname(afterGitNonEmpty.path)
    )
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
      head: 'external-head',
      branch: null
    })
    await service.refreshProject(project.id)
    const revived = service.getWorktree(managed.id)
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
