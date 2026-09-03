import crypto from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  TREE_FILE_LIST_MAX_ENTRIES,
  TREE_FILE_MAX_BYTES,
  TREE_FILE_SEARCH_MAX_MATCHES,
  TREE_FILE_SEARCH_PREVIEW_MAX_LENGTH,
  treeFilePathSchema
} from '@treeport/shared'
import type {
  ProjectRecord,
  TreeFile,
  TreeFileListing,
  TreeFileSearchFile,
  TreeFileSearchResult,
  TreeFileWrite,
  TreeFileWriteResult,
  WorktreeRecord
} from '@treeport/shared'
import * as Effect from 'effect/Effect'
import * as Either from 'effect/Either'
import { DomainError } from '../../domain'
import { PanelOperations } from '../domain-services'
import {
  type ApplicationServices,
  TreeFileMutations
} from '../infrastructure/application-runtime'
import { GitPort } from '../infrastructure/ports'

function domainPromise<Result>(
  evaluate: () => Promise<Result>
): Effect.Effect<Result, DomainError<unknown>> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (error) => error
  }).pipe(
    Effect.catchAll((error) =>
      error instanceof DomainError ? Effect.fail(error) : Effect.die(error)
    )
  )
}

export class TreeFileService {
  listTreeFiles(
    panelId: string
  ): Effect.Effect<TreeFileListing, DomainError<unknown>, ApplicationServices> {
    const listTreeFilesForTree = this.listTreeFilesForTree.bind(this)

    return Effect.gen(function* () {
      const panels = yield* PanelOperations
      const { project, worktree } =
        yield* panels.requireWebPanelTreeFiles(panelId)
      return yield* listTreeFilesForTree(project, worktree)
    })
  }

