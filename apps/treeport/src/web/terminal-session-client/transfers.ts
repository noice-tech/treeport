import * as Data from 'effect/Data'
import type { SessionTimer } from './timers'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import { parseResponse, rpc } from '../api'
import {
  decodeUnknownOrNull,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_UPLOAD_BYTES
} from '@treeport/shared'
import { errorMessage } from '../error-message'
import {
  type TerminalSessionState,
  type TerminalSessionSnapshot
} from './state'

const TERMINAL_MAX_FILES_PER_TRANSFER = 8
const BROWSER_LOCAL_FILE_PATH_SCHEMA = Schema.String.pipe(
  Schema.maxLength(16_384),
  Schema.startsWith('/'),
  Schema.filter((filePath) =>
    Array.from(filePath).every((character) => {
      const codePoint = character.codePointAt(0)!
      return codePoint > 31 && codePoint !== 127
    })
  )
)
const LOOPBACK_BROWSER_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

class TerminalTransferError extends Data.TaggedError('TerminalTransferError')<{
  readonly message: string
}> {}

type FileTransferRequest = {
  readonly files: File[]
  readonly streamId: string | null
  readonly generation: number
}

interface Dependencies {
  canInput(): boolean
  cancelTimer(key: SessionTimer): void
  clearSelection(): void
  focus(options?: { requestControl?: boolean }): void
  scheduleTimer(key: SessionTimer, callback: () => void, delay: number): void
  update(patch: Partial<TerminalSessionSnapshot>): void
}

