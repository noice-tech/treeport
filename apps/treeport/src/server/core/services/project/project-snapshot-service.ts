import { webPanelInputSchema } from '@treeport/shared'
import type {
  BrowserPanel,
  ProjectRecord,
  RecentProjectRecord,
  TerminalRecord,
  WebPanel,
  WebPanelDefinition,
  WebPanelPermission,
  WorktreeRecord
} from '@treeport/shared'
import { and, asc, desc, eq } from 'drizzle-orm'
import type { TreeportDatabase } from '../../database'
import { browserPanels, projects, webPanels } from '../../database-schema'
import { DomainError } from '../../domain'
import type { GitAdapter } from '../../git'

export interface ProjectSnapshotDependencies {
  readonly database: TreeportDatabase
  readonly git: GitAdapter
  readonly storedProjects: (openOnly?: boolean) => Promise<ProjectRecord[]>
  readonly storedProject: (projectId: string) => Promise<ProjectRecord | null>
  readonly projectOpenState: (projectId: string) => Promise<boolean | null>
  readonly importWorktrees: (
    projectId: string,
    repositoryPath: string,
    mainPath: string
  ) => Promise<void>
  readonly observeAvailableProject: (
    project: ProjectRecord
  ) => Promise<ProjectRecord>
  readonly ensureProjectTerminals: (projectId: string) => Promise<void>
  readonly listWorktreeTerminals: (
    worktree: WorktreeRecord
  ) => Promise<TerminalRecord[]>
  readonly listWebPanelDefinitions: (
    worktreeId: string
  ) => Promise<WebPanelDefinition[]>
  readonly getWorktree: (worktreeId: string) => Promise<WorktreeRecord>
  readonly requireOpenProject: (projectId: string) => Promise<ProjectRecord>
}

export class ProjectSnapshotService {
  private inFlight: Promise<ProjectRecord[]> | null = null
  private revision = 0

  constructor(private readonly host: ProjectSnapshotDependencies) {}

  invalidate(): void {
    this.revision += 1
    this.inFlight = null
  }

  listProjects(): Promise<ProjectRecord[]> {
    if (this.inFlight) {
      return this.inFlight
    }

    const snapshot = this.collectCurrentProjectsSnapshot()
    this.inFlight = snapshot
    const clear = () => {
      if (this.inFlight === snapshot) {
        this.inFlight = null
      }
    }
    void snapshot.then(clear, clear)
    return snapshot
  }

  async listRecentProjects(): Promise<RecentProjectRecord[]> {
    return this.host.database.db
      .select({
        id: projects.id,
        name: projects.name,
        kind: projects.kind,
        rootPath: projects.repositoryPath,
        repositoryPath: projects.repositoryPath,
        lastOpenedAt: projects.lastOpenedAt
      })
      .from(projects)
      .where(and(eq(projects.isOpen, 0), eq(projects.showInRecents, 1)))
      .orderBy(desc(projects.lastOpenedAt), asc(projects.id))
  }

  async getProjectSnapshot(projectId: string): Promise<ProjectRecord> {
    await this.host.requireOpenProject(projectId)
    const project = (await this.listProjects()).find(
      (candidate) => candidate.id === projectId
    )
    if (!project) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Project not found', 404)
    }

