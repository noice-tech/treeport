import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DirectoryBrowseResponse } from '@treeport/shared'
import * as Effect from 'effect/Effect'
import * as Either from 'effect/Either'
import { DomainError } from '../../domain'
import type { ApplicationServices } from '../infrastructure/application-runtime'
import { GitPort } from '../infrastructure/ports'

export class ProjectDirectoryService {
  browseDirectory(
    inputPath: string,
    showHidden = false
  ): Effect.Effect<
    DirectoryBrowseResponse,
    DomainError<unknown>,
    ApplicationServices
  > {
    return Effect.gen(function* () {
      const git = yield* GitPort
      const homePath = os.homedir()
      const expandedPath =
        inputPath === '~'
          ? homePath
          : /^~[\\/]/u.test(inputPath)
            ? path.join(homePath, inputPath.slice(2))
            : inputPath
      if (!path.isAbsolute(expandedPath)) {
        return yield* Effect.fail(
          new DomainError(
            'DIRECTORY_PATH_NOT_ABSOLUTE',
            'Enter an absolute path on the Treeport server',
            400
          )
        )
      }

      const requestedPath = path.resolve(expandedPath)
      let exact = true
      let entryQuery = ''
      const requestedRealpath = yield* Effect.either(
        Effect.tryPromise({
          try: () => fs.realpath(requestedPath),
          catch: (error) => error
        })
      )
      let directoryPath: string
      if (Either.isRight(requestedRealpath)) {
        directoryPath = requestedRealpath.right
      } else {
        // SAFETY: Node filesystem failures can carry the standard errno code.
        const code = (requestedRealpath.left as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          return yield* Effect.fail(
            new DomainError(
              'DIRECTORY_UNREADABLE',
              'That folder cannot be read on the Treeport server',
              403
            )
          )
        }

        exact = false
        entryQuery ||= path.basename(requestedPath)
        directoryPath = yield* Effect.tryPromise({
          try: () => fs.realpath(path.dirname(requestedPath)),
          catch: (error) => {
            // SAFETY: Node filesystem failures can carry the standard errno code.
            const parentCode = (error as NodeJS.ErrnoException).code
            return new DomainError(
              parentCode === 'ENOENT'
                ? 'DIRECTORY_NOT_FOUND'
                : 'DIRECTORY_UNREADABLE',
              parentCode === 'ENOENT'
                ? 'That folder does not exist on the Treeport server'
                : 'That folder cannot be read on the Treeport server',
              parentCode === 'ENOENT' ? 404 : 403
            )
          }
        })
      }

      const directoryStat = yield* Effect.tryPromise({
        try: () => fs.stat(directoryPath),
        catch: (error) => {
          // SAFETY: Node filesystem failures can carry the standard errno code.
          const code = (error as NodeJS.ErrnoException).code
          return new DomainError(
            code === 'ENOENT' ? 'DIRECTORY_NOT_FOUND' : 'DIRECTORY_UNREADABLE',
            code === 'ENOENT'
              ? 'That folder does not exist on the Treeport server'
              : 'That folder cannot be read on the Treeport server',
            code === 'ENOENT' ? 404 : 403
          )
        }
      })
      if (!directoryStat.isDirectory()) {
        return yield* Effect.fail(
          new DomainError(
            'DIRECTORY_NOT_A_DIRECTORY',
            'That path is not a folder',
            400
          )
        )
      }

      const rawEntries = yield* Effect.tryPromise({
        try: () => fs.readdir(directoryPath, { withFileTypes: true }),
        catch: () =>
          new DomainError(
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
            (yield* Effect.tryPromise({
              try: () => fs.stat(entryPath),
              catch: () => undefined
            }).pipe(
              Effect.match({
                onFailure: () => false,
                onSuccess: (stat) => stat.isDirectory()
              })
            )))
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

      let repositoryPath: string | null = null
      if (exact) {
        const checkout = yield* Effect.promise(() =>
          git.findProjectRepositoryRoot(directoryPath)
        )
        if (checkout) {
          const mainCheckout = yield* Effect.promise(() =>
            git.resolveMainCheckout(checkout)
          )
          repositoryPath = yield* Effect.promise(() =>
            fs.realpath(mainCheckout)
          )
        }
      }

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
    })
  }
}