export function makeTransfers(
  state: Pick<
    TerminalSessionState,
    | 'controllerGeneration'
    | 'disposed'
    | 'ready'
    | 'snapshotValue'
    | 'streamId'
    | 'terminal'
    | 'terminalId'
  >,
  dependencies: Dependencies
) {
  return Effect.gen(function* () {
    const fileTransferQueue = yield* Queue.bounded<FileTransferRequest>(8)
    const transfers = Effect.forever(
      Effect.gen(function* () {
        const request = yield* Queue.take(fileTransferQueue)
        yield* transferFiles(request).pipe(
          Effect.catchAllCause((cause) =>
            Effect.sync(() => {
              if (!state.disposed && !Cause.isInterruptedOnly(cause)) {
                showFileTransferError(errorMessage(Cause.squash(cause)))
              }
            })
          )
        )
      })
    ).pipe(Effect.ensuring(Queue.shutdown(fileTransferQueue)))

    yield* Effect.forkScoped(transfers)

    function queueFileTransfer(files: File[]): void {
      if (state.disposed) {
        return
      }

      // Validate before retaining Files in the bounded queue.
      if (files.length > TERMINAL_MAX_FILES_PER_TRANSFER) {
        showFileTransferError(
          `Choose no more than ${TERMINAL_MAX_FILES_PER_TRANSFER} files at a time`
        )
        return
      }

      if (files.some((file) => file.size > TERMINAL_MAX_UPLOAD_BYTES)) {
        showFileTransferError(
          `Files are limited to ${TERMINAL_MAX_UPLOAD_BYTES} bytes`
        )
        return
      }

      if (
        !Queue.unsafeOffer(fileTransferQueue, {
          files: [...files],
          streamId: state.streamId,
          generation: state.controllerGeneration
        })
      ) {
        showFileTransferError(
          'Too many pending file transfers; wait for an upload to finish'
        )
      }
    }

    function transferFiles(
      request: FileTransferRequest
    ): Effect.Effect<void, TerminalTransferError> {
      return Effect.gen(function* () {
        const { files, streamId, generation } = request
        if (!files.length || state.disposed) {
          return
        }

        if (!state.ready || !state.snapshotValue.controller) {
          return yield* new TerminalTransferError({
            message: state.snapshotValue.controlPending
              ? 'taking control; try again in a moment'
              : 'interact with the terminal to take control first'
          })
        }

        if (!dependencies.canInput()) {
          return yield* new TerminalTransferError({
            message: 'Wait for the terminal resize to finish'
          })
        }

        if (
          streamId !== state.streamId ||
          generation !== state.controllerGeneration
        ) {
          return yield* new TerminalTransferError({
            message: 'Terminal control changed before the upload started'
          })
        }

        dependencies.cancelTimer('fileTransfer')
        const desktopBridge = window.treeportDesktop
        const sourcePaths = yield* Effect.forEach(
          files,
          (file) => {
            if (desktopBridge?.getPathForFile) {
              return Effect.tryPromise(
                async () => desktopBridge.getPathForFile?.(file) ?? null
              ).pipe(Effect.orElseSucceed(() => null))
            }

            if (LOOPBACK_BROWSER_HOSTNAMES.has(window.location.hostname)) {
              // SAFETY: Privileged browser platforms can add this read-only File capability.
              const platformFile = file as File & { readonly path?: string }
              return Effect.succeed(
                decodeUnknownOrNull(
                  BROWSER_LOCAL_FILE_PATH_SCHEMA,
                  platformFile.path
                )
              )
            }

            return Effect.succeed(null)
          },
          { concurrency: TERMINAL_MAX_FILES_PER_TRANSFER }
        )

        const uploadCount = sourcePaths.filter((filePath) => !filePath).length
        if (uploadCount > 0) {
          dependencies.update({
            fileTransfer: {
              state: 'uploading',
              message: `Uploading ${uploadCount === 1 ? 'file' : `${uploadCount} files`}…`
            }
          })
        }

        const paths: string[] = []
        for (const [index, file] of files.entries()) {
          const sourcePath = sourcePaths[index]
          if (sourcePath) {
            paths.push(sourcePath)
            continue
          }

          const extension = /\.([a-z0-9]{1,16})$/i.exec(file.name)?.[1]
          const headers = new Headers({
            'content-type': file.type || 'application/octet-stream'
          })
          if (extension) {
            headers.set('x-treeport-file-extension', extension.toLowerCase())
          }

          const result = yield* Effect.tryPromise({
            try: (signal) =>
              parseResponse(
                rpc.api.terminals[':terminalId'].files.$post(
                  { param: { terminalId: state.terminalId } },
                  { init: { body: file, headers, signal } }
                )
              ),
            catch: (cause) =>
              new TerminalTransferError({ message: errorMessage(cause) })
          })
          paths.push(result.file.path)
        }

        // Losing and reacquiring control during an upload is not permission to
        // paste into a different stream or controller generation.
        if (
          streamId !== state.streamId ||
          generation !== state.controllerGeneration
        ) {
          return yield* new TerminalTransferError({
            message: 'Terminal control was lost during the upload'
          })
        }

        pasteResolvedFilePaths(
          paths,
          'Terminal control was lost during the upload'
        )
      }).pipe(
        Effect.timeoutFail({
          duration: '2 minutes',
          onTimeout: () =>
            new TerminalTransferError({ message: 'File transfer timed out' })
        })
      )
    }

    function pasteResolvedFilePaths(
      paths: string[],
      controlError?: string
    ): void {
      if (!paths.length || state.disposed) {
        return
      }

      if (paths.length > TERMINAL_MAX_FILES_PER_TRANSFER) {
        showFileTransferError(
          `Choose no more than ${TERMINAL_MAX_FILES_PER_TRANSFER} files at a time`
        )
        return
      }

      if (!state.ready || !state.snapshotValue.controller) {
        showFileTransferError(
          controlError ??
            (state.snapshotValue.controlPending
              ? 'taking control; try again in a moment'
              : 'interact with the terminal to take control first')
        )
        return
      }

      if (!dependencies.canInput()) {
        showFileTransferError('Wait for the terminal resize to finish')
        return
      }

      const input = paths
        .map((filePath) =>
          /^[A-Za-z0-9_+,./:@%=-]+$/u.test(filePath)
            ? filePath
            : `'${filePath.replaceAll("'", "'\\''")}'`
        )
        .join(' ')
      if (
        new TextEncoder().encode(input).byteLength >
        TERMINAL_MAX_INPUT_BYTES - 32
      ) {
        showFileTransferError('The file paths are too long')
        return
      }

      dependencies.clearSelection()
      state.terminal?.paste(input)
      dependencies.focus()
      dependencies.update({ fileTransfer: null })
    }

    function showFileTransferError(message: string): void {
      dependencies.cancelTimer('fileTransfer')

      dependencies.update({
        fileTransfer: {
          state: 'error',
          message: `Couldn’t paste file: ${message}`
        }
      })
      dependencies.scheduleTimer(
        'fileTransfer',
        () => {
          dependencies.update({ fileTransfer: null })
        },
        6_000
      )
    }

    return {
      queueFileTransfer,
      pasteResolvedFilePaths
    }
  })
}
