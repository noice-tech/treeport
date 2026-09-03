import crypto from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  TREE_FILE_LIST_MAX_ENTRIES,
  TREE_FILE_MAX_BYTES,
  treeFilePathSchema
} from '@treeport/shared'
import type {
  ProjectRecord,
  TreeFile,
  TreeFileListing,
  TreeFileWrite,
  TreeFileWriteResult,
  WorktreeRecord
} from '@treeport/shared'
import { DomainError } from '../../domain'
import type { GitAdapter } from '../../git'
import type { PromiseMutationQueue } from '../infrastructure/application-runtime'

export interface TreeFileServiceDependencies {
  readonly git: GitAdapter
  readonly mutations: PromiseMutationQueue
  readonly authorize: (panelId: string) => Promise<{
    project: ProjectRecord
    worktree: WorktreeRecord
  }>
}

export class TreeFileService {
  constructor(private readonly dependencies: TreeFileServiceDependencies) {}

  async listTreeFiles(panelId: string): Promise<TreeFileListing> {
    const { project, worktree } = await this.dependencies.authorize(panelId)
    const root = await fs.realpath(worktree.path)
    const paths: string[] = []
    if (project.kind === 'repository') {
      const candidates = await this.dependencies.git.worktreeFiles(root)
      for (const relativePath of candidates) {
        if (paths.length > TREE_FILE_LIST_MAX_ENTRIES) {
          break
        }

        const candidate = path.resolve(root, relativePath)
        if (!isPathWithin(candidate, root)) {
          continue
        }

        const [canonicalPath, stat] = await Promise.all([
          fs.realpath(candidate).catch(() => null),
          fs.lstat(candidate).catch(() => null)
        ])
        if (
          canonicalPath &&
          isPathWithin(canonicalPath, root) &&
          stat?.isFile() &&
          !stat.isSymbolicLink()
        ) {
          paths.push(relativePath.split(path.sep).join('/'))
        }
      }
    } else {
      const directories = ['']
      while (
        directories.length > 0 &&
        paths.length <= TREE_FILE_LIST_MAX_ENTRIES
      ) {
        const relativeDirectory = directories.pop()!
        const entries = await fs
          .readdir(path.join(root, relativeDirectory), { withFileTypes: true })
          .then((values) =>
            values.sort((left, right) => right.name.localeCompare(left.name))
          )
        for (const entry of entries) {
          if (entry.name === '.git' && entry.isDirectory()) {
            continue
          }

          const relativePath = path.join(relativeDirectory, entry.name)
          if (entry.isDirectory()) {
            directories.push(relativePath)
          } else if (entry.isFile()) {
            paths.push(relativePath.split(path.sep).join('/'))
            if (paths.length > TREE_FILE_LIST_MAX_ENTRIES) {
              break
            }
          }
        }
      }
    }

    paths.sort()
    return {
      paths: paths.slice(0, TREE_FILE_LIST_MAX_ENTRIES),
      truncated: paths.length > TREE_FILE_LIST_MAX_ENTRIES
    }
  }

