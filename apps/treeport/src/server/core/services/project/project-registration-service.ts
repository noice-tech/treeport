import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DirectoryBrowseResponse, ProjectRecord } from '@treeport/shared'
import { eq, or, sql } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import type { TreeportDatabase } from '../../database'
import { projects, worktrees } from '../../database-schema'
import { DomainError } from '../../domain'
import type { ProductEventBus } from '../../events'
import type { GitAdapter } from '../../git'
import type { PackageSystem } from '../../package-system'
import type {
  PromiseMutationLocks,
  PromiseMutationQueue
} from '../infrastructure/application-runtime'

const now = (): string => new Date().toISOString()
const id = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`

export interface ProjectRegistrationDependencies {
  readonly config: AppConfig
  readonly database: TreeportDatabase
  readonly git: GitAdapter
  readonly events: ProductEventBus
  readonly packages: PackageSystem
  readonly locks: PromiseMutationLocks
  readonly worktreeMutations: PromiseMutationQueue
  readonly observedFolderIdentities: Map<
    string,
    { device: string; inode: string }
  >
  readonly storedProject: (projectId: string) => Promise<ProjectRecord | null>
  readonly getProject: (projectId: string) => Promise<ProjectRecord>
  readonly getProjectSnapshot: (projectId: string) => Promise<ProjectRecord>
  readonly ensureProjectTerminals: (projectId: string) => Promise<void>
  readonly invalidateProjectsSnapshot: () => void
  readonly reconcileProjectWorktrees: (
    projectId: string,
    repositoryPath: string,
    mainPath: string,
    allowProjectLock: boolean,
    allowClosed?: boolean
  ) => Promise<void>
  readonly serializeProjectObservation: <Result>(
    projectId: string,
    operation: () => Promise<Result>
  ) => Promise<Result>
}

export class ProjectRegistrationService {
  constructor(private readonly host: ProjectRegistrationDependencies) {}

  private get deps() {
    return this.host
  }

  private get events() {
    return this.host.events
  }

  private get packages() {
    return this.host.packages
  }

  private get locks() {
    return this.host.locks
  }

  private get worktreeMutations() {
    return this.host.worktreeMutations
  }

  private get observedFolderIdentities() {
    return this.host.observedFolderIdentities
  }

  private storedProject(projectId: string) {
    return this.host.storedProject(projectId)
  }

  private getProject(projectId: string) {
    return this.host.getProject(projectId)
  }

  private getProjectSnapshot(projectId: string) {
    return this.host.getProjectSnapshot(projectId)
  }

  private ensureProjectTerminals(projectId: string) {
    return this.host.ensureProjectTerminals(projectId)
  }

  private invalidateProjectsSnapshot() {
    this.host.invalidateProjectsSnapshot()
  }

  private reconcileProjectWorktrees(
    projectId: string,
    repositoryPath: string,
    mainPath: string,
    allowProjectLock: boolean,
    allowClosed = false
  ) {
    return this.host.reconcileProjectWorktrees(
      projectId,
      repositoryPath,
      mainPath,
      allowProjectLock,
      allowClosed
    )
  }

  private serializeProjectObservation<Result>(
    projectId: string,
    operation: () => Promise<Result>
  ) {
    return this.host.serializeProjectObservation(projectId, operation)
  }

  async browseDirectory(
    inputPath: string,
    showHidden = false
  ): Promise<DirectoryBrowseResponse> {
    const homePath = os.homedir()
    const expandedPath =
      inputPath === '~'
        ? homePath
        : /^~[\\/]/u.test(inputPath)
          ? path.join(homePath, inputPath.slice(2))
          : inputPath
    if (!path.isAbsolute(expandedPath)) {
      throw new DomainError(
        'DIRECTORY_PATH_NOT_ABSOLUTE',
        'Enter an absolute path on the Treeport server',
        400
      )
    }

    const requestedPath = path.resolve(expandedPath)
    let exact = true
    let entryQuery = ''
    const directoryPath = await fs
      .realpath(requestedPath)
      .catch(async (error) => {
        // SAFETY: The surrounding boundary contract establishes this asserted value.
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          throw new DomainError(
            'DIRECTORY_UNREADABLE',
            'That folder cannot be read on the Treeport server',
            403
          )
        }

        exact = false
        entryQuery ||= path.basename(requestedPath)
        return fs.realpath(path.dirname(requestedPath)).catch((parentError) => {
          // SAFETY: The surrounding boundary contract establishes this asserted value.
          const parentCode = (parentError as NodeJS.ErrnoException).code
          throw new DomainError(
            parentCode === 'ENOENT'
              ? 'DIRECTORY_NOT_FOUND'
              : 'DIRECTORY_UNREADABLE',
            parentCode === 'ENOENT'
              ? 'That folder does not exist on the Treeport server'
              : 'That folder cannot be read on the Treeport server',
            parentCode === 'ENOENT' ? 404 : 403
          )
        })
      })
    const directoryStat = await fs.stat(directoryPath).catch((error) => {
      // SAFETY: The surrounding boundary contract establishes this asserted value.
      const code = (error as NodeJS.ErrnoException).code
      throw new DomainError(
        code === 'ENOENT' ? 'DIRECTORY_NOT_FOUND' : 'DIRECTORY_UNREADABLE',
        code === 'ENOENT'
          ? 'That folder does not exist on the Treeport server'
          : 'That folder cannot be read on the Treeport server',
        code === 'ENOENT' ? 404 : 403
      )
    })
    if (!directoryStat.isDirectory()) {
      throw new DomainError(
        'DIRECTORY_NOT_A_DIRECTORY',
        'That path is not a folder',
        400
      )
    }

    const rawEntries = await fs
      .readdir(directoryPath, {
        withFileTypes: true
      })
      .catch(() => {
        throw new DomainError(
          'DIRECTORY_UNREADABLE',
          'That folder cannot be read on the Treeport server',
          403
        )
      })
    const normalizedQuery = entryQuery.toLocaleLowerCase()
    const candidates = rawEntries
      .filter(
        (entry) =>
          (showHidden ||
            normalizedQuery.startsWith('.') ||
            !entry.name.startsWith('.')) &&
          (!normalizedQuery ||
            entry.name.toLocaleLowerCase().startsWith(normalizedQuery))
      )
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, {
          sensitivity: 'base',
          numeric: true
        })
      )

    const entries: DirectoryBrowseResponse['directory']['entries'] = []
    let truncated = false
    for (const entry of candidates) {
      const entryPath = path.join(directoryPath, entry.name)
      const isDirectory =
        entry.isDirectory() ||
        (entry.isSymbolicLink() &&
          (await fs
            .stat(entryPath)
            .then((stat) => stat.isDirectory())
            .catch(() => false)))
      if (!isDirectory) {
        continue
      }

      if (entries.length === 200) {
        truncated = true
        break
      }

      entries.push({ name: entry.name, path: entryPath })
    }

    const rootPath = path.parse(directoryPath).root
    const breadcrumbs: DirectoryBrowseResponse['directory']['breadcrumbs'] = [
      { name: rootPath, path: rootPath }
    ]
    let breadcrumbPath = rootPath
    for (const segment of directoryPath
      .slice(rootPath.length)
      .split(path.sep)) {
      if (!segment) {
        continue
      }

      breadcrumbPath = path.join(breadcrumbPath, segment)
      breadcrumbs.push({ name: segment, path: breadcrumbPath })
    }

    const repositoryPath = exact
      ? await this.deps.git
          .findProjectRepositoryRoot(directoryPath)
          .then((checkout) =>
            checkout ? this.deps.git.resolveMainCheckout(checkout) : null
          )
          .then((mainCheckout) =>
            mainCheckout ? fs.realpath(mainCheckout) : null
          )
      : null

    return {
      input: inputPath,
      exact,
      directory: {
        path: directoryPath,
        parentPath:
          directoryPath === rootPath ? null : path.dirname(directoryPath),
        homePath,
        rootPath,
        breadcrumbs,
        entries,
        truncated
      },
      project: exact
        ? repositoryPath
          ? { state: 'valid', kind: 'repository', path: repositoryPath }
          : { state: 'valid', kind: 'folder', path: directoryPath }
        : {
            state: 'incomplete',
            message: 'Choose a matching folder to continue.'
          },
      repository: repositoryPath
        ? { state: 'valid', repositoryPath }
        : exact
          ? {
              state: 'not-repository',
              message: 'This folder is not inside a Git repository.'
            }
          : {
              state: 'incomplete',
              message: 'Choose a matching folder to continue.'
            }
    }
  }

  async registerProject(
    inputPath: string,
    requestedName?: string
  ): Promise<ProjectRecord> {
    const canonicalPath = await fs
      .realpath(path.resolve(inputPath))
      .catch((error) => {
        throw new DomainError(
          'FOLDER_UNREADABLE',
          error instanceof Error ? error.message : 'Folder cannot be read',
          400
        )
      })
    const folderStat = await fs.stat(canonicalPath, { bigint: true })
    if (!folderStat.isDirectory()) {
      throw new DomainError(
        'FOLDER_NOT_DIRECTORY',
        `Path is not a folder: ${canonicalPath}`,
        400
      )
    }

    const repositoryRoot =
      await this.deps.git.findProjectRepositoryRoot(canonicalPath)
    return repositoryRoot
      ? this.registerRepositoryProject(repositoryRoot, requestedName)
      : this.registerFolderProject(canonicalPath, requestedName)
  }

  private async registerRepositoryProject(
    inputPath: string,
    requestedName?: string
  ): Promise<ProjectRecord> {
    const checkout = await this.deps.git
      .canonicalizeRepositoryPath(inputPath)
      .catch((error) => {
        throw new DomainError(
          'NOT_A_GIT_REPOSITORY',
          error instanceof Error ? error.message : 'Not a Git repository',
          400
        )
      })
    const mainPath = await this.deps.git.resolveMainCheckout(checkout)
    const repositoryPath = await fs.realpath(mainPath)
    const repositoryStat = await fs.stat(repositoryPath, { bigint: true })
    const repositoryDevice = repositoryStat.dev.toString()
    const repositoryInode = repositoryStat.ino.toString()
    const repositoryIdentity =
      await this.deps.git.ensureRepositoryIdentity(repositoryPath)
    const [pathMatchRow, identityMatchRow] = await Promise.all([
      this.deps.database.db
        .select({ id: projects.id })
        .from(projects)
        .where(
          or(
            eq(projects.repositoryPath, repositoryPath),
            eq(projects.mainWorktreePath, repositoryPath)
          )
        )
        .limit(1)
        .then(([row]) => row),
      this.deps.database.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.repositoryIdentity, repositoryIdentity))
        .limit(1)
        .then(([row]) => row)
    ])
    const [pathMatch, identityMatch] = await Promise.all([
      pathMatchRow ? this.storedProject(pathMatchRow.id) : null,
      identityMatchRow ? this.storedProject(identityMatchRow.id) : null
    ])
    const [pathMetadataRow] = pathMatch
      ? await this.deps.database.db
          .select({
            identity: projects.repositoryIdentity,
            device: projects.repositoryDevice,
            inode: projects.repositoryInode,
            nameIsCustom: projects.nameIsCustom
          })
          .from(projects)
          .where(eq(projects.id, pathMatch.id))
          .limit(1)
      : []
    const pathMetadata = pathMetadataRow
      ? {
          ...pathMetadataRow,
          nameIsCustom: Boolean(pathMetadataRow.nameIsCustom)
        }
      : null
    if (pathMatch && !pathMetadata) {
      throw new DomainError(
        'PROJECT_PATH_CONFLICT',
        'The registered project is missing its repository identity metadata',
        409
      )
    }

    if (
      pathMatch &&
      ((pathMetadata?.identity !== null &&
        pathMetadata?.identity !== repositoryIdentity) ||
        (pathMetadata?.identity === null &&
          pathMetadata.inode !== repositoryInode))
    ) {
      throw new DomainError(
        'PROJECT_PATH_CONFLICT',
        'The registered path now contains a different repository',
        409
      )
    }

    if (pathMatch && identityMatch && pathMatch.id !== identityMatch.id) {
      throw new DomainError(
        'PROJECT_PATH_CONFLICT',
        'The repository identity and registered path belong to different projects',
        409
      )
    }

    if (
      identityMatch &&
      identityMatch.repositoryPath !== repositoryPath &&
      (await fs.realpath(identityMatch.repositoryPath).catch(() => null)) &&
      (await this.deps.git
        .repositoryIdentity(identityMatch.repositoryPath)
        .catch(() => null)) === repositoryIdentity
    ) {
      throw new DomainError(
        'PROJECT_PATH_CONFLICT',
        'The same local repository identity exists at multiple paths; Treeport cannot choose between a move and a copy',
        409
      )
    }

    const existing = identityMatch ?? pathMatch
    const projectId = existing?.id ?? id('proj')

    const updateRegistration = async (): Promise<void> => {
      if (existing && existing.repositoryPath !== repositoryPath) {
        await this.deps.git.repairWorktrees(repositoryPath)
        const discovered = await this.deps.git.listWorktrees(repositoryPath)
        if (
          !discovered.some(
            (worktree) =>
              !worktree.bare &&
              !worktree.prunable &&
              worktree.path === repositoryPath &&
              worktree.gitWorktreeKey === 'main'
          )
        ) {
          throw new DomainError(
            'NOT_A_GIT_REPOSITORY',
            'Git worktree inventory did not report the recovered main checkout',
            400
          )
        }
      }

      const timestamp = now()
      const defaultBranch = await this.deps.git.defaultBranch(repositoryPath)
      const requested = requestedName?.trim() || null
      const [existingMetadataRow] = existing
        ? await this.deps.database.db
            .select({
              identity: projects.repositoryIdentity,
              device: projects.repositoryDevice,
              inode: projects.repositoryInode,
              nameIsCustom: projects.nameIsCustom
            })
            .from(projects)
            .where(eq(projects.id, existing.id))
            .limit(1)
        : []
      const existingMetadata = existingMetadataRow
        ? {
            ...existingMetadataRow,
            nameIsCustom: Boolean(existingMetadataRow.nameIsCustom)
          }
        : null
      if (existing && !existingMetadata) {
        throw new DomainError(
          'PROJECT_PATH_CONFLICT',
          'The registered project is missing its filesystem identity',
          409
        )
      }

      const nameIsCustom = requested
        ? true
        : (existingMetadata?.nameIsCustom ?? false)
      const automaticExistingName = Boolean(
        existing &&
        !nameIsCustom &&
        existing.name === path.basename(existing.repositoryPath)
      )
      const name =
        requested ||
        (automaticExistingName
          ? path.basename(repositoryPath)
          : existing?.name) ||
        path.basename(repositoryPath)
      const verifiedIdentity =
        await this.deps.git.repositoryIdentity(repositoryPath)
      const verifiedStat = await fs.stat(repositoryPath, { bigint: true })
      if (
        verifiedIdentity !== repositoryIdentity ||
        verifiedStat.dev.toString() !== repositoryDevice ||
        verifiedStat.ino.toString() !== repositoryInode
      ) {
        throw new DomainError(
          'PROJECT_PATH_CONFLICT',
          'The repository changed during registration',
          409
        )
      }

      await this.deps.database.db.run(sql`
        INSERT INTO projects(
          id,name,project_kind,repository_path,main_worktree_path,default_branch,
          repository_identity,repository_device,repository_inode,name_is_custom,
          is_open,show_in_recents,last_opened_at,created_at,updated_at
        ) VALUES(
          ${projectId},${name},'repository',${repositoryPath},${mainPath},${defaultBranch},
          ${repositoryIdentity},${repositoryDevice},${repositoryInode},
          ${nameIsCustom ? 1 : 0},1,0,${timestamp},
          ${existing?.createdAt ?? timestamp},${timestamp}
        )
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,
          project_kind=excluded.project_kind,
          repository_path=excluded.repository_path,
          main_worktree_path=excluded.main_worktree_path,
          default_branch=excluded.default_branch,
          repository_identity=excluded.repository_identity,
          repository_device=excluded.repository_device,
          repository_inode=excluded.repository_inode,
          name_is_custom=excluded.name_is_custom,
          updated_at=excluded.updated_at
      `)
      await this.reconcileProjectWorktrees(
        projectId,
        repositoryPath,
        mainPath,
        Boolean(existing),
        true
      )
    }

    if (existing) {
      await this.serializeProjectObservation(projectId, async () => {
        if (
          (await this.worktreeMutations.isBusy(projectId)) ||
          !(await this.locks.tryAcquire({ projectId }))
        ) {
          throw new DomainError(
            'PROJECT_BUSY',
            'Project is already being modified',
            409
          )
        }

        try {
          await updateRegistration()
          const timestamp = now()
          await this.deps.database.db
            .update(projects)
            .set({
              isOpen: 1,
              showInRecents: 0,
              lastOpenedAt: timestamp,
              updatedAt: timestamp
            })
            .where(eq(projects.id, projectId))
          await this.packages.registerProject(await this.getProject(projectId))
          await this.ensureProjectTerminals(projectId).catch(() => undefined)
          this.invalidateProjectsSnapshot()
          this.events.publish('project.updated', { projectId })
        } finally {
          await this.locks.release({ projectId: projectId })
        }
      })
      return this.getProjectSnapshot(projectId)
    }

    await updateRegistration()
    await this.packages.registerProject(await this.getProject(projectId))
    await this.ensureProjectTerminals(projectId).catch(() => undefined)
    this.invalidateProjectsSnapshot()
    this.events.publish('project.created', { projectId })
    return this.getProjectSnapshot(projectId)
  }

  private async registerFolderProject(
    folderPath: string,
    requestedName?: string
  ): Promise<ProjectRecord> {
    const folderStat = await fs.stat(folderPath, { bigint: true })
    const device = folderStat.dev.toString()
    const inode = folderStat.ino.toString()
    const [pathMatchRow] = await this.deps.database.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.repositoryPath, folderPath))
      .limit(1)
    const identityMatchId = [...this.observedFolderIdentities].find(
      ([, identity]) => identity.device === device && identity.inode === inode
    )?.[0]
    const [pathMatch, identityMatch] = await Promise.all([
      pathMatchRow ? this.storedProject(pathMatchRow.id) : null,
      identityMatchId ? this.storedProject(identityMatchId) : null
    ])
    if (pathMatch?.kind === 'repository') {
      throw new DomainError(
        'PROJECT_PATH_CONFLICT',
        'The selected folder is registered as a Git repository, but Git no longer recognizes it',
        409
      )
    }

    const observedPathIdentity = pathMatch
      ? this.observedFolderIdentities.get(pathMatch.id)
      : null
    if (
      observedPathIdentity &&
      (observedPathIdentity.device !== device ||
        observedPathIdentity.inode !== inode)
    ) {
      throw new DomainError(
        'PROJECT_PATH_CONFLICT',
        'The registered folder path now refers to a different folder',
        409
      )
    }

    if (pathMatch && identityMatch && pathMatch.id !== identityMatch.id) {
      throw new DomainError(
        'PROJECT_PATH_CONFLICT',
        'The folder identity and registered path belong to different projects',
        409
      )
    }

    const existing = identityMatch ?? pathMatch
    const projectId = existing?.id ?? id('proj')
    const updateRegistration = async (): Promise<void> => {
      const timestamp = now()
      const [metadata] = existing
        ? await this.deps.database.db
            .select({ nameIsCustom: projects.nameIsCustom })
            .from(projects)
            .where(eq(projects.id, existing.id))
            .limit(1)
        : []
      const requested = requestedName?.trim() || null
      const nameIsCustom = requested ? true : Boolean(metadata?.nameIsCustom)
      const name =
        requested ||
        (existing &&
        !nameIsCustom &&
        existing.name === path.basename(existing.rootPath)
          ? path.basename(folderPath)
          : existing?.name) ||
        path.basename(folderPath)
      const [verifiedPath, verifiedStat] = await Promise.all([
        fs.realpath(folderPath),
        fs.stat(folderPath, { bigint: true })
      ])
      if (
        verifiedPath !== folderPath ||
        !verifiedStat.isDirectory() ||
        verifiedStat.dev.toString() !== device ||
        verifiedStat.ino.toString() !== inode
      ) {
        throw new DomainError(
          'PROJECT_PATH_CONFLICT',
          'The folder changed during registration',
          409
        )
      }

      const existingWorktreeRows = existing
        ? await this.deps.database.db
            .select()
            .from(worktrees)
            .where(eq(worktrees.projectId, projectId))
        : []
      if (
        existingWorktreeRows.length > 1 ||
        existingWorktreeRows.some((worktree) => worktree.kind !== 'folder')
      ) {
        throw new DomainError(
          'PROJECT_PATH_CONFLICT',
          'The folder registration contains incompatible Git worktrees',
          409
        )
      }

      const existingWorktree = existingWorktreeRows[0]
      const worktreeId = existingWorktree?.id ?? id('wt')
      await this.deps.database.db.transaction(async (tx) => {
        await tx.run(sql`
          INSERT INTO projects(
            id,name,project_kind,repository_path,main_worktree_path,default_branch,
            repository_identity,repository_device,repository_inode,name_is_custom,
            is_open,show_in_recents,last_opened_at,created_at,updated_at
          ) VALUES(
            ${projectId},${name},'folder',${folderPath},${folderPath},'',
            NULL,${device},${inode},${nameIsCustom ? 1 : 0},1,0,${timestamp},
            ${existing?.createdAt ?? timestamp},${timestamp}
          )
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            project_kind='folder',
            repository_path=excluded.repository_path,
            main_worktree_path=excluded.main_worktree_path,
            default_branch='',
            repository_identity=NULL,
            repository_device=excluded.repository_device,
            repository_inode=excluded.repository_inode,
            name_is_custom=excluded.name_is_custom,
            is_open=1,
            show_in_recents=0,
            last_opened_at=excluded.last_opened_at,
            updated_at=excluded.updated_at
        `)
        if (existingWorktree) {
          await tx.run(sql`
            UPDATE worktrees
            SET path=${folderPath},git_worktree_key=NULL,head='',branch=NULL,
                detached=0,locked=0,lock_reason=NULL,prunable=0,kind='folder',
                managed_wrapper_path=NULL,pr_state='unknown',pr_number=NULL,
                pr_url=NULL,pr_base_branch=NULL,pr_head_branch=NULL,
                pr_merged_at=NULL,pr_refreshed_at=NULL,updated_at=${timestamp}
            WHERE id=${worktreeId}
          `)
        } else {
          await tx.run(sql`
            INSERT INTO worktrees(
              id,project_id,path,git_worktree_key,head,branch,detached,locked,
              lock_reason,prunable,kind,created_at,updated_at
            ) VALUES(
              ${worktreeId},${projectId},${folderPath},NULL,'',NULL,0,0,NULL,0,
              'folder',${timestamp},${timestamp}
            )
          `)
        }
      })
    }

    const register = async () => {
      if (
        (await this.worktreeMutations.isBusy(projectId)) ||
        !(await this.locks.tryAcquire({ projectId }))
      ) {
        throw new DomainError(
          'PROJECT_BUSY',
          'Project is already being modified',
          409
        )
      }

      try {
        await updateRegistration()
      } finally {
        await this.locks.release({ projectId: projectId })
      }
    }

    if (existing) {
      await this.serializeProjectObservation(projectId, register)
    } else {
      await register()
    }

    this.observedFolderIdentities.set(projectId, { device, inode })

    await this.packages.registerProject(await this.getProject(projectId))
    await this.ensureProjectTerminals(projectId).catch(() => undefined)
    this.invalidateProjectsSnapshot()
    this.events.publish(existing ? 'project.updated' : 'project.created', {
      projectId
    })
    return this.getProjectSnapshot(projectId)
  }
}
