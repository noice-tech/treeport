import crypto from 'node:crypto'
import type {
  ProjectRecord,
  TerminalPreset,
  TerminalPresetDefinitionListing,
  WorktreeRecord
} from '@treeport/shared'
import { and, asc, eq } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import type { TreeportDatabase } from '../../database'
import { mapTerminalPreset } from '../../database'
import { terminalPresets } from '../../database-schema'
import { DomainError } from '../../domain'
import type { PackageSystem } from '../../package-system'
import { loadRepositoryTerminalPresets } from '../../repository-terminal-presets'
import { loadZedTerminalPresetDefinitions } from '../../zed'

const now = (): string => new Date().toISOString()
const id = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`

export interface TerminalPresetServiceDependencies {
  readonly config: AppConfig
  readonly database: TreeportDatabase
  readonly packages: PackageSystem
  readonly getProject: (projectId: string) => Promise<ProjectRecord>
  readonly getWorktree: (worktreeId: string) => Promise<WorktreeRecord>
}

export class TerminalPresetService {
  constructor(private readonly host: TerminalPresetServiceDependencies) {}

  private get deps() {
    return this.host
  }

  private get packages() {
    return this.host.packages
  }

  private getProject(projectId: string) {
    return this.host.getProject(projectId)
  }

  private getWorktree(worktreeId: string) {
    return this.host.getWorktree(worktreeId)
  }

  async listTerminalPresets(): Promise<TerminalPreset[]> {
    const rows = await this.deps.database.db
      .select()
      .from(terminalPresets)
      .orderBy(asc(terminalPresets.createdAt), asc(terminalPresets.id))
    return rows.map(mapTerminalPreset)
  }

  async listTerminalPresetDefinitions(context?: {
    projectId?: string | undefined
    worktreeId?: string | undefined
  }): Promise<TerminalPresetDefinitionListing> {
    const worktree = context?.worktreeId
      ? await this.getWorktree(context.worktreeId)
      : null
    const projectId = worktree?.projectId ?? context?.projectId
    const project = projectId ? await this.getProject(projectId) : null
    if (project) {
      this.packages.syncProjects([project])
    }

    const [userPresets, packagePresets, repositoryPresets, zedPresets] =
      await Promise.all([
        this.listTerminalPresets(),
        this.packages.terminalPresetDefinitions(projectId),
        worktree && project
          ? loadRepositoryTerminalPresets(project.id, worktree.path)
          : Promise.resolve({ definitions: [], diagnostics: [] }),
        worktree && project?.kind === 'repository'
          ? loadZedTerminalPresetDefinitions({
              projectId: project.id,
              shell: this.deps.config.shell,
              mainWorktreePath: project.mainWorktreePath,
              worktreePath: worktree.path
            })
          : Promise.resolve({ definitions: [], diagnostics: [] })
      ])
    const repositoryPackagePresets = packagePresets.filter(
      (preset) =>
        preset.source.type === 'package' && preset.source.scope === 'project'
    )
    const globalPackagePresets = packagePresets.filter(
      (preset) =>
        preset.source.type === 'package' && preset.source.scope === 'global'
    )

    return {
      definitions: [
        ...repositoryPresets.definitions,
        ...zedPresets.definitions,
        ...repositoryPackagePresets,
        ...userPresets.map((preset) => ({
          id: preset.id,
          name: preset.name,
          executable: preset.executable,
          args: [...preset.args],
          shellCommand: null,
          cwd: null,
          env: {},
          closeOnSuccess: preset.closeOnSuccess,
          source: { type: 'user' as const }
        })),
        ...globalPackagePresets
      ],
      diagnostics: [...repositoryPresets.diagnostics, ...zedPresets.diagnostics]
    }
  }

  async createTerminalPreset(
    input: Pick<TerminalPreset, 'name' | 'executable' | 'args'> &
      Partial<Pick<TerminalPreset, 'closeOnSuccess'>>
  ): Promise<TerminalPreset> {
    const timestamp = now()
    const preset: TerminalPreset = {
      id: id('preset'),
      name: input.name,
      executable: input.executable,
      args: [...input.args],
      closeOnSuccess: input.closeOnSuccess ?? false,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    await this.deps.database.db.insert(terminalPresets).values({
      id: preset.id,
      name: preset.name,
      executable: preset.executable,
      argsJson: JSON.stringify(preset.args),
      closeOnSuccess: Number(preset.closeOnSuccess),
      createdAt: preset.createdAt,
      updatedAt: preset.updatedAt
    })
    return preset
  }

  async updateTerminalPreset(
    presetId: string,
    input: Pick<TerminalPreset, 'name' | 'executable' | 'args'> & {
      closeOnSuccess?: boolean | undefined
    },
    expectedUpdatedAt: string
  ): Promise<TerminalPreset> {
    const [existingRow] = await this.deps.database.db
      .select()
      .from(terminalPresets)
      .where(eq(terminalPresets.id, presetId))
      .limit(1)
    if (!existingRow) {
      throw new DomainError(
        'TERMINAL_PRESET_NOT_FOUND',
        'Terminal preset not found',
        404
      )
    }

    const existing = mapTerminalPreset(existingRow)
    if (existing.updatedAt !== expectedUpdatedAt) {
      throw new DomainError(
        'TERMINAL_PRESET_CHANGED',
        'Terminal preset changed; review the latest values and try again',
        409
      )
    }

    const timestamp = now()
    const preset: TerminalPreset = {
      ...existing,
      name: input.name,
      executable: input.executable,
      args: [...input.args],
      closeOnSuccess: input.closeOnSuccess ?? existing.closeOnSuccess,
      updatedAt:
        timestamp > existing.updatedAt
          ? timestamp
          : new Date(Date.parse(existing.updatedAt) + 1).toISOString()
    }
    const result = await this.deps.database.db
      .update(terminalPresets)
      .set({
        name: preset.name,
        executable: preset.executable,
        argsJson: JSON.stringify(preset.args),
        closeOnSuccess: Number(preset.closeOnSuccess),
        updatedAt: preset.updatedAt
      })
      .where(
        and(
          eq(terminalPresets.id, preset.id),
          eq(terminalPresets.updatedAt, expectedUpdatedAt)
        )
      )
    if (result.rowsAffected === 0) {
      throw new DomainError(
        'TERMINAL_PRESET_CHANGED',
        'Terminal preset changed; review the latest values and try again',
        409
      )
    }

    return preset
  }

  async deleteTerminalPreset(
    presetId: string,
    expectedUpdatedAt: string
  ): Promise<void> {
    const [existing] = await this.deps.database.db
      .select({ updatedAt: terminalPresets.updatedAt })
      .from(terminalPresets)
      .where(eq(terminalPresets.id, presetId))
      .limit(1)
    if (!existing) {
      throw new DomainError(
        'TERMINAL_PRESET_NOT_FOUND',
        'Terminal preset not found',
        404
      )
    }

    const result = await this.deps.database.db
      .delete(terminalPresets)
      .where(
        and(
          eq(terminalPresets.id, presetId),
          eq(terminalPresets.updatedAt, expectedUpdatedAt)
        )
      )
    if (existing.updatedAt !== expectedUpdatedAt || result.rowsAffected === 0) {
      throw new DomainError(
        'TERMINAL_PRESET_CHANGED',
        'Terminal preset changed; review the latest values and try again',
        409
      )
    }
  }
}
