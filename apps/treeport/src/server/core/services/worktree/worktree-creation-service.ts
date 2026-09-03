import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { treeContextValuesSchema } from '@treeport/shared'
import type {
  CreateOperationRequest,
  OperationRecord,
  ProjectRecord,
  TerminalRecord,
  TerminalSize,
  TreeContextValues,
  WorktreeRecord
} from '@treeport/shared'
import { and, asc, eq, or, sql } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import type { CommandRunner } from '../../command'
import type { TreeportDatabase } from '../../database'
import { mapOperation, mapWorktree, serializeOperation } from '../../database'
import { operations, projects, worktrees } from '../../database-schema'
import { DomainError } from '../../domain'
import type { ProductEventBus } from '../../events'
import type { GhAdapter } from '../../gh'
import type { GitAdapter } from '../../git'
import {
  resolveWorktreeSetupTasks,
  runWorktreeSetupTasks,
  type WorktreeSetupTask
} from '../../setup'
import type { TerminalSessionBackend } from '../../terminal'
import {
  normalizeWorktreeName,
  prepareZedWorktreeWrapper,
  resolveZedWorktreePath
} from '../../zed'
import type {
  PromiseMutationLocks,
  PromiseMutationQueue
} from '../infrastructure/application-runtime'

const now = (): string => new Date().toISOString()
const id = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`

interface TerminalLaunchOptions {
  setup?: { tasks: WorktreeSetupTask[]; error: string | null }
  initialTitle?: string
  returnToShell?: boolean
  closeOnSuccess?: boolean
  initialSize?: TerminalSize
  cwd?: string
  env?: Record<string, string>
  shellCommand?: string
}

export interface CreateWorktreeResult {
  worktree: WorktreeRecord
  terminal: TerminalRecord | null
  terminalError: string | null
  setupError: string | null
}

export interface WorktreeServiceDependencies {
  readonly config: AppConfig
  readonly database: TreeportDatabase
  readonly runner: CommandRunner
  readonly git: GitAdapter
  readonly terminalHost: TerminalSessionBackend
  readonly gh: GhAdapter
  readonly events: ProductEventBus
  readonly locks: PromiseMutationLocks
  readonly worktreeMutations: PromiseMutationQueue
  readonly terminalMutations: PromiseMutationQueue
  readonly requireOpenProject: (projectId: string) => Promise<ProjectRecord>
  readonly observeAvailableProject: (
    project: ProjectRecord,
    allowClosed?: boolean
  ) => Promise<ProjectRecord>
  readonly importWorktrees: (
    projectId: string,
    repositoryPath: string,
    mainPath: string,
    allowProjectLock?: boolean,
    allowClosed?: boolean
  ) => Promise<void>
  readonly getProject: (projectId: string) => Promise<ProjectRecord>
  readonly getWorktree: (worktreeId: string) => Promise<WorktreeRecord>
  readonly getOperation: (operationId: string) => Promise<OperationRecord>
  readonly storedProject: (projectId: string) => Promise<ProjectRecord | null>
  readonly storedWorktree: (
    worktreeId: string
  ) => Promise<WorktreeRecord | null>
  readonly storedOperation: (
    operationId: string
  ) => Promise<OperationRecord | null>
  readonly requireAvailableWorktree: (
    worktreeId: string,
    allowPrunable?: boolean
  ) => Promise<WorktreeRecord>
  readonly listWorktreeTerminals: (
    worktree: WorktreeRecord
  ) => Promise<TerminalRecord[]>
  readonly createTerminal: (
    worktreeId: string,
    name: string,
    argv?: string[],
    options?: TerminalLaunchOptions
  ) => Promise<TerminalRecord>
  readonly ensureWorktreeTerminal: (
    worktreeId: string
  ) => Promise<TerminalRecord | null>
  readonly clearWorktreeTerminalState: (
    worktreeId: string,
    discoveredTerminalIds?: Iterable<string>
  ) => void
  readonly invalidateProjectsSnapshot: () => void
}

export class WorktreeCreationService {
  constructor(private readonly host: WorktreeServiceDependencies) {}

  private get deps() {
    return this.host
  }

  private get events() {
    return this.host.events
  }

  private get locks() {
    return this.host.locks
  }

  private get worktreeMutations() {
    return this.host.worktreeMutations
  }

  private get terminalMutations() {
    return this.host.terminalMutations
  }

  private requireOpenProject(projectId: string) {
    return this.host.requireOpenProject(projectId)
  }

  private observeAvailableProject(project: ProjectRecord, allowClosed = false) {
    return this.host.observeAvailableProject(project, allowClosed)
  }

  private importWorktrees(
    projectId: string,
    repositoryPath: string,
    mainPath: string,
    allowProjectLock = false,
    allowClosed = false
  ) {
    return this.host.importWorktrees(
      projectId,
      repositoryPath,
      mainPath,
      allowProjectLock,
      allowClosed
    )
  }

  private getProject(projectId: string) {
    return this.host.getProject(projectId)
  }

  private getWorktree(worktreeId: string) {
    return this.host.getWorktree(worktreeId)
  }

  private getOperation(operationId: string) {
    return this.host.getOperation(operationId)
  }

  private storedProject(projectId: string) {
    return this.host.storedProject(projectId)
  }

  private storedWorktree(worktreeId: string) {
    return this.host.storedWorktree(worktreeId)
  }

  private storedOperation(operationId: string) {
    return this.host.storedOperation(operationId)
  }

  private requireAvailableWorktree(worktreeId: string, allowPrunable = false) {
    return this.host.requireAvailableWorktree(worktreeId, allowPrunable)
  }

  private listWorktreeTerminals(worktree: WorktreeRecord) {
    return this.host.listWorktreeTerminals(worktree)
  }

  private executeCreateTerminal(
    worktreeId: string,
    name: string,
    argv?: string[],
    options?: TerminalLaunchOptions
  ) {
    return this.host.createTerminal(worktreeId, name, argv, options)
  }

  private ensureWorktreeTerminal(worktreeId: string) {
    return this.host.ensureWorktreeTerminal(worktreeId)
  }

  private clearWorktreeTerminalState(
    worktreeId: string,
    discoveredTerminalIds: Iterable<string> = []
  ) {
    return this.host.clearWorktreeTerminalState(
      worktreeId,
      discoveredTerminalIds
    )
  }

  private invalidateProjectsSnapshot() {
    this.host.invalidateProjectsSnapshot()
  }

  async listActiveOperations(
    filters: {
      projectId?: string
      kind?: OperationRecord['kind']
    } = {}
  ): Promise<OperationRecord[]> {
    if (filters.projectId) {
      await this.requireOpenProject(filters.projectId)
    }

    const rows = await this.deps.database.db
      .select()
      .from(operations)
      .where(
        and(
          or(
            eq(operations.status, 'pending'),
            eq(operations.status, 'running')
          ),
          ...(filters.projectId
            ? [eq(operations.projectId, filters.projectId)]
            : []),
          ...(filters.kind ? [eq(operations.kind, filters.kind)] : [])
        )
      )
      .orderBy(asc(operations.createdAt), asc(operations.id))
    return rows.map(mapOperation)
  }

  async beginCreateWorktree(
    projectId: string,
    inputName: string,
    base: 'default' | 'current',
    initialTerminal?: {
      name: string
      initialTitle?: string
      argv?: string[]
      returnToShell?: boolean
      initialSize?: TerminalSize
    },
    sourceWorktreeId?: string,
    treeContext?: TreeContextValues
  ): Promise<OperationRecord> {
    const project = await this.requireOpenProject(projectId)
    if (project.kind === 'folder') {
      throw new DomainError(
        'PROJECT_HAS_NO_GIT_REPOSITORY',
        'Linked worktrees require a Git repository project',
        409
      )
    }

    let name: string
    try {
      name = normalizeWorktreeName(inputName)
    } catch (error) {
      throw new DomainError(
        'INVALID_WORKTREE_NAME',
        error instanceof Error ? error.message : String(error),
        400
      )
    }
    if (
      (await this.locks.isProjectLocked(projectId)) &&
      !(await this.worktreeMutations.isBusy(projectId))
    ) {
      throw new DomainError(
        'PROJECT_BUSY',
        'Project is already being modified',
        409
      )
    }

    const operationId = id('op')
    const timestamp = now()
    const request: CreateOperationRequest = { name, base }
    if (initialTerminal) {
      request.initialTerminal = initialTerminal
    }

    if (sourceWorktreeId) {
      request.sourceWorktreeId = sourceWorktreeId
    }

    if (treeContext && Object.keys(treeContext).length > 0) {
      request.context = treeContext
    }

    await this.deps.database.db.run(sql`
      INSERT INTO operations(
        id,kind,project_id,worktree_id,status,request_json,result_json,error,
        created_at,updated_at
      ) VALUES(
        ${operationId},'create',${projectId},NULL,'pending',
        ${serializeOperation(request)},NULL,NULL,${timestamp},${timestamp}
      )
    `)
    const operation = await this.getOperation(operationId)
    this.events.publish('create.started', { projectId, operationId })

    void this.worktreeMutations
      .enqueue(projectId, () =>
        this.executeCreateOperation(
          operationId,
          projectId,
          name,
          base,
          initialTerminal,
          sourceWorktreeId,
          treeContext
        )
      )
      .catch(() => undefined)
    return operation
  }

  private async executeCreateOperation(
    operationId: string,
    projectId: string,
    inputName: string,
    base: 'default' | 'current',
    initialTerminal?: {
      name: string
      initialTitle?: string
      argv?: string[]
      returnToShell?: boolean
      initialSize?: TerminalSize
    },
    sourceWorktreeId?: string,
    treeContext?: TreeContextValues
  ): Promise<void> {
    await this.deps.database.db.run(sql`
      UPDATE operations SET status='running',updated_at=${now()}
      WHERE id=${operationId} AND status='pending'
    `)
    try {
      const result = await this.executeCreateWorktree(
        projectId,
        inputName,
        base,
        initialTerminal,
        sourceWorktreeId,
        treeContext
      )
      const timestamp = now()
      await this.deps.database.db.run(sql`
        UPDATE operations
        SET status='completed',worktree_id=${result.worktree.id},
            result_json=${serializeOperation({
              worktreeId: result.worktree.id,
              terminalId: result.terminal?.id ?? null,
              terminalError: result.terminalError,
              setupError: result.setupError
            })},error=NULL,updated_at=${timestamp}
        WHERE id=${operationId}
      `)
      this.events.publish('create.completed', {
        projectId,
        operationId,
        worktreeId: result.worktree.id
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.deps.database.db.run(sql`
        UPDATE operations
        SET status='failed',error=${message.slice(0, 4_096)},updated_at=${now()}
        WHERE id=${operationId}
      `)
      this.events.publish('create.failed', { projectId, operationId })
    }
  }

  async createWorktree(
    projectId: string,
    inputName: string,
    base: 'default' | 'current',
    initialTerminal?: {
      name: string
      initialTitle?: string
      argv?: string[]
      returnToShell?: boolean
      initialSize?: TerminalSize
    },
    sourceWorktreeId?: string,
    treeContext?: TreeContextValues
  ): Promise<CreateWorktreeResult> {
    const project = await this.requireOpenProject(projectId)
    if (project.kind === 'folder') {
      throw new DomainError(
        'PROJECT_HAS_NO_GIT_REPOSITORY',
        'Linked worktrees require a Git repository project',
        409
      )
    }

    if (
      (await this.locks.isProjectLocked(projectId)) &&
      !(await this.worktreeMutations.isBusy(projectId))
    ) {
      throw new DomainError(
        'PROJECT_BUSY',
        'Project is already being modified',
        409
      )
    }

    return this.worktreeMutations.enqueue(projectId, () =>
      this.executeCreateWorktree(
        projectId,
        inputName,
        base,
        initialTerminal,
        sourceWorktreeId,
        treeContext
      )
    )
  }

  private async executeCreateWorktree(
    projectId: string,
    inputName: string,
    base: 'default' | 'current',
    initialTerminal?: {
      name: string
      initialTitle?: string
      argv?: string[]
      returnToShell?: boolean
      initialSize?: TerminalSize
    },
    sourceWorktreeId?: string,
    treeContext?: TreeContextValues
  ): Promise<CreateWorktreeResult> {
    const contextValues = treeContextValuesSchema.parse(treeContext ?? {})
    await this.requireOpenProject(projectId)
    if (!(await this.locks.tryAcquire({ projectId }))) {
      throw new DomainError(
        'PROJECT_BUSY',
        'Project is already being modified',
        409
      )
    }

    let projectLockHeld = true
    let worktreePath: string
    let wrapperPath: string
    let project!: ProjectRecord
    let wrapperCreated = false
    try {
      project = await this.observeAvailableProject(
        await this.requireOpenProject(projectId)
      )
      if (project.kind === 'folder') {
        throw new DomainError(
          'PROJECT_HAS_NO_GIT_REPOSITORY',
          'Linked worktrees require a Git repository project',
          409
        )
      }

      let name: string
      try {
        name = normalizeWorktreeName(inputName)
      } catch (error) {
        throw new DomainError(
          'INVALID_WORKTREE_NAME',
          error instanceof Error ? error.message : String(error),
          400
        )
      }
      if (
        project.worktrees.some(
          (worktree) =>
            worktree.name.localeCompare(name, undefined, {
              sensitivity: 'accent'
            }) === 0
        )
      ) {
        throw new DomainError(
          'WORKTREE_EXISTS',
          `A tree named ${name} already exists`,
          409
        )
      }

      const destination = await resolveZedWorktreePath(
        project.mainWorktreePath,
        name
      ).catch((error) => {
        throw new DomainError(
          'INVALID_WORKTREE_PATH',
          error instanceof Error ? error.message : String(error),
          400
        )
      })
      worktreePath = destination.path
      wrapperPath = destination.wrapperPath
      const pathExists = await fs.access(worktreePath).then(
        () => true,
        () => false
      )
      if (pathExists) {
        throw new DomainError(
          'WORKTREE_PATH_EXISTS',
          `Destination already exists: ${worktreePath}`,
          409
        )
      }

      let commit: string
      if (base === 'current') {
        if (!sourceWorktreeId) {
          throw new DomainError(
            'INVALID_SOURCE_WORKTREE',
            'A source tree is required when starting from current',
            400
          )
        }

        const source = await this.getWorktree(sourceWorktreeId)
        if (source.projectId !== projectId || source.prunable) {
          throw new DomainError(
            'INVALID_SOURCE_WORKTREE',
            'The source tree must be active and belong to the project',
            400
          )
        }

        commit = await this.deps.git.resolveCommit(source.path)
      } else {
        commit = await this.deps.git.resolveDefaultCommit(
          project.repositoryPath
        )
      }

      let preparedWrapper: Awaited<ReturnType<typeof prepareZedWorktreeWrapper>>
      try {
        preparedWrapper = await prepareZedWorktreeWrapper(
          project.mainWorktreePath,
          wrapperPath
        )
      } catch (error) {
        throw new DomainError(
          'INVALID_WORKTREE_PATH',
          error instanceof Error ? error.message : String(error),
          400
        )
      }
      wrapperCreated = preparedWrapper.created
      wrapperPath = preparedWrapper.path
      worktreePath = path.join(
        wrapperPath,
        path.basename(project.mainWorktreePath)
      )
      try {
        await this.deps.git.createDetachedWorktree(
          project.repositoryPath,
          worktreePath,
          commit
        )
      } catch (error) {
        if (wrapperCreated) {
          await fs.rmdir(wrapperPath).catch(() => undefined)
        }

        throw error
      }
      await this.importWorktrees(
        project.id,
        project.repositoryPath,
        project.mainWorktreePath,
        true
      )
      await this.deps.database.db.run(sql`
        UPDATE worktrees
        SET managed_wrapper_path=${wrapperCreated ? wrapperPath : null},
            tree_context_json=${JSON.stringify(contextValues)}
        WHERE path=${worktreePath}
      `)
      const [worktreeRow] = await this.deps.database.db
        .select({
          worktree: worktrees,
          mainWorktreePath: projects.mainWorktreePath
        })
        .from(worktrees)
        .innerJoin(projects, eq(worktrees.projectId, projects.id))
        .where(eq(worktrees.path, worktreePath!))
        .limit(1)
      const worktree = worktreeRow
        ? mapWorktree(worktreeRow.worktree, worktreeRow.mainWorktreePath)
        : null
      if (!worktree) {
        throw new DomainError(
          'WORKTREE_DISCOVERY_FAILED',
          'Git created the worktree but it could not be discovered',
          500
        )
      }

      this.events.publish('worktree.created', {
        projectId,
        worktreeId: worktree.id
      })

      await this.locks.release({ projectId: projectId })
      projectLockHeld = false

      let terminal: TerminalRecord | null = null
      let terminalError: string | null = null
      let setupError: string | null = null
      if (initialTerminal) {
        const launchOptions: TerminalLaunchOptions = {}
        if (initialTerminal.initialTitle) {
          launchOptions.initialTitle = initialTerminal.initialTitle
        }

        if (initialTerminal.returnToShell) {
          launchOptions.returnToShell = true
        }

        if (initialTerminal.initialSize) {
          launchOptions.initialSize = initialTerminal.initialSize
        }

        const initialTerminalCreation = this.executeCreateTerminal(
          worktree.id,
          initialTerminal.name,
          initialTerminal.argv,
          launchOptions
        )
        const setupResolution = resolveWorktreeSetupTasks({
          shell: this.deps.config.shell,
          mainWorktreePath: project.mainWorktreePath,
          worktreePath: worktree.path
        }).then(
          (tasks) => ({ tasks, error: null }),
          (error) => ({
            // SAFETY: The surrounding boundary contract establishes this asserted value.
            tasks: [] as WorktreeSetupTask[],
            error: `Tree setup: ${
              error instanceof Error ? error.message : String(error)
            }`.slice(0, 4_096)
          })
        )

        try {
          terminal = await initialTerminalCreation
        } catch (error) {
          terminalError = error instanceof Error ? error.message : String(error)
        }
        if (!terminal) {
          try {
            terminal = await this.ensureWorktreeTerminal(worktree.id)
          } catch (error) {
            terminalError ??=
              error instanceof Error ? error.message : String(error)
          }
        }

        const setup = await setupResolution
        setupError = setup.error
        if (setup.tasks.length > 0 || setupError) {
          if (!terminal) {
            setupError ??= 'Tree setup: no persistent terminal could be started'
          } else {
            try {
              const setupOptions: TerminalLaunchOptions = {
                setup: { tasks: setup.tasks, error: setupError },
                closeOnSuccess: true
              }
              if (initialTerminal.initialSize) {
                setupOptions.initialSize = initialTerminal.initialSize
              }

              await this.executeCreateTerminal(
                worktree.id,
                'Setup',
                ['true'],
                setupOptions
              )
            } catch (error) {
              const setupTerminalError = `Tree setup terminal${
                error instanceof DomainError ? ` [${error.code}]` : ''
              }: ${
                error instanceof Error ? error.message : String(error)
              }`.slice(0, 2_048)
              setupError = setupError
                ? `${setupError.slice(0, 2_047)}\n${setupTerminalError}`
                : setupTerminalError
            }
          }
        }
      } else {
        const setupResults = await resolveWorktreeSetupTasks({
          shell: this.deps.config.shell,
          mainWorktreePath: project.mainWorktreePath,
          worktreePath: worktree.path
        })
          .then((tasks) =>
            runWorktreeSetupTasks({ runner: this.deps.runner, tasks })
          )
          .catch((error) => [
            {
              label: 'Tree setup',
              error: error instanceof Error ? error.message : String(error)
            }
          ])
        const setupFailure = setupResults.find((result) => result.error)
        setupError = setupFailure
          ? `${setupFailure.label}: ${setupFailure.error}`.slice(0, 4_096)
          : null
      }

      try {
        terminal ??= await this.ensureWorktreeTerminal(worktree.id)
      } catch (error) {
        terminalError ??= error instanceof Error ? error.message : String(error)
      }

      this.invalidateProjectsSnapshot()
      return {
        worktree: await this.getWorktree(worktree.id),
        terminal,
        terminalError,
        setupError
      }
    } finally {
      if (projectLockHeld) {
        await this.locks.release({ projectId: projectId })
      }
    }
  }
}
