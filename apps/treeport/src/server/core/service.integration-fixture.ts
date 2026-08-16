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
import { TmuxAdapter } from './tmux'
import type { AppConfig } from './config'

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

export class SystemDouble implements CommandRunner {
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
  tmuxKillSessionFails = false
  readonly tmuxKillFailureSockets = new Set<string>()
  statusGate: Promise<void> | null = null
  worktreeListGate: Promise<void> | null = null
  worktreeAddGate: Promise<void> | null = null
  readonly worktreeAddGates = new Map<string, Promise<void>>()
  tmuxCreateFails = false
  tmuxCreateGate: Promise<void> | null = null
  tmuxInventoryFails = false
  tmuxInventoryGate: Promise<void> | null = null
  tmuxStateGate: Promise<void> | null = null
  setupGate: Promise<void> | null = null
  readonly removeAfterDeregisterGates = new Map<string, Promise<void>>()
  worktreeDeregistered: ((worktreePath: string) => void) | null = null
  repositoryIdentity: string | null = null

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

    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return ok('base-commit\n')
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

    if (args.includes('new-session')) {
      if (this.tmuxCreateGate) {
        await this.tmuxCreateGate
      }

      if (this.tmuxCreateFails) {
        return fail('tmux create failed')
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
      const socket = args[args.indexOf('-L') + 1]!
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] !== 'set-option') {
          continue
        }

        const targetIndex = args.indexOf('-t', index)
        const session = args[targetIndex + 1]!
        const state = this.sessions.get(`${socket}/${session}`)
        if (!state) {
          return fail('missing')
        }

        const key = args[targetIndex + 2]!
        const value = args[targetIndex + 3]!
        state.options[key] = value
      }
      return ok()
    }

    if (args.includes('start-server') || args.includes('source-file')) {
      return ok()
    }

    if (args.includes('list-panes') && args.includes('-a')) {
      if (this.tmuxInventoryFails) {
        return fail('tmux inventory failed')
      }

      if (this.tmuxInventoryGate) {
        await this.tmuxInventoryGate
      }

      const socket = args[args.indexOf('-L') + 1]!
      const lines = [...this.sessions.entries()]
        .filter(([key]) => key.startsWith(`${socket}/`))
        .map(([key, state]) => {
          const session = key.slice(socket.length + 1)
          return [
            session,
            state.options['@treeport-terminal-id'] ?? '',
            state.options['@treeport-worktree-id'] ?? '',
            state.options['@treeport-name'] ?? '',
            state.options['@treeport-argv'] ?? '',
            state.options['@treeport-close-on-success'] ?? '',
            state.options['@treeport-created-at'] ?? '',
            state.options['@treeport-updated-at'] ?? '',
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
      if (this.tmuxKillSessionFails) {
        return fail('tmux session cleanup failed')
      }

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
    tmuxPath: 'tmux',
    gitPath: 'git',
    ghPath: 'gh',
    apiUrl: 'http://127.0.0.1:8733',
    daemonLifecycle: 'external',
    webDevelopment: false
  }
  const git = new GitAdapter(runner)
  const tmux = new TmuxAdapter(
    runner,
    runtime,
    'tmux',
    '/launcher with spaces.js'
  )
  const gh = new GhAdapter(runner)
  const service = new TreeportService({
    config,
    database,
    runner,
    git,
    tmux,
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
