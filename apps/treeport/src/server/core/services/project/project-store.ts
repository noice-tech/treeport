import type {
  OperationRecord,
  ProjectRecord,
  WorktreeRecord
} from '@treeport/shared'
import { asc, eq, sql } from 'drizzle-orm'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { mapOperation, mapProject, mapWorktree } from '../../database'
import { operations, projects, worktrees } from '../../database-schema'
import { DomainError } from '../../domain'
import { DatabasePort } from '../infrastructure/ports'

export interface ProjectStoreService {
  readonly storedProjects: (
    openOnly?: boolean
  ) => Effect.Effect<ProjectRecord[]>
  readonly storedProject: (
    projectId: string
  ) => Effect.Effect<ProjectRecord | null>
  readonly storedWorktree: (
    worktreeId: string
  ) => Effect.Effect<WorktreeRecord | null>
  readonly projectOpenState: (
    projectId: string
  ) => Effect.Effect<boolean | null>
  readonly storedOperation: (
    operationId: string
  ) => Effect.Effect<OperationRecord | null>
  readonly getProject: (
    projectId: string
  ) => Effect.Effect<ProjectRecord, DomainError<unknown>>
  readonly requireOpenProject: (
    projectId: string
  ) => Effect.Effect<ProjectRecord, DomainError<unknown>>
  readonly getWorktree: (
    worktreeId: string
  ) => Effect.Effect<WorktreeRecord, DomainError<unknown>>
  readonly getOperation: (
    operationId: string
  ) => Effect.Effect<OperationRecord, DomainError<unknown>>
}

/** Reads durable project, worktree, and operation state for domain workflows. */
export class ProjectStore extends Context.Tag('treeport/ProjectStore')<
  ProjectStore,
  ProjectStoreService
>() {}

export const ProjectStoreLive = Layer.effect(
  ProjectStore,
  Effect.gen(function* () {
    const database = yield* DatabasePort

    const storedProjects = (openOnly = false): Effect.Effect<ProjectRecord[]> =>
      Effect.gen(function* () {
        const projectRows = yield* Effect.promise(() =>
          database.db
            .select()
            .from(projects)
            .where(openOnly ? eq(projects.isOpen, 1) : undefined)
            .orderBy(sql`${projects.name} COLLATE NOCASE`)
        )
        const worktreeRows = yield* Effect.promise(() =>
          database.db
            .select()
            .from(worktrees)
            .orderBy(
              asc(worktrees.projectId),
              sql`CASE ${worktrees.kind} WHEN 'main' THEN 0 ELSE 1 END`,
              asc(worktrees.createdAt),
              sql`rowid`
            )
        )
        return projectRows.map((project) =>
          mapProject(
            project,
            worktreeRows.filter((worktree) => worktree.projectId === project.id)
          )
        )
      })

    const storedProject = (
      projectId: string
    ): Effect.Effect<ProjectRecord | null> =>
      Effect.gen(function* () {
        const [project] = yield* Effect.promise(() =>
          database.db
            .select()
            .from(projects)
            .where(eq(projects.id, projectId))
            .limit(1)
        )
        if (!project) {
          return null
        }

        const worktreeRows = yield* Effect.promise(() =>
          database.db
            .select()
            .from(worktrees)
            .where(eq(worktrees.projectId, projectId))
            .orderBy(
              sql`CASE ${worktrees.kind} WHEN 'main' THEN 0 ELSE 1 END`,
              asc(worktrees.createdAt),
              sql`rowid`
            )
        )
        return mapProject(project, worktreeRows)
      })

    const storedWorktree = (
      worktreeId: string
    ): Effect.Effect<WorktreeRecord | null> =>
      Effect.gen(function* () {
        const [row] = yield* Effect.promise(() =>
          database.db
            .select({
              worktree: worktrees,
              mainWorktreePath: projects.mainWorktreePath
            })
            .from(worktrees)
            .innerJoin(projects, eq(worktrees.projectId, projects.id))
            .where(eq(worktrees.id, worktreeId))
            .limit(1)
        )
        return row ? mapWorktree(row.worktree, row.mainWorktreePath) : null
      })

    const projectOpenState = (
      projectId: string
    ): Effect.Effect<boolean | null> =>
      Effect.gen(function* () {
        const [row] = yield* Effect.promise(() =>
          database.db
            .select({ isOpen: projects.isOpen })
            .from(projects)
            .where(eq(projects.id, projectId))
            .limit(1)
        )
        return row ? Boolean(row.isOpen) : null
      })

    const storedOperation = (
      operationId: string
    ): Effect.Effect<OperationRecord | null> =>
      Effect.gen(function* () {
        const [row] = yield* Effect.promise(() =>
          database.db
            .select()
            .from(operations)
            .where(eq(operations.id, operationId))
            .limit(1)
        )
        return row ? mapOperation(row) : null
      })

    const getProject = (
      projectId: string
    ): Effect.Effect<ProjectRecord, DomainError<unknown>> =>
      storedProject(projectId).pipe(
        Effect.flatMap((project) =>
          project
            ? Effect.succeed(project)
            : Effect.fail(
                new DomainError('PROJECT_NOT_FOUND', 'Project not found', 404)
              )
        )
      )

    const requireOpenProject = (
      projectId: string
    ): Effect.Effect<ProjectRecord, DomainError<unknown>> =>
      Effect.gen(function* () {
        const project = yield* getProject(projectId)
        if ((yield* projectOpenState(projectId)) !== true) {
          return yield* Effect.fail(
            new DomainError(
              'PROJECT_CLOSED',
              'Project is closed; open it before modifying it',
              409
            )
          )
        }

        return project
      })

    const getWorktree = (
      worktreeId: string
    ): Effect.Effect<WorktreeRecord, DomainError<unknown>> =>
      storedWorktree(worktreeId).pipe(
        Effect.flatMap((worktree) =>
          worktree
            ? Effect.succeed(worktree)
            : Effect.fail(
                new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
              )
        )
      )

    const getOperation = (
      operationId: string
    ): Effect.Effect<OperationRecord, DomainError<unknown>> =>
      storedOperation(operationId).pipe(
        Effect.flatMap((operation) =>
          operation
            ? Effect.succeed(operation)
            : Effect.fail(
                new DomainError(
                  'OPERATION_NOT_FOUND',
                  'Operation not found',
                  404
                )
              )
        )
      )

    return {
      storedProjects,
      storedProject,
      storedWorktree,
      projectOpenState,
      storedOperation,
      getProject,
      requireOpenProject,
      getWorktree,
      getOperation
    }
  })
)