  private listTreeFilesForTree(
    project: ProjectRecord,
    worktree: WorktreeRecord
  ): Effect.Effect<TreeFileListing, never, ApplicationServices> {
    return Effect.gen(function* () {
      const git = yield* GitPort
      const root = yield* Effect.promise(() => fs.realpath(worktree.path))
      const paths: string[] = []
      if (project.kind === 'repository') {
        const candidates = yield* Effect.promise(() => git.worktreeFiles(root))
        for (const relativePath of candidates) {
          if (paths.length > TREE_FILE_LIST_MAX_ENTRIES) {
            break
          }

          const candidate = path.resolve(root, relativePath)
          if (!isPathWithin(candidate, root)) {
            continue
          }

          const [canonicalPath, stat] = yield* Effect.all(
            [
              Effect.tryPromise({
                try: () => fs.realpath(candidate),
                catch: (cause) => cause
              }).pipe(Effect.orElseSucceed(() => null)),
              Effect.tryPromise({
                try: () => fs.lstat(candidate),
                catch: (cause) => cause
              }).pipe(Effect.orElseSucceed(() => null))
            ],
            { concurrency: 'unbounded' }
          )
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
          const entries = (yield* Effect.promise(() =>
            fs.readdir(path.join(root, relativeDirectory), {
              withFileTypes: true
            })
          )).sort((left, right) => right.name.localeCompare(left.name))
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
    })
  }

  readTreeFile(
    panelId: string,
    requestedPath: string
  ): Effect.Effect<TreeFile, DomainError<unknown>, ApplicationServices> {
    const readTreeFileFromRoot = this.readTreeFileFromRoot.bind(this)

    return Effect.gen(function* () {
      const panels = yield* PanelOperations
      const { worktree } = yield* panels.requireWebPanelTreeFiles(panelId)
      const root = yield* Effect.promise(() => fs.realpath(worktree.path))
      const file = yield* readTreeFileFromRoot(root, requestedPath)
      return {
        path: file.path,
        content: file.content,
        revision: crypto.createHash('sha256').update(file.bytes).digest('hex')
      }
    })
  }

  searchTreeFiles(
    panelId: string,
    query: string
  ): Effect.Effect<
    TreeFileSearchResult,
    DomainError<unknown>,
    ApplicationServices
  > {
    const listTreeFilesForTree = this.listTreeFilesForTree.bind(this)
    const readTreeFileFromRoot = this.readTreeFileFromRoot.bind(this)

    return Effect.gen(function* () {
      const panels = yield* PanelOperations
      const { project, worktree } =
        yield* panels.requireWebPanelTreeFiles(panelId)
      const listing = yield* listTreeFilesForTree(project, worktree)
      const root = yield* Effect.promise(() => fs.realpath(worktree.path))
      const expression = new RegExp(
        query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'iu'
      )
      const files: TreeFileSearchFile[] = []
      let matchCount = 0
      let hasExtraMatch = false

      for (let start = 0; start < listing.paths.length; start += 8) {
        const batchPaths = listing.paths.slice(start, start + 8)
        const reads = yield* Effect.all(
          batchPaths.map((filePath) =>
            Effect.either(readTreeFileFromRoot(root, filePath))
          ),
          { concurrency: 'unbounded' }
        )
        for (const read of reads) {
          if (Either.isLeft(read)) {
            if (
              [
                'TREE_FILE_NOT_FOUND',
                'TREE_FILE_UNSUPPORTED',
                'TREE_FILE_TOO_LARGE',
                'INVALID_TREE_FILE_PATH'
              ].includes(read.left.code)
            ) {
              continue
            }

            return yield* Effect.fail(read.left)
          }

          const matches: TreeFileSearchFile['matches'] = []
          const lines = read.right.content.split(/\r\n|\r|\n/)
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const line = lines[lineIndex]!
            const match = expression.exec(line)
            if (!match) {
              continue
            }

            if (matchCount === TREE_FILE_SEARCH_MAX_MATCHES) {
              hasExtraMatch = true
              break
            }

            const length = match[0].length
            let previewStart = Math.max(
              0,
              match.index -
                Math.floor((TREE_FILE_SEARCH_PREVIEW_MAX_LENGTH - length) / 2)
            )
            previewStart = Math.min(
              previewStart,
              Math.max(0, line.length - TREE_FILE_SEARCH_PREVIEW_MAX_LENGTH)
            )
            matches.push({
              lineNumber: lineIndex + 1,
              column: match.index,
              length,
              preview: line.slice(
                previewStart,
                previewStart + TREE_FILE_SEARCH_PREVIEW_MAX_LENGTH
              ),
              previewStart,
              lineLength: line.length
            })
            matchCount += 1
          }
          if (matches.length > 0) {
            files.push({ path: read.right.path, matches })
          }

          if (hasExtraMatch) {
            break
          }
        }
        if (hasExtraMatch) {
          break
        }
      }

      return {
        files,
        truncated: listing.truncated || hasExtraMatch
      }
    })
  }

  writeTreeFile(
    panelId: string,
    input: TreeFileWrite
  ): Effect.Effect<
    TreeFileWriteResult,
    DomainError<unknown>,
    ApplicationServices
  > {
    const readTreeFileHandle = this.readTreeFileHandle.bind(this)
    const resolveTreeFile = this.resolveTreeFile.bind(this)

    return Effect.gen(function* () {
      const panels = yield* PanelOperations
      const { worktree } = yield* panels.requireWebPanelTreeFiles(panelId)
      const content = Buffer.from(input.content, 'utf8')
      if (content.length > TREE_FILE_MAX_BYTES) {
        return yield* Effect.fail(
          new DomainError(
            'TREE_FILE_TOO_LARGE',
            'Files larger than 2 MiB cannot be edited',
            413
          )
        )
      }

      if (input.content.includes('\0')) {
        return yield* Effect.fail(
          new DomainError(
            'TREE_FILE_UNSUPPORTED',
            'Only UTF-8 text files can be edited',
            415
          )
        )
      }

      const root = yield* Effect.promise(() => fs.realpath(worktree.path))
      const resolved = yield* resolveTreeFile(root, input.path)
      const mutations = yield* TreeFileMutations
      return yield* mutations.enqueue(
        resolved.canonicalPath,
        Effect.acquireUseRelease(
          Effect.promise(() =>
            fs.open(
              resolved.canonicalPath,
              fsConstants.O_RDWR | fsConstants.O_NOFOLLOW
            )
          ),
          (handle) =>
            Effect.gen(function* () {
              const current = yield* readTreeFileHandle(handle)
              const currentRevision = crypto
                .createHash('sha256')
                .update(current.bytes)
                .digest('hex')
              if (currentRevision !== input.expectedRevision) {
                return yield* Effect.fail(
                  new DomainError(
                    'TREE_FILE_CHANGED',
                    'The file changed after it was opened. Reload it before saving.',
                    409
                  )
                )
              }

              let offset = 0
              while (offset < content.length) {
                const write = yield* Effect.promise(() =>
                  handle.write(content, offset, content.length - offset, offset)
                )
                if (write.bytesWritten === 0) {
                  throw new Error('Could not write tree file')
                }

                offset += write.bytesWritten
              }
              yield* Effect.promise(() => handle.truncate(content.length))
              yield* Effect.promise(() => handle.sync())
              return {
                path: resolved.path,
                revision: crypto
                  .createHash('sha256')
                  .update(content)
                  .digest('hex')
              }
            }),
          (handle) => Effect.promise(() => handle.close())
        )
      )
    })
  }

  private readTreeFileFromRoot(
    root: string,
    requestedPath: string
  ): Effect.Effect<
    { path: string; bytes: Buffer; content: string },
    DomainError<unknown>
  > {
    const readTreeFileHandle = this.readTreeFileHandle.bind(this)
    const resolveTreeFile = this.resolveTreeFile.bind(this)

    return Effect.gen(function* () {
      const resolved = yield* resolveTreeFile(root, requestedPath)
      const file = yield* Effect.acquireUseRelease(
        domainPromise(() =>
          fs
            .open(
              resolved.canonicalPath,
              fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
            )
            .catch((error) => {
              if (
                error instanceof Error &&
                'code' in error &&
                (error.code === 'ENOENT' || error.code === 'ENOTDIR')
              ) {
                throw new DomainError(
                  'TREE_FILE_NOT_FOUND',
                  'The selected file does not exist',
                  404
                )
              }

              if (
                error instanceof Error &&
                'code' in error &&
                error.code === 'ELOOP'
              ) {
                throw new DomainError(
                  'TREE_FILE_UNSUPPORTED',
                  'Only existing regular files can be edited',
                  415
                )
              }

              throw error
            })
        ),
        readTreeFileHandle,
        (handle) => Effect.promise(() => handle.close())
      )
      return { path: resolved.path, ...file }
    })
  }

  private resolveTreeFile(
    root: string,
    requestedPath: string
  ): Effect.Effect<
    { canonicalPath: string; path: string },
    DomainError<unknown>
  > {
    return Effect.gen(function* () {
      if (!treeFilePathSchema.safeParse(requestedPath).success) {
        return yield* Effect.fail(
          new DomainError(
            'INVALID_TREE_FILE_PATH',
            'File path must be a relative path inside the tree',
            400
          )
        )
      }

      const candidate = path.resolve(root, requestedPath)
      if (!isPathWithin(candidate, root)) {
        return yield* Effect.fail(
          new DomainError(
            'INVALID_TREE_FILE_PATH',
            'File path must stay inside the tree',
            400
          )
        )
      }

      const canonicalPath = yield* domainPromise(() =>
        fs.realpath(candidate).catch((error) => {
          if (
            error instanceof Error &&
            'code' in error &&
            (error.code === 'ENOENT' || error.code === 'ENOTDIR')
          ) {
            return null
          }

          throw error
        })
      )
      if (!canonicalPath) {
        return yield* Effect.fail(
          new DomainError(
            'TREE_FILE_NOT_FOUND',
            'The selected file does not exist',
            404
          )
        )
      }

      if (!isPathWithin(canonicalPath, root)) {
        return yield* Effect.fail(
          new DomainError(
            'INVALID_TREE_FILE_PATH',
            'File path must stay inside the tree',
            400
          )
        )
      }

      const stat = yield* domainPromise(() =>
        fs.lstat(candidate).catch((error) => {
          if (
            error instanceof Error &&
            'code' in error &&
            (error.code === 'ENOENT' || error.code === 'ENOTDIR')
          ) {
            return null
          }

          throw error
        })
      )
      if (!stat) {
        return yield* Effect.fail(
          new DomainError(
            'TREE_FILE_NOT_FOUND',
            'The selected file does not exist',
            404
          )
        )
      }

      if (stat.isSymbolicLink() || !stat.isFile()) {
        return yield* Effect.fail(
          new DomainError(
            'TREE_FILE_UNSUPPORTED',
            'Only existing regular files can be edited',
            415
          )
        )
      }

      return {
        canonicalPath,
        path: path.relative(root, canonicalPath).split(path.sep).join('/')
      }
    })
  }

  private readTreeFileHandle(
    handle: Awaited<ReturnType<typeof fs.open>>
  ): Effect.Effect<{ bytes: Buffer; content: string }, DomainError<unknown>> {
    return Effect.gen(function* () {
      const stat = yield* Effect.promise(() => handle.stat())
      if (!stat.isFile()) {
        return yield* Effect.fail(
          new DomainError(
            'TREE_FILE_UNSUPPORTED',
            'Only existing regular files can be edited',
            415
          )
        )
      }

      if (stat.size > TREE_FILE_MAX_BYTES) {
        return yield* Effect.fail(
          new DomainError(
            'TREE_FILE_TOO_LARGE',
            'Files larger than 2 MiB cannot be edited',
            413
          )
        )
      }

      const buffer = Buffer.alloc(TREE_FILE_MAX_BYTES + 1)
      let bytesRead = 0
      while (bytesRead < buffer.length) {
        const read = yield* Effect.promise(() =>
          handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
        )
        if (read.bytesRead === 0) {
          break
        }

        bytesRead += read.bytesRead
      }
      if (bytesRead > TREE_FILE_MAX_BYTES) {
        return yield* Effect.fail(
          new DomainError(
            'TREE_FILE_TOO_LARGE',
            'Files larger than 2 MiB cannot be edited',
            413
          )
        )
      }

      const bytes = buffer.subarray(0, bytesRead)
      const content = yield* Effect.try({
        try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        catch: () =>
          new DomainError(
            'TREE_FILE_UNSUPPORTED',
            'Only UTF-8 text files can be edited',
            415
          )
      })
      if (content.includes('\0')) {
        return yield* Effect.fail(
          new DomainError(
            'TREE_FILE_UNSUPPORTED',
            'Only UTF-8 text files can be edited',
            415
          )
        )
      }

      return { bytes, content }
    })
  }
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}
