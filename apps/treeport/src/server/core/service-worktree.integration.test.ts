import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { GhAdapter } from './gh'
import { GitAdapter } from './git'
import { TreeportService } from './service'
import { TerminalHostDouble } from './service.integration-fixture'
import { resolveZedWorktreePath } from './zed'
import {
  beginFromPreview,
  fixture,
  integrationService,
  persistedWorktree,
  services,
  waitForOperation
} from './service.integration-fixture'

describe('TreeportService with injected command adapters', () => {
  it('removes a Git-reported prunable worktree', async () => {
    const { main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'prunable', 'default')
    ).worktree
    runner.worktrees.find(
      (worktree) => worktree.path === linked.path
    )!.prunable = true
    await fs.rm(path.join(linked.path, '.git'))
    const preservedFile = path.join(linked.path, 'preserved.txt')
    await fs.writeFile(preservedFile, 'not owned by the stale worktree')

    const observed = await service.getWorktreeSnapshot(linked.id)
    expect(observed.prunable).toBe(true)
    await fs.mkdir(path.join(main, '.treeport'), { recursive: true })
    await fs.writeFile(
      path.join(main, '.treeport', 'setup.json'),
      JSON.stringify({
        version: 1,
        commands: [],
        cleanup: [{ name: 'Cleanup resource', argv: ['cleanup-resource'] }]
      })
    )
    await expect(service.removePreview(linked.id)).resolves.toMatchObject({
      eligible: false,
      cleanup: {
        available: false,
        unavailableReason: expect.stringMatching(/prunable tree/)
      }
    })

    await fs.writeFile(
      path.join(main, '.treeport', 'setup.json'),
      JSON.stringify({ version: 1, commands: [], cleanup: [] })
    )
    const preview = await service.removePreview(linked.id)
    expect(preview).toMatchObject({ eligible: true, warnings: [] })

    await waitForOperation(
      service,
      (
        await service.beginRemove(linked.id, {
          confirmationToken: preview.confirmationToken,
          confirmDestructive: false
        })
      ).id
    )

    expect(await persistedWorktree(database, linked.id)).toBeNull()
    expect(
      runner.worktrees.some((worktree) => worktree.path === linked.path)
    ).toBe(false)
    await expect(fs.readFile(preservedFile, 'utf8')).resolves.toBe(
      'not owned by the stale worktree'
    )
  })

  it('serializes same-project creation lifecycles and drains queued work', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const firstDestination = await resolveZedWorktreePath(main, 'queued-first')
    const secondDestination = await resolveZedWorktreePath(
      main,
      'queued-second'
    )
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    runner.worktreeAddGates.set(
      firstDestination.path,
      new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
    )
    runner.worktreeAddGates.set(
      secondDestination.path,
      new Promise<void>((resolve) => {
        releaseSecond = resolve
      })
    )

    const first = service.createWorktree(
      project.id,
      firstDestination.name,
      'default'
    )
    const second = service.createWorktree(
      project.id,
      secondDestination.name,
      'default'
    )
    await vi.waitFor(() =>
      expect(
        runner.calls.filter(
          (call) => call.args[0] === 'worktree' && call.args[1] === 'add'
        )
      ).toHaveLength(1)
    )
    expect(
      runner.calls.some((call) => call.args.includes(secondDestination.path))
    ).toBe(false)
    await expect(service.closeProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_BUSY'
    })
    await expect(service.deleteProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_BUSY'
    })

    let drained = false
    const draining = service.runEffect(service.drainMutations()).then(() => {
      drained = true
    })
    releaseFirst()
    await expect(first).resolves.toMatchObject({
      worktree: { name: firstDestination.name }
    })
    await vi.waitFor(() =>
      expect(
        runner.calls.some((call) => call.args.includes(secondDestination.path))
      ).toBe(true)
    )
    expect(drained).toBe(false)

    releaseSecond()
    await expect(second).resolves.toMatchObject({
      worktree: { name: secondDestination.name }
    })
    await draining
    expect(drained).toBe(true)
  })

  it('persists, lists, serializes, and completes server-owned creation operations', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const firstDestination = await resolveZedWorktreePath(
      main,
      'owned-first-preview'
    )
    const secondDestination = await resolveZedWorktreePath(main, 'owned-second')
    let releaseFirst!: () => void
    runner.worktreeAddGates.set(
      firstDestination.path,
      new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
    )

    const first = await service.beginCreateWorktree(
      project.id,
      ' Owned Fírst / Preview! ',
      'default',
      { name: 'Agent', argv: ['pi'] },
      undefined,
      {
        issue: 'TREE-123',
        brief: 'Review the cache behavior.'
      }
    )
    const second = await service.beginCreateWorktree(
      project.id,
      secondDestination.name,
      'default'
    )
    expect(first).toMatchObject({
      kind: 'create',
      projectId: project.id,
      status: 'pending',
      request: {
        name: firstDestination.name,
        base: 'default',
        context: {
          issue: 'TREE-123',
          brief: 'Review the cache behavior.'
        },
        initialTerminal: { name: 'Agent', argv: ['pi'] }
      }
    })
    await vi.waitFor(async () =>
      expect(await service.getOperation(first.id)).toMatchObject({
        status: 'running'
      })
    )
    expect(
      await service.listActiveOperations({
        projectId: project.id,
        kind: 'create'
      })
    ).toEqual([
      expect.objectContaining({ id: first.id, status: 'running' }),
      expect.objectContaining({ id: second.id, status: 'pending' })
    ])
    expect(
      runner.calls.some((call) => call.args.includes(secondDestination.path))
    ).toBe(false)

    releaseFirst()
    const firstCompleted = await waitForOperation(service, first.id)
    const secondCompleted = await waitForOperation(service, second.id)
    expect(firstCompleted).toMatchObject({
      status: 'completed',
      worktreeId: expect.any(String),
      result: {
        worktreeId: expect.any(String),
        terminalId: expect.any(String),
        terminalError: null,
        setupError: null
      }
    })
    expect(secondCompleted.status).toBe('completed')
    expect(
      await service.getWorktreeContext(firstCompleted.worktreeId!)
    ).toEqual({
      issue: 'TREE-123',
      brief: 'Review the cache behavior.'
    })
    expect(
      await service.listActiveOperations({
        projectId: project.id,
        kind: 'create'
      })
    ).toEqual([])
  })

  it('records creation failures and partial terminal results without leaving active rows', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    runner.terminalCreateFails = true
    const partial = await service.beginCreateWorktree(
      project.id,
      'partial-create',
      'default',
      { name: 'Agent' }
    )
    const partialResult = await waitForOperation(service, partial.id)
    expect(partialResult).toMatchObject({
      status: 'completed',
      worktreeId: expect.any(String),
      result: {
        terminalId: null,
        terminalError: expect.stringContaining('terminal create failed')
      }
    })

    runner.terminalCreateFails = false
    runner.listWorktreesFails = true
    const failed = await service.beginCreateWorktree(
      project.id,
      'failed-create',
      'default'
    )
    expect(await waitForOperation(service, failed.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('worktree')
    })
    expect(
      await service.listActiveOperations({
        projectId: project.id,
        kind: 'create'
      })
    ).toEqual([])
  })

  it('fails stale creation operations on restart without replaying Git mutations', async () => {
    const { main, runner, service, database, config } = await fixture()
    const project = await service.registerProject(main)
    const timestamp = new Date().toISOString()
    await database.db.run(sql`
      INSERT INTO operations(
        id,kind,project_id,worktree_id,status,request_json,created_at,updated_at
      ) VALUES(
        'op_interrupted_create','create',${project.id},NULL,'running',
        '{"name":"interrupted","base":"default"}',${timestamp},${timestamp}
      )
    `)
    const addCallsBeforeRestart = runner.calls.filter(
      (call) => call.args[0] === 'worktree' && call.args[1] === 'add'
    ).length
    const restarted = integrationService(
      new TreeportService({
        config,
        database,
        runner,
        git: new GitAdapter(runner),
        terminalHost: new TerminalHostDouble(runner),
        gh: new GhAdapter(runner)
      })
    )
    restarted.attachHttpServer(http.createServer())
    services.push(restarted)
    await restarted.runEffect(restarted.initialize())

    expect(await restarted.getOperation('op_interrupted_create')).toMatchObject(
      {
        status: 'failed',
        error: expect.stringContaining('without replaying the creation')
      }
    )
    expect(
      runner.calls.filter(
        (call) => call.args[0] === 'worktree' && call.args[1] === 'add'
      )
    ).toHaveLength(addCallsBeforeRestart)
    expect(
      await restarted.listActiveOperations({
        projectId: project.id,
        kind: 'create'
      })
    ).toEqual([])
  })

  it('continues queued creation after an earlier creation fails', async () => {
    const { main, service } = await fixture()
    const project = await service.registerProject(main)

    const invalid = service.createWorktree(project.id, '', 'default')
    const valid = service.createWorktree(project.id, 'after-failure', 'default')

    await expect(invalid).rejects.toMatchObject({
      code: 'INVALID_WORKTREE_NAME'
    })
    await expect(valid).resolves.toMatchObject({
      worktree: { name: 'after-failure' }
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
    expect(runner.sessions.size).toBe(4)
    await service.deleteTerminal(first.id)
    expect(runner.sessions.size).toBe(3)

    const operation = await beginFromPreview(service, created.worktree.id)
    await service.runEffect(service.drainMutations())
    expect((await service.getOperation(operation.id)).status).toBe('completed')
    expect(runner.sessions.size).toBe(1)
    expect((await service.getProject(project.id)).worktrees).toHaveLength(1)
    expect(
      runner.calls.some(
        (call) => call.args.includes('branch') && call.args.includes('-D')
      )
    ).toBe(false)
  })

  it('runs durable cleanup before Git removal and keeps a failed tree retryable', async () => {
    const { main, runner, service } = await fixture()
    await fs.mkdir(path.join(main, '.treeport'), { recursive: true })
    await fs.writeFile(
      path.join(main, '.treeport', 'setup.json'),
      JSON.stringify({
        version: 1,
        commands: [],
        cleanup: [
          { name: 'First cleanup', argv: ['cleanup-first'] },
          { name: 'Second cleanup', argv: ['cleanup-second'] },
          { name: 'Last cleanup', argv: ['cleanup-last'] }
        ]
      })
    )
    runner.lifecycleCommandResults.set('cleanup-first', {
      stdout: 'first complete\n',
      stderr: '',
      exitCode: 0
    })
    runner.lifecycleCommandResults.set('cleanup-second', {
      stdout: 'partial output\n',
      stderr: 'database refused cleanup\n',
      exitCode: 17
    })
    runner.lifecycleCommandResults.set('cleanup-last', {
      stdout: 'last complete\n',
      stderr: '',
      exitCode: 0
    })

    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'cleanup', 'default')
    ).worktree
    await service.createTerminal(linked.id, 'Development', ['pnpm', 'dev'])
    runner.dirtyPaths.add(linked.path)
    const started: string[] = []
    runner.lifecycleCommandStarted = (request) => {
      started.push(request.executable)
      expect(
        [...runner.sessions.values()].some(
          (terminal) => terminal.worktreeId === linked.id
        )
      ).toBe(false)
    }

    const preview = await service.removePreview(linked.id)
    expect(preview.forceRequired).toBe(true)
    expect(preview.cleanup).toEqual({
      commands: ['First cleanup', 'Second cleanup', 'Last cleanup'],
      available: true,
      unavailableReason: null
    })
    const failed = await waitForOperation(
      service,
      (
        await service.beginRemove(linked.id, {
          confirmationToken: preview.confirmationToken,
          confirmDestructive: true
        })
      ).id
    )
    expect(failed).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/Second cleanup.*Git kept the tree/s),
      request: {
        cleanupCommands: {
          status: 'failed',
          commands: [
            {
              name: 'First cleanup',
              status: 'completed',
              stdout: 'first complete\n'
            },
            {
              name: 'Second cleanup',
              status: 'failed',
              stderr: 'database refused cleanup\n',
              exitCode: 17
            },
            { name: 'Last cleanup', status: 'pending' }
          ]
        }
      }
    })
    expect(started).toEqual(['cleanup-first', 'cleanup-second'])
    await expect(fs.stat(linked.path)).resolves.toBeTruthy()
    await expect(service.getWorktree(linked.id)).resolves.toMatchObject({
      id: linked.id
    })

    runner.lifecycleCommandResults.set('cleanup-second', {
      stdout: 'second complete\n',
      stderr: '',
      exitCode: 0
    })
    const retry = await beginFromPreview(service, linked.id)
    const completed = await waitForOperation(service, retry.id)
    expect(completed).toMatchObject({
      status: 'completed',
      result: {
        cleanup: {
          status: 'completed',
          commands: [
            { name: 'First cleanup', status: 'completed' },
            { name: 'Second cleanup', status: 'completed' },
            { name: 'Last cleanup', status: 'completed' }
          ]
        }
      }
    })
    expect(started).toEqual([
      'cleanup-first',
      'cleanup-second',
      'cleanup-first',
      'cleanup-second',
      'cleanup-last'
    ])
    await expect(fs.stat(linked.path)).rejects.toMatchObject({ code: 'ENOENT' })

    const legacy = (
      await service.createWorktree(project.id, 'legacy-cleanup', 'default')
    ).worktree
    const legacyPreview = await service.removePreview(legacy.id)
    await expect(
      service.beginRemove(legacy.id, {
        confirmationToken: legacyPreview.confirmationToken,
        confirmDestructive: false,
        skipCleanup: true
      })
    ).rejects.toMatchObject({ code: 'REMOVE_CONFIRMATION_REQUIRED' })

    const skipped = await waitForOperation(
      service,
      (
        await service.beginRemove(legacy.id, {
          confirmationToken: legacyPreview.confirmationToken,
          confirmDestructive: true,
          skipCleanup: true
        })
      ).id
    )
    expect(skipped).toMatchObject({
      status: 'completed',
      request: {
        skipCleanup: true,
        cleanupCommands: {
          status: 'skipped',
          skippedReason: 'Project cleanup was skipped by user request',
          commands: []
        }
      },
      result: {
        cleanup: {
          status: 'completed',
          warning: 'Project cleanup was skipped by user request',
          commands: []
        }
      }
    })
    expect(started).toEqual([
      'cleanup-first',
      'cleanup-second',
      'cleanup-first',
      'cleanup-second',
      'cleanup-last'
    ])
    await expect(fs.stat(legacy.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not run native setup when discovering or refreshing an existing worktree', async () => {
    const { root, main, runner, service } = await fixture()
    await fs.mkdir(path.join(main, '.treeport'), { recursive: true })
    await fs.writeFile(
      path.join(main, '.treeport', 'setup.json'),
      JSON.stringify({
        version: 1,
        commands: [
          {
            name: 'must not run during discovery',
            argv: ['discovery-setup-must-not-run']
          }
        ]
      })
    )
    const externalPath = path.join(root, 'external linked worktree')
    const externalGitWorktreeKey = path.join(
      main,
      '.git',
      'worktrees',
      'external'
    )
    await fs.mkdir(externalPath, { recursive: true })
    await fs.writeFile(
      path.join(externalPath, '.git'),
      `gitdir: ${externalGitWorktreeKey}\n`
    )
    runner.worktrees.push({
      path: externalPath,
      gitWorktreeKey: externalGitWorktreeKey,
      head: 'external-head',
      branch: null
    })

    const project = await service.registerProject(main)
    expect(project.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: await fs.realpath(externalPath) })
      ])
    )
    await service.refreshProject(project.id)
    expect(
      runner.calls.some(
        (call) => call.executable === 'discovery-setup-must-not-run'
      )
    ).toBe(false)
  })

  it('starts the initial terminal before setup in a separate one-off terminal', async () => {
    const { main, runner, service, config } = await fixture()
    await fs.mkdir(path.join(main, '.treeport'), { recursive: true })
    await fs.mkdir(path.join(main, '.zed'), { recursive: true })
    await fs.writeFile(
      path.join(main, '.treeport', 'setup.json'),
      JSON.stringify({
        version: 1,
        commands: [
          {
            name: 'setup',
            argv: [
              'fail-setup',
              '${TREEPORT_MAIN_WORKTREE_PATH}/marker',
              'literal value'
            ],
            cwd: 'packages/api',
            env: { GENERATED: '${TREEPORT_WORKTREE_PATH}/generated' },
            timeout: '45s'
          }
        ]
      })
    )
    await fs.writeFile(
      path.join(main, '.zed', 'tasks.json'),
      JSON.stringify([
        {
          label: 'duplicate setup',
          command: 'zed-should-not-run',
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
        argv: ['pi'],
        returnToShell: true,
        initialSize: { cols: 132, rows: 47 }
      }
    )
    unsubscribe()
    expect(result.setupError).toBeNull()
    expect(result.terminal).toMatchObject({ name: 'Pi', argv: ['pi'] })
    expect(result.worktree.name).toBe('hook-failure')
    expect(
      (await service.getProject(project.id)).worktrees.some(
        (item) => item.id === result.worktree.id
      )
    ).toBe(true)

    const terminals = (await service.getWorktreeSnapshot(result.worktree.id))
      .terminals
    const setupTerminal = terminals.find(
      (terminal) => terminal.name === 'Setup'
    )!
    expect(terminals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: result.terminal!.id, status: 'running' }),
        expect.objectContaining({ id: setupTerminal.id, status: 'running' })
      ])
    )
    expect(runner.sessions.size).toBe(3)
    expect(runner.terminalCreateInputs.get(result.terminal!.id)).toMatchObject({
      terminalId: result.terminal!.id,
      initialSize: { cols: 132, rows: 47 }
    })
    expect(runner.terminalCreateInputs.get(setupTerminal.id)).toMatchObject({
      terminalId: setupTerminal.id,
      initialSize: { cols: 132, rows: 47 }
    })
    expect(events).toEqual([
      'worktree.created',
      'terminal.created',
      'terminal.created'
    ])

    const initialLaunchSpec = runner.terminalCreateInputs.get(
      result.terminal!.id
    )!
    expect(initialLaunchSpec.argv).toEqual(['pi'])
    expect(initialLaunchSpec.fallbackArgv).toEqual(['/bin/zsh', '-l'])
    expect(initialLaunchSpec.setupTasks).toBeUndefined()
    expect(initialLaunchSpec.env).toMatchObject({
      PI_IMAGE_PROTOCOL: 'kitty',
      TREEPORT_API_URL: config.apiUrl,
      TREEPORT_MANAGED_API_URL: config.apiUrl,
      TREEPORT_DAEMON_RECORD: path.join(config.runtimeDir, 'daemon.json'),
      TREEPORT_DAEMON_LIFECYCLE: 'external',
      TREEPORT_PROJECT_ID: project.id,
      TREEPORT_WORKTREE_ID: result.worktree.id,
      TREEPORT_TERMINAL_ID: result.terminal!.id
    })

    const setupLaunchSpec = runner.terminalCreateInputs.get(setupTerminal.id)!
    expect(setupLaunchSpec.argv).toEqual(['true'])
    expect(setupLaunchSpec.setupTasks).toEqual([
      {
        label: 'setup',
        argv: [
          'fail-setup',
          `${project.mainWorktreePath}/marker`,
          'literal value'
        ],
        cwd: path.join(result.worktree.path, 'packages', 'api'),
        env: {
          GENERATED: `${result.worktree.path}/generated`,
          TREEPORT_WORKTREE_PATH: result.worktree.path,
          TREEPORT_MAIN_WORKTREE_PATH: project.mainWorktreePath
        },
        timeoutMs: 45_000
      }
    ])
    expect(setupLaunchSpec.env.TREEPORT_TERMINAL_ID).toBe(setupTerminal.id)
    const setupSessionKey = `${result.worktree.id}/${setupTerminal.id}`
    const setupSession = runner.sessions.get(setupSessionKey)!
    expect(setupSession.closeOnSuccess).toBe(true)
    expect(runner.calls.some((call) => call.executable === 'fail-setup')).toBe(
      false
    )

    setupSession.alive = false
    setupSession.exitCode = 0
    expect(
      (await service.getWorktreeSnapshot(result.worktree.id)).terminals.map(
        (terminal) => terminal.id
      )
    ).toEqual([result.terminal!.id])
    expect(runner.sessions.has(setupSessionKey)).toBe(false)

    const direct = await service.createTerminal(
      result.worktree.id,
      'Direct argv',
      ['pi']
    )
    const directLaunchSpec = runner.terminalCreateInputs.get(direct.id)!
    expect(directLaunchSpec.fallbackArgv).toBeUndefined()
  })

  it('retains task preparation and setup-terminal creation errors', async () => {
    const { main, runner, service } = await fixture()
    await fs.mkdir(path.join(main, '.treeport'), { recursive: true })
    await fs.writeFile(
      path.join(main, '.treeport', 'setup.json'),
      '{ invalid json'
    )
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
    const setupTerminal = (
      await service.getWorktreeSnapshot(result.worktree.id)
    ).terminals.find((terminal) => terminal.name === 'Setup')!
    const launchSpec = runner.terminalCreateInputs.get(setupTerminal.id)
    expect(launchSpec?.setupError).toBe(result.setupError)
    expect(launchSpec?.argv).toEqual(['true'])

    let terminalCreates = 0
    const unsubscribe = service.events.subscribe((event) => {
      if (event.type === 'terminal.created') {
        terminalCreates += 1
        runner.terminalCreateFails = true
      }
    })
    const terminalFailure = await service.createWorktree(
      project.id,
      'invalid-setup-terminal',
      'default',
      { name: 'Terminal' }
    )
    unsubscribe()
    runner.terminalCreateFails = false

    expect(terminalCreates).toBe(1)
    expect(terminalFailure.setupError).toContain('Tree setup:')
    expect(terminalFailure.setupError).toContain(
      'Tree setup terminal [TERMINAL_CREATE_FAILED]:'
    )
    expect(
      (
        await service.getWorktreeSnapshot(terminalFailure.worktree.id)
      ).terminals.map((terminal) => terminal.id)
    ).toEqual([terminalFailure.terminal!.id])
  })

  it('requires force for dirty work and leaves a Git worktree retryable after failure', async () => {
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
    expect(failed).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/Git removal failed/)
    })
    expect(await service.getWorktree(linked.id)).toMatchObject({
      id: linked.id,
      path: linked.path
    })
    await expect(service.getTerminal(terminal.id)).rejects.toMatchObject({
      code: 'TERMINAL_NOT_FOUND'
    })
    await expect(
      service.createTerminal(linked.id, 'Available after failed removal')
    ).resolves.toMatchObject({ worktreeId: linked.id })
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
    expect((await service.getProject(project.id)).worktrees).toHaveLength(1)
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

  it('keeps an in-flight removal busy until Git confirms deregistration', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'in-flight', 'default')
    ).worktree
    let releaseRemoval!: () => void
    runner.removeAfterDeregisterGates.set(
      linked.path,
      new Promise<void>((resolve) => {
        releaseRemoval = resolve
      })
    )
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
        quarantinePath: expect.stringContaining('.treeport-removing-op_')
      }
    })
    await deregisteredPromise
    const duringRemoval = await service.getProjectSnapshot(project.id)
    expect(
      duringRemoval.worktrees.find((worktree) => worktree.id === linked.id)
    ).toMatchObject({ id: linked.id })
    expect((await service.getOperation(operation.id)).status).toBe('running')
    await expect(
      service.createTerminal(linked.id, 'Blocked during removal')
    ).rejects.toMatchObject({ code: 'WORKTREE_BUSY' })
    expect(
      (await service.getProjectSnapshot(project.id)).worktrees.find(
        (worktree) => worktree.id === linked.id
      )
    ).toMatchObject({ id: linked.id })
    await expect(fs.stat(linked.path)).resolves.toBeTruthy()
    expect(events.filter((event) => event === 'remove.completed')).toHaveLength(
      0
    )

    releaseRemoval()
    expect((await waitForOperation(service, operation.id)).status).toBe(
      'completed'
    )
    await expect(fs.stat(linked.path)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await persistedWorktree(service.database, linked.id)).toBeNull()
    await expect(
      service.createTerminal(linked.id, 'Blocked after removal')
    ).rejects.toMatchObject({ code: 'WORKTREE_NOT_FOUND' })
    expect(events.filter((event) => event === 'remove.completed')).toHaveLength(
      1
    )
    expect(events.filter((event) => event === 'worktree.removed')).toHaveLength(
      1
    )
    unsubscribe()
  })

  it('removes same-project worktrees in FIFO order without blocking another worktree terminal', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const first = (
      await service.createWorktree(project.id, 'fifo-first', 'default')
    ).worktree
    const second = (
      await service.createWorktree(project.id, 'fifo-second', 'default')
    ).worktree
    const [firstPreview, secondPreview] = await Promise.all([
      service.removePreview(first.id),
      service.removePreview(second.id)
    ])
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    runner.removeAfterDeregisterGates.set(
      first.path,
      new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
    )
    runner.removeAfterDeregisterGates.set(
      second.path,
      new Promise<void>((resolve) => {
        releaseSecond = resolve
      })
    )
    const deregistered = new Set<string>()
    runner.worktreeDeregistered = (worktreePath) => {
      deregistered.add(worktreePath)
    }

    const firstOperation = await service.beginRemove(first.id, {
      confirmationToken: firstPreview.confirmationToken,
      confirmDestructive: firstPreview.warnings.length > 0
    })
    await vi.waitFor(() => expect(deregistered).toEqual(new Set([first.path])))
    let secondRemovalSettled = false
    const secondRemoval = service
      .beginRemove(second.id, {
        confirmationToken: secondPreview.confirmationToken,
        confirmDestructive: secondPreview.warnings.length > 0
      })
      .finally(() => {
        secondRemovalSettled = true
      })
    await Promise.resolve()

    expect(secondRemovalSettled).toBe(false)
    expect((await service.getOperation(firstOperation.id)).status).toBe(
      'running'
    )
    expect(await service.getWorktree(first.id)).toMatchObject({ id: first.id })
    expect(await service.getWorktree(second.id)).toMatchObject({
      id: second.id
    })
    expect(deregistered).toEqual(new Set([first.path]))
    await expect(
      service.beginRemove(first.id, {
        confirmationToken: firstPreview.confirmationToken,
        confirmDestructive: firstPreview.warnings.length > 0
      })
    ).rejects.toMatchObject({ code: 'REMOVE_IN_PROGRESS' })
    const mainWorktree = (await service.getProject(project.id)).worktrees.find(
      (worktree) => worktree.kind === 'main'
    )!
    await expect(
      service.createTerminal(mainWorktree.id, 'Created during removal', ['pi'])
    ).resolves.toMatchObject({
      worktreeId: mainWorktree.id,
      name: 'Created during removal'
    })
    expect((await service.getOperation(firstOperation.id)).status).toBe(
      'running'
    )
    await expect(service.closeProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_BUSY'
    })
    await expect(service.deleteProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_BUSY'
    })

    releaseFirst()
    expect((await waitForOperation(service, firstOperation.id)).status).toBe(
      'completed'
    )
    const secondOperation = await secondRemoval
    await vi.waitFor(() =>
      expect(deregistered).toEqual(new Set([first.path, second.path]))
    )
    expect((await service.getOperation(secondOperation.id)).status).toBe(
      'running'
    )
    expect(await service.getWorktree(second.id)).toMatchObject({
      id: second.id
    })
    await expect(service.deleteProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_BUSY'
    })

    releaseSecond()
    expect((await waitForOperation(service, secondOperation.id)).status).toBe(
      'completed'
    )
    expect((await service.getProject(project.id)).worktrees).toEqual([
      expect.objectContaining({ kind: 'main' })
    ])
  })

  it('revalidates a queued removal before destructive effects', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const first = (
      await service.createWorktree(project.id, 'revalidate-first', 'default')
    ).worktree
    const second = (
      await service.createWorktree(project.id, 'revalidate-second', 'default')
    ).worktree
    const terminal = await service.createTerminal(second.id, 'Preserved', [
      'pi'
    ])
    const [firstPreview, secondPreview] = await Promise.all([
      service.removePreview(first.id),
      service.removePreview(second.id)
    ])
    let releaseFirst!: () => void
    runner.removeAfterDeregisterGates.set(
      first.path,
      new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
    )
    let firstDeregistered!: () => void
    const firstDeregisteredPromise = new Promise<void>((resolve) => {
      firstDeregistered = resolve
    })
    runner.worktreeDeregistered = (worktreePath) => {
      if (worktreePath === first.path) {
        firstDeregistered()
      }
    }

    const firstOperation = await service.beginRemove(first.id, {
      confirmationToken: firstPreview.confirmationToken,
      confirmDestructive: firstPreview.warnings.length > 0
    })
    await firstDeregisteredPromise
    let secondRemovalSettled = false
    const secondRemoval = service
      .beginRemove(second.id, {
        confirmationToken: secondPreview.confirmationToken,
        confirmDestructive: secondPreview.warnings.length > 0
      })
      .then(
        (operation) => ({ operation, error: null }),
        (error) => ({ operation: null, error })
      )
      .finally(() => {
        secondRemovalSettled = true
      })
    await Promise.resolve()
    expect(secondRemovalSettled).toBe(false)

    await fs.rm(second.path, { recursive: true, force: true })
    await fs.mkdir(second.path, { recursive: true })
    const replacement = path.join(second.path, 'replacement.txt')
    await fs.writeFile(replacement, 'preserved replacement')
    releaseFirst()

    expect((await waitForOperation(service, firstOperation.id)).status).toBe(
      'completed'
    )
    await expect(secondRemoval).resolves.toMatchObject({
      error: { code: 'REMOVE_PREVIEW_STALE' }
    })
    await expect(fs.readFile(replacement, 'utf8')).resolves.toBe(
      'preserved replacement'
    )
    expect(
      runner.calls.some(
        (call) =>
          call.args[0] === 'worktree' &&
          call.args[1] === 'remove' &&
          call.args.includes(second.path)
      )
    ).toBe(false)
    expect(
      [...runner.sessions.keys()].some((key) => key.endsWith(`/${terminal.id}`))
    ).toBe(true)
  })

  it('blocks removal while project deletion owns the project lock', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'delete-locked', 'default')
    ).worktree
    const preview = await service.removePreview(linked.id)
    let releaseDeletion!: () => void
    runner.worktreeListGate = new Promise<void>((resolve) => {
      releaseDeletion = resolve
    })
    runner.calls.length = 0

    const deleting = service.deleteProject(project.id)
    await vi.waitFor(() =>
      expect(
        runner.calls.some(
          (call) => call.args[0] === 'worktree' && call.args[1] === 'list'
        )
      ).toBe(true)
    )
    await expect(
      service.beginRemove(linked.id, {
        confirmationToken: preview.confirmationToken,
        confirmDestructive: preview.warnings.length > 0
      })
    ).rejects.toMatchObject({ code: 'REMOVE_IN_PROGRESS' })

    releaseDeletion()
    await expect(deleting).rejects.toMatchObject({
      code: 'PROJECT_HAS_WORKTREES'
    })
    runner.worktreeListGate = null
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
    const missingIdentity = (
      await service.createWorktree(
        project.id,
        'missing-identity-root',
        'default'
      )
    ).worktree
    const timestamp = new Date().toISOString()
    const insertInterrupted = async (
      operationId: string,
      worktree: typeof recoverable,
      includeIdentity: boolean
    ) => {
      const preview = await service.removePreview(worktree.id)
      const checkout = await fs.lstat(worktree.path, { bigint: true })
      const gitWorktreeKey = (await database.db.get<{
        git_worktree_key: string
      }>(sql`
          SELECT git_worktree_key FROM worktrees WHERE id=${worktree.id}
        `))!.git_worktree_key
      const gitMarker = await fs.readFile(
        path.join(worktree.path, '.git'),
        'utf8'
      )
      const repositoryIdentity = null
      await database.db.transaction(async (tx) => {
        await tx.run(sql`
          INSERT INTO operations(
            id,kind,project_id,worktree_id,status,request_json,result_json,error,created_at,updated_at
          ) VALUES(
            ${operationId},'remove',${project.id},${worktree.id},'running',
            ${JSON.stringify(
              includeIdentity
                ? {
                    confirmationToken: preview.confirmationToken,
                    confirmDestructive: true,
                    preview,
                    checkoutIdentity: {
                      path: worktree.path,
                      device: checkout.dev.toString(),
                      inode: checkout.ino.toString(),
                      gitWorktreeKey,
                      gitMarker,
                      repositoryIdentity,
                      managedWrapperPath: worktree.managedWrapperPath,
                      quarantinePath: path.join(
                        path.dirname(worktree.path),
                        `.${path.basename(
                          worktree.path
                        )}.treeport-removing-${operationId}`
                      )
                    },
                    prunable: false,
                    gitWorktreeKey,
                    repositoryIdentity
                  }
                : {
                    confirmationToken: preview.confirmationToken,
                    confirmDestructive: true,
                    preview,
                    checkoutIdentity: null,
                    prunable: false,
                    gitWorktreeKey,
                    repositoryIdentity
                  }
            )},NULL,NULL,${timestamp},${timestamp}
          )
        `)
      })
      return path.join(
        path.dirname(worktree.path),
        `.${path.basename(worktree.path)}.treeport-removing-${operationId}`
      )
    }
    await insertInterrupted('op_recoverable_root', recoverable, true)
    const quarantinePath = await insertInterrupted(
      'op_quarantined_root',
      quarantined,
      true
    )
    await insertInterrupted('op_replaced_root', replaced, true)
    await insertInterrupted('op_repurposed_root', repurposed, true)
    await insertInterrupted('op_missing_identity_root', missingIdentity, false)
    runner.worktrees.splice(1, runner.worktrees.length - 1)
    await fs.writeFile(
      path.join(path.dirname(recoverable.path), 'preserve.txt'),
      'preserve wrapper'
    )
    expect(path.basename(quarantinePath)).toContain('.treeport-removing-')
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

    const restarted = integrationService(
      new TreeportService({
        config,
        database,
        runner,
        git: new GitAdapter(runner),
        terminalHost: new TerminalHostDouble(runner),
        gh: new GhAdapter(runner)
      })
    )
    const events: Array<{ type: string; worktreeId: string }> = []
    const unsubscribe = restarted.events.subscribe((event) => {
      if (event.data.worktreeId !== null) {
        events.push({ type: event.type, worktreeId: event.data.worktreeId })
      }
    })
    await restarted.runEffect(restarted.initialize())
    await Promise.all([
      waitForOperation(restarted, 'op_recoverable_root'),
      waitForOperation(restarted, 'op_quarantined_root'),
      waitForOperation(restarted, 'op_replaced_root'),
      waitForOperation(restarted, 'op_repurposed_root'),
      waitForOperation(restarted, 'op_missing_identity_root')
    ])

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
        entry.includes('.treeport-removing-')
      )
    ).toBe(false)
    expect(await persistedWorktree(database, recoverable.id)).toBeNull()
    expect(await restarted.getOperation('op_recoverable_root')).toMatchObject({
      status: 'completed',
      result: expect.objectContaining({ removed: true, recovered: true })
    })

    await expect(fs.stat(quarantinePath)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(fs.stat(quarantined.path)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await persistedWorktree(database, quarantined.id)).toBeNull()
    expect(await restarted.getOperation('op_quarantined_root')).toMatchObject({
      status: 'completed',
      result: expect.objectContaining({ removed: true, recovered: true })
    })

    await expect(fs.readFile(replacementMarker, 'utf8')).resolves.toBe(
      'replacement'
    )
    expect(await persistedWorktree(database, replaced.id)).toBeNull()
    expect(await waitForOperation(restarted, 'op_replaced_root')).toMatchObject(
      {
        status: 'completed',
        result: expect.objectContaining({
          cleanup: expect.objectContaining({
            status: 'preserved',
            warning: expect.stringMatching(/different filesystem object/i)
          })
        })
      }
    )

    await expect(fs.readFile(repurposedMarker, 'utf8')).resolves.toBe(
      'replacement in the same directory'
    )
    expect(await persistedWorktree(database, repurposed.id)).toBeNull()
    expect(
      await waitForOperation(restarted, 'op_repurposed_root')
    ).toMatchObject({
      status: 'completed',
      result: expect.objectContaining({
        cleanup: expect.objectContaining({
          status: 'preserved',
          warning: expect.stringMatching(/Git marker/i)
        })
      })
    })

    await expect(fs.stat(missingIdentity.path)).resolves.toBeTruthy()
    expect(await persistedWorktree(database, missingIdentity.id)).toBeNull()
    expect(
      await waitForOperation(restarted, 'op_missing_identity_root')
    ).toMatchObject({
      status: 'completed',
      result: expect.objectContaining({
        cleanup: expect.objectContaining({ status: 'preserved' })
      })
    })
    const completionsBeforeSecondPoll = events.filter(
      (event) => event.type === 'remove.completed'
    ).length
    await restarted.getProjectSnapshot(project.id)
    expect(
      events.filter((event) => event.type === 'remove.completed')
    ).toHaveLength(completionsBeforeSecondPoll)
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
          event.type === 'remove.completed' &&
          event.worktreeId === missingIdentity.id
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
    const insertInterrupted = async (
      operationId: string,
      worktree: typeof beforeGit
    ) => {
      const preview = await service.removePreview(worktree.id)
      const binding = await database.db.get<{
        git_worktree_key: string
        managed_wrapper_path: string | null
      }>(sql`
        SELECT git_worktree_key,managed_wrapper_path
        FROM worktrees WHERE id=${worktree.id}
      `)
      const repositoryIdentity = await database.db
        .get<{ repository_identity: string }>(sql`
          SELECT repository_identity FROM projects WHERE id=${project.id}
        `)
        .then((row) => row!.repository_identity)
      const checkout = await fs.lstat(worktree.path, { bigint: true })
      const gitMarker = await fs.readFile(
        path.join(worktree.path, '.git'),
        'utf8'
      )
      const checkoutIdentity = {
        path: worktree.path,
        device: checkout.dev.toString(),
        inode: checkout.ino.toString(),
        gitWorktreeKey: binding!.git_worktree_key,
        gitMarker,
        repositoryIdentity,
        managedWrapperPath: binding!.managed_wrapper_path,
        quarantinePath: path.join(
          path.dirname(worktree.path),
          `.${path.basename(worktree.path)}.treeport-removing-${operationId}`
        )
      }
      await database.db.transaction(async (tx) => {
        await tx.run(sql`
          INSERT INTO operations(
            id,kind,project_id,worktree_id,status,request_json,result_json,error,created_at,updated_at
          ) VALUES(
            ${operationId},'remove',${project.id},${worktree.id},'running',
            ${JSON.stringify({
              confirmationToken: preview.confirmationToken,
              confirmDestructive: true,
              preview,
              checkoutIdentity,
              prunable: false,
              gitWorktreeKey: binding!.git_worktree_key,
              repositoryIdentity,
              phase: 'accepted',
              managedWrapperPath: worktree.managedWrapperPath
            })},NULL,NULL,${timestamp},${timestamp}
          )
        `)
      })
    }
    await insertInterrupted('op_before_git', beforeGit)
    await insertInterrupted('op_after_git', afterGit)
    await insertInterrupted('op_after_git_non_empty', afterGitNonEmpty)
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

    const restarted = integrationService(
      new TreeportService({
        config,
        database,
        runner,
        git: new GitAdapter(runner),
        terminalHost: new TerminalHostDouble(runner),
        gh: new GhAdapter(runner)
      })
    )
    await restarted.runEffect(restarted.initialize())
    await restarted.runEffect(restarted.drainMutations())

    expect(await waitForOperation(restarted, 'op_before_git')).toMatchObject({
      status: 'completed',
      result: expect.objectContaining({ removed: true })
    })
    await expect(restarted.getWorktree(beforeGit.id)).rejects.toMatchObject({
      code: 'WORKTREE_NOT_FOUND'
    })
    expect(await persistedWorktree(database, afterGit.id)).toBeNull()
    expect(await waitForOperation(restarted, 'op_after_git')).toMatchObject({
      status: 'completed',
      result: expect.objectContaining({ recovered: true, removed: true }),
      error: null
    })
    await expect(fs.stat(path.dirname(afterGit.path))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await persistedWorktree(database, afterGit.id)).toBeNull()
    expect(await persistedWorktree(database, afterGitNonEmpty.id)).toBeNull()
    expect(
      await waitForOperation(restarted, 'op_after_git_non_empty')
    ).toMatchObject({
      status: 'completed',
      result: expect.objectContaining({ recovered: true, removed: true }),
      error: null
    })
    await expect(fs.readFile(preservedMarker, 'utf8')).resolves.toBe('preserve')
    expect(await persistedWorktree(database, afterGitNonEmpty.id)).toBeNull()
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
    const revived = (await service.getProject(project.id)).worktrees.find(
      (worktree) => worktree.path === managed.path
    )!
    expect(revived.id).not.toBe(managed.id)
    expect(revived.managedWrapperPath).toBeNull()

    await waitForOperation(
      service,
      (await beginFromPreview(service, revived.id)).id
    )
    await expect(fs.readFile(marker, 'utf8')).resolves.toBe('external')
  })
})