  async readTreeFile(
    panelId: string,
    requestedPath: string
  ): Promise<TreeFile> {
    const { worktree } = await this.dependencies.authorize(panelId)
    const resolved = await this.resolveTreeFile(worktree.path, requestedPath)
    const handle = await fs
      .open(
        resolved.canonicalPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
      )
      .catch((error) => {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          throw new DomainError(
            'TREE_FILE_NOT_FOUND',
            'The selected file does not exist',
            404
          )
        }

        throw error
      })
    try {
      const { bytes, content } = await this.readTreeFileHandle(handle)
      return {
        path: resolved.path,
        content,
        revision: crypto.createHash('sha256').update(bytes).digest('hex')
      }
    } finally {
      await handle.close()
    }
  }

  async writeTreeFile(
    panelId: string,
    input: TreeFileWrite
  ): Promise<TreeFileWriteResult> {
    const { worktree } = await this.dependencies.authorize(panelId)
    const content = Buffer.from(input.content, 'utf8')

    if (content.length > TREE_FILE_MAX_BYTES) {
      throw new DomainError(
        'TREE_FILE_TOO_LARGE',
        'Files larger than 2 MiB cannot be edited',
        413
      )
    }

    if (input.content.includes('\0')) {
      throw new DomainError(
        'TREE_FILE_UNSUPPORTED',
        'Only UTF-8 text files can be edited',
        415
      )
    }

    const resolved = await this.resolveTreeFile(worktree.path, input.path)
    return this.dependencies.mutations.enqueue(
      resolved.canonicalPath,
      async () => {
        const handle = await fs.open(
          resolved.canonicalPath,
          fsConstants.O_RDWR | fsConstants.O_NOFOLLOW
        )
        try {
          const current = await this.readTreeFileHandle(handle)
          const currentRevision = crypto
            .createHash('sha256')
            .update(current.bytes)
            .digest('hex')
          if (currentRevision !== input.expectedRevision) {
            throw new DomainError(
              'TREE_FILE_CHANGED',
              'The file changed after it was opened. Reload it before saving.',
              409
            )
          }

          let offset = 0
          while (offset < content.length) {
            const write = await handle.write(
              content,
              offset,
              content.length - offset,
              offset
            )
            if (write.bytesWritten === 0) {
              throw new Error('Could not write tree file')
            }

            offset += write.bytesWritten
          }
          await handle.truncate(content.length)
          await handle.sync()
          return {
            path: resolved.path,
            revision: crypto.createHash('sha256').update(content).digest('hex')
          }
        } finally {
          await handle.close()
        }
      }
    )
  }

  private async resolveTreeFile(
    worktreePath: string,
    requestedPath: string
  ): Promise<{ canonicalPath: string; path: string }> {
    if (!treeFilePathSchema.safeParse(requestedPath).success) {
      throw new DomainError(
        'INVALID_TREE_FILE_PATH',
        'File path must be a relative path inside the tree',
        400
      )
    }

    const root = await fs.realpath(worktreePath)
    const candidate = path.resolve(root, requestedPath)
    if (!isPathWithin(candidate, root)) {
      throw new DomainError(
        'INVALID_TREE_FILE_PATH',
        'File path must stay inside the tree',
        400
      )
    }

    const canonicalPath = await fs.realpath(candidate).catch((error) => {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        return null
      }

      throw error
    })
    if (!canonicalPath) {
      throw new DomainError(
        'TREE_FILE_NOT_FOUND',
        'The selected file does not exist',
        404
      )
    }

    if (!isPathWithin(canonicalPath, root)) {
      throw new DomainError(
        'INVALID_TREE_FILE_PATH',
        'File path must stay inside the tree',
        400
      )
    }

    const stat = await fs.lstat(candidate)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new DomainError(
        'TREE_FILE_UNSUPPORTED',
        'Only existing regular files can be edited',
        415
      )
    }

    return {
      canonicalPath,
      path: path.relative(root, canonicalPath).split(path.sep).join('/')
    }
  }

  private async readTreeFileHandle(
    handle: Awaited<ReturnType<typeof fs.open>>
  ): Promise<{ bytes: Buffer; content: string }> {
    const stat = await handle.stat()
    if (!stat.isFile()) {
      throw new DomainError(
        'TREE_FILE_UNSUPPORTED',
        'Only existing regular files can be edited',
        415
      )
    }

    if (stat.size > TREE_FILE_MAX_BYTES) {
      throw new DomainError(
        'TREE_FILE_TOO_LARGE',
        'Files larger than 2 MiB cannot be edited',
        413
      )
    }

    const buffer = Buffer.alloc(TREE_FILE_MAX_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const read = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead
      )
      if (read.bytesRead === 0) {
        break
      }

      bytesRead += read.bytesRead
    }
    if (bytesRead > TREE_FILE_MAX_BYTES) {
      throw new DomainError(
        'TREE_FILE_TOO_LARGE',
        'Files larger than 2 MiB cannot be edited',
        413
      )
    }

    const bytes = buffer.subarray(0, bytesRead)
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new DomainError(
        'TREE_FILE_UNSUPPORTED',
        'Only UTF-8 text files can be edited',
        415
      )
    }
    if (content.includes('\0')) {
      throw new DomainError(
        'TREE_FILE_UNSUPPORTED',
        'Only UTF-8 text files can be edited',
        415
      )
    }

    return { bytes, content }
  }
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}