    return project
  }

  async getWorktreeSnapshot(worktreeId: string): Promise<WorktreeRecord> {
    const binding = await this.host.getWorktree(worktreeId)
    await this.host.requireOpenProject(binding.projectId)
    const worktree = (await this.listProjects())
      .flatMap((project) => project.worktrees)
      .find((candidate) => candidate.id === worktreeId)
    if (!worktree) {
      throw new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
    }

    return worktree
  }

  private async collectCurrentProjectsSnapshot(): Promise<ProjectRecord[]> {
    while (true) {
      const revision = this.revision
      const projects = await this.collectProjectsSnapshot()
      if (revision === this.revision) {
        return projects
      }
    }
  }

  private async collectProjectsSnapshot(): Promise<ProjectRecord[]> {
    const projects = await Promise.all(
      (await this.host.storedProjects(true)).map(async (storedProject) => {
        let project = storedProject
        try {
          if (project.kind === 'repository') {
            await this.host.importWorktrees(
              project.id,
              project.repositoryPath,
              project.mainWorktreePath
            )
          } else {
            project = await this.host.observeAvailableProject(project)
          }

          await this.host.ensureProjectTerminals(project.id)
          project = (await this.host.storedProject(project.id)) ?? project
        } catch (error) {
          project.availability = {
            state: 'unavailable',
            message: error instanceof Error ? error.message : String(error)
          }
        }

        if ((await this.host.projectOpenState(project.id)) !== true) {
          return null
        }

        await Promise.all(
          project.worktrees.map(async (worktree) => {
            const [dirty, terminals] = await Promise.all([
              project.kind === 'repository' &&
              project.availability.state === 'available' &&
              !worktree.prunable
                ? this.host.git.dirtyState(worktree.path).catch(() => null)
                : null,
              this.host.listWorktreeTerminals(worktree).catch((error) => {
                project.availability = {
                  state: 'unavailable',
                  message:
                    error instanceof Error ? error.message : String(error)
                }
                return []
              })
            ])
            worktree.dirty = dirty
            worktree.terminals = terminals
            const [storedBrowserPanels, storedWebPanels] = await Promise.all([
              this.host.database.db
                .select()
                .from(browserPanels)
                .where(eq(browserPanels.worktreeId, worktree.id))
                .orderBy(asc(browserPanels.createdAt), asc(browserPanels.id)),
              this.host.database.db
                .select()
                .from(webPanels)
                .where(eq(webPanels.worktreeId, worktree.id))
                .orderBy(asc(webPanels.createdAt), asc(webPanels.id))
            ])
            const definitions =
              project.availability.state === 'available' &&
              storedWebPanels.length > 0
                ? await this.host
                    .listWebPanelDefinitions(worktree.id)
                    .catch(() => [])
                : []
            const definitionsById = new Map(
              definitions.map((definition) => [definition.id, definition])
            )
            worktree.panels = [
              ...terminals.map((terminal) => ({
                id: `panel_${terminal.id}`,
                kind: 'terminal' as const,
                worktreeId: worktree.id,
                terminalId: terminal.id,
                title: terminal.name,
                createdAt: terminal.createdAt,
                updatedAt: terminal.updatedAt
              })),
              ...storedBrowserPanels.map(mapBrowserPanel),
              ...storedWebPanels.map((panel) => {
                const definition = definitionsById.get(panel.definitionId)
                return mapWebPanel(
                  panel,
                  definition?.permissions ?? [],
                  definition?.permissionsGranted ?? false
                )
              })
            ].sort(
              (left, right) =>
                left.createdAt.localeCompare(right.createdAt) ||
                left.id.localeCompare(right.id)
            )
          })
        )
        return project
      })
    )
    return projects.filter(
      (project): project is ProjectRecord => project !== null
    )
  }
}

function mapBrowserPanel(row: typeof browserPanels.$inferSelect): BrowserPanel {
  return {
    id: row.id,
    kind: 'browser',
    worktreeId: row.worktreeId,
    title: row.title,
    url: row.url,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function mapWebPanel(
  row: typeof webPanels.$inferSelect,
  permissions: WebPanelPermission[] = [],
  permissionsGranted = permissions.length === 0
): WebPanel {
  const parsedInput = webPanelInputSchema
    .nullable()
    .safeParse(JSON.parse(row.inputJson))
  if (!parsedInput.success) {
    throw new Error(`Web panel ${row.id} has invalid stored launch input`)
  }

  return {
    id: row.id,
    kind: 'web',
    worktreeId: row.worktreeId,
    definitionId: row.definitionId,
    title: row.title,
    launch: { input: parsedInput.data, cwd: row.launchCwd },
    permissions,
    sandbox: {
      allowSameOrigin: permissionsGranted && permissions.includes('same-origin')
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}
