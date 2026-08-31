import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import { asc, eq, sql } from 'drizzle-orm'
import type { ProjectRecord, WebPanel, WorktreeRecord } from '@treeport/shared'
import type { CommandRequest, CommandResult, CommandRunner } from './command'
import {
  mapProject,
  mapWorktree,
  openDatabase,
  type TreeportDatabase
} from './database'
import { projects, webPanels, worktrees } from './database-schema'
import { GhAdapter } from './gh'
import { GitAdapter } from './git'
import { TreeportService } from './service'
import type { AppConfig } from './config'
import type {
  HostedTerminal,
  TerminalCreateInput,
  TerminalSessionBackend,
  TerminalSessionState
} from './terminal'

const directories: string[] = []
export const databases: TreeportDatabase[] = []
export const services: TreeportService[] = []
afterEach(async () => {
  await Promise.all(
    services.splice(0).map((service) => service.disposeWebPanelRuntime())
  )
  databases.splice(0).forEach((database) => database.close())
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

export async function persistedProject(
  database: TreeportDatabase,
  projectId: string
): Promise<ProjectRecord | null> {
  const [project] = await database.db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  if (!project) {
    return null
  }

  const rows = await database.db
    .select()
    .from(worktrees)
    .where(eq(worktrees.projectId, projectId))
    .orderBy(
      sql`CASE ${worktrees.kind} WHEN 'main' THEN 0 ELSE 1 END`,
      asc(worktrees.createdAt),
      sql`rowid`
    )
  return mapProject(project, rows)
}

export async function persistedWorktree(
  database: TreeportDatabase,
  worktreeId: string
): Promise<WorktreeRecord | null> {
  const [row] = await database.db
    .select({
      worktree: worktrees,
      mainWorktreePath: projects.mainWorktreePath
    })
    .from(worktrees)
    .innerJoin(projects, eq(worktrees.projectId, projects.id))
    .where(eq(worktrees.id, worktreeId))
    .limit(1)
  return row ? mapWorktree(row.worktree, row.mainWorktreePath) : null
}

export async function persistedProjectOpen(
  database: TreeportDatabase,
  projectId: string
): Promise<boolean | null> {
  const [row] = await database.db
    .select({ isOpen: projects.isOpen })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  return row ? Boolean(row.isOpen) : null
}

export async function persistedProjectMetadata(
  database: TreeportDatabase,
  projectId: string
) {
  const [row] = await database.db
    .select({
      identity: projects.repositoryIdentity,
      device: projects.repositoryDevice,
      inode: projects.repositoryInode,
      nameIsCustom: projects.nameIsCustom
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  return row ? { ...row, nameIsCustom: Boolean(row.nameIsCustom) } : null
}

export async function persistedWebPanel(
  database: TreeportDatabase,
  panelId: string
): Promise<WebPanel | null> {
  const [row] = await database.db
    .select()
    .from(webPanels)
    .where(eq(webPanels.id, panelId))
    .limit(1)
  if (!row) {
    return null
  }

  return {
    id: row.id,
    kind: 'web',
    worktreeId: row.worktreeId,
    definitionId: row.definitionId,
    title: row.title,
    launch: {
      // SAFETY: The test fixture provides the asserted contract used here.
      input: JSON.parse(row.inputJson) as WebPanel['launch']['input'],
      cwd: row.launchCwd
    },
    permissions: [],
    sandbox: { allowSameOrigin: false },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

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
    HostedTerminal & { alive: boolean; created: number }
  >()
  readonly terminalCreateInputs = new Map<string, TerminalCreateInput>()
  dirtyPaths = new Set<string>()
  dirtyStatuses = new Map<string, string>()
  reachable = true
  removeFails = false
  listWorktreesFails = false
  worktreeRepairFails = false
  terminalKillWorktreeFails = false
  terminalKillFails = false
  readonly terminalKillFailureWorktrees = new Set<string>()
  statusGate: Promise<void> | null = null
  worktreeListGate: Promise<void> | null = null
  worktreeAddGate: Promise<void> | null = null
  readonly worktreeAddGates = new Map<string, Promise<void>>()
  terminalCreateFails = false
  terminalCreateGate: Promise<void> | null = null
  terminalCreateAttempts = 0
  terminalInventoryFails = false
  terminalInventoryGate: Promise<void> | null = null
  terminalInventoryAttempts = 0
  terminalStateGate: Promise<void> | null = null
  terminalStateAttempts = 0
  setupGate: Promise<void> | null = null
  readonly removeAfterDeregisterGates = new Map<string, Promise<void>>()
  worktreeDeregistered: ((worktreePath: string) => void) | null = null
  repositoryIdentity: string | null = null
  headExists = true

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
      const cwd = request.cwd ?? ''
      const containingWorktree = (
        await Promise.all(
          [this.main, ...this.worktrees.map((worktree) => worktree.path)].map(
            async (worktreePath) => ({
              worktreePath,
              canonicalPath: await fs
                .realpath(worktreePath)
                .catch(() => worktreePath)
            })
          )
        )
      ).find((candidate) => {
        const relative = path.relative(candidate.canonicalPath, cwd)
        return (
          relative === '' ||
          (!relative.startsWith(`..${path.sep}`) &&
            relative !== '..' &&
            !path.isAbsolute(relative))
        )
      })
      return containingWorktree
        ? ok(`${this.main}\n`)
        : fail('fatal: not a git repository (or any parent directory): .git')
    }

    if (
      args[0] === 'rev-list' &&
      args[1] === '--all' &&
      args[2] === '--max-count=1'
    ) {
      return ok(this.headExists ? 'base-commit\n' : '')
    }

    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return this.headExists
        ? ok('base-commit\n')
        : fail('fatal: Needed a single revision')
    }

    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
      return ok(`${path.join(this.main, '.git')}\n`)
    }

    if (args[0] === 'config' && args.includes('treeport.repositoryId')) {
      if (args.includes('--get-all')) {
        const isKnownRepository = (
          await Promise.all(
            [this.main, ...this.worktrees.map((worktree) => worktree.path)].map(
              (worktreePath) =>
                fs
                  .realpath(worktreePath)
                  .catch(() => path.resolve(worktreePath))
            )
          )
        ).includes(request.cwd ?? '')
        return this.repositoryIdentity && isKnownRepository
          ? ok(`${this.repositoryIdentity}\n`)
          : fail('missing')
      }

      const value = args.at(-1)!
      if (args.includes('--add') && this.repositoryIdentity) {
        return ok()
      }

      this.repositoryIdentity = value
      return ok()
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
              `worktree ${worktree.path}\nHEAD ${worktree.head}\n${
                worktree.branch
                  ? `branch refs/heads/${worktree.branch}`
                  : 'detached'
              }${worktree.locked ? '\nlocked editor' : ''}${
                worktree.prunable ? '\nprunable missing' : ''
              }\n`
          )
          .join('\n')
      )
    }

    if (args[0] === 'worktree' && args[1] === 'add') {
      const worktreePath = args.at(-2)!
      const addGate =
        this.worktreeAddGates.get(worktreePath) ?? this.worktreeAddGate
      if (addGate) {
        await addGate
      }

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

    if (args[0] === 'worktree' && args[1] === 'prune') {
      for (let index = this.worktrees.length - 1; index >= 0; index -= 1) {
        if (this.worktrees[index]!.prunable) {
          this.worktrees.splice(index, 1)
        }
      }
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
      this.worktreeDeregistered?.(worktreePath)
      const removeGate = this.removeAfterDeregisterGates.get(worktreePath)
      if (removeGate) {
        await removeGate
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

    return fail(`Unexpected command: ${request.executable} ${args.join(' ')}`)
  }
}

export class TerminalHostDouble implements TerminalSessionBackend {
  constructor(private readonly system: SystemDouble) {}

  initialize(): Promise<boolean> {
    return Promise.resolve(true)
  }

  async createTerminal(input: TerminalCreateInput): Promise<void> {
    this.system.terminalCreateAttempts += 1
    if (this.system.terminalCreateGate) {
      await this.system.terminalCreateGate
    }

    if (this.system.terminalCreateFails) {
      throw new Error('terminal create failed')
    }

    this.system.terminalCreateInputs.set(
      input.terminalId,
      structuredClone(input)
    )
    this.system.sessions.set(`${input.worktreeId}/${input.terminalId}`, {
      id: input.terminalId,
      worktreeId: input.worktreeId,
      name: input.name,
      argv: [...input.argv],
      shellCommand: input.shellCommand,
      interactiveShell: input.interactiveShell,
      closeOnSuccess: input.closeOnSuccess ?? false,
      status: 'running',
      exitCode: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      alive: true,
      created: Math.floor(Date.now() / 1_000)
    })
  }

  async listTerminals(worktreeId: string): Promise<HostedTerminal[]> {
    this.system.terminalInventoryAttempts += 1
    if (this.system.terminalInventoryGate) {
      await this.system.terminalInventoryGate
    }

    if (this.system.terminalInventoryFails) {
      throw new Error('terminal inventory failed')
    }

    return [...this.system.sessions.values()]
      .filter((terminal) => terminal.worktreeId === worktreeId)
      .map(({ alive, created: _created, ...terminal }) => ({
        ...terminal,
        status: alive ? 'running' : 'exited'
      }))
  }

  async terminalState(terminalId: string): Promise<TerminalSessionState> {
    this.system.terminalStateAttempts += 1
    if (this.system.terminalStateGate) {
      await this.system.terminalStateGate
    }

    const terminal = [...this.system.sessions.values()].find(
      (candidate) => candidate.id === terminalId
    )
    return terminal
      ? {
          status: terminal.alive ? 'running' : 'exited',
          exitCode: terminal.exitCode
        }
      : { status: 'missing', exitCode: null }
  }

  async renameTerminal(
    terminalId: string,
    name: string,
    updatedAt: string
  ): Promise<void> {
    const terminal = [...this.system.sessions.values()].find(
      (candidate) => candidate.id === terminalId
    )
    if (terminal) {
      terminal.name = name
      terminal.updatedAt = updatedAt
    }
  }

  listProcesses(): Promise<[]> {
    return Promise.resolve([])
  }

  captureTerminal(): Promise<null> {
    return Promise.resolve(null)
  }

  async killTerminal(terminalId: string): Promise<void> {
    if (this.system.terminalKillFails) {
      throw new Error('terminal cleanup failed')
    }

    for (const [key, terminal] of this.system.sessions) {
      if (terminal.id === terminalId) {
        this.system.sessions.delete(key)
      }
    }
  }

  shutdownIfEmpty(): Promise<void> {
    return Promise.resolve()
  }

  async killWorktree(worktreeId: string): Promise<string[]> {
    if (
      this.system.terminalKillWorktreeFails ||
      this.system.terminalKillFailureWorktrees.has(worktreeId)
    ) {
      throw new Error('terminal host cleanup failed')
    }

    const removed: string[] = []
    for (const [key, terminal] of this.system.sessions) {
      if (terminal.worktreeId === worktreeId) {
        removed.push(terminal.id)
        this.system.sessions.delete(key)
      }
    }
    return removed
  }
}

export async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'treeport integration with spaces ')
  )
  directories.push(root)
  const main = path.join(root, 'main checkout')
  const runtime = path.join(root, 'runtime')
  await fs.mkdir(main, { recursive: true })
  const runner = new SystemDouble(main)
  const database = await openDatabase(path.join(root, 'treeport.db'))
  databases.push(database)
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 8733,
    databasePath: database.filePath,
    dataDir: root,
    cacheDir: path.join(root, 'cache'),
    runtimeDir: runtime,
    shell: '/bin/zsh',
    gitPath: 'git',
    ghPath: 'gh',
    apiUrl: 'http://127.0.0.1:8733',
    daemonLifecycle: 'external',
    webDevelopment: false
  }
  const git = new GitAdapter(runner)
  const terminalHost = new TerminalHostDouble(runner)
  const gh = new GhAdapter(runner)
  const service = new TreeportService({
    config,
    database,
    runner,
    git,
    terminalHost,
    gh
  })
  service.attachHttpServer(http.createServer())
  services.push(service)
  await service.initialize()
  return { root, main, runner, service, database, config }
}

export async function waitForOperation(
  service: TreeportService,
  operationId: string
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const operation = await service.getOperation(operationId)
    if (operation.status === 'completed' || operation.status === 'failed') {
      return operation
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('operation timeout')
}

export async function beginFromPreview(
  service: TreeportService,
  worktreeId: string
) {
  const preview = await service.removePreview(worktreeId)
  return service.beginRemove(worktreeId, {
    confirmationToken: preview.confirmationToken,
    confirmDestructive: preview.warnings.length > 0
  })
}
