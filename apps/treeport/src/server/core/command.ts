import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as Cause from 'effect/Cause'
import * as Data from 'effect/Data'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'

const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024
const DEFAULT_KILL_GRACE_MS = 1_000

export interface CommandRequest {
  executable: string
  args: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdin?: string
  timeoutMs?: number
  killGraceMs?: number
  maxStdoutBytes?: number
  maxStderrBytes?: number
}

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>
}

export interface EffectCommandRunner extends CommandRunner {
  runEffect(
    request: CommandRequest
  ): Effect.Effect<CommandResult, CommandExecutionError>
}

export type CommandExecutionError =
  | SpawnCommandError
  | StdinCommandError
  | TimeoutCommandError
  | SignalCommandError
  | OutputLimitCommandError

export class SpawnCommandError extends Data.TaggedError('SpawnCommandError')<{
  readonly request: CommandRequest
  readonly cause: unknown
  readonly message: string
}> {
  constructor(request: CommandRequest, cause: unknown) {
    super({
      request,
      cause,
      message: `Failed to spawn ${request.executable}: ${errorMessage(cause)}`
    })
  }
}

export class StdinCommandError extends Data.TaggedError('StdinCommandError')<{
  readonly request: CommandRequest
  readonly cause: unknown
  readonly message: string
}> {
  constructor(request: CommandRequest, cause: unknown) {
    super({
      request,
      cause,
      message: `Failed to write stdin to ${request.executable}: ${errorMessage(cause)}`
    })
  }
}

export class TimeoutCommandError extends Data.TaggedError(
  'TimeoutCommandError'
)<{
  readonly request: CommandRequest
  readonly timeoutMs: number
  readonly message: string
}> {
  constructor(request: CommandRequest, timeoutMs: number) {
    super({
      request,
      timeoutMs,
      message: `${request.executable} timed out after ${timeoutMs}ms`
    })
  }
}

export class SignalCommandError extends Data.TaggedError('SignalCommandError')<{
  readonly request: CommandRequest
  readonly signal: NodeJS.Signals
  readonly message: string
}> {
  constructor(request: CommandRequest, signal: NodeJS.Signals) {
    super({
      request,
      signal,
      message: `${request.executable} was terminated by ${signal}`
    })
  }
}

export class OutputLimitCommandError extends Data.TaggedError(
  'OutputLimitCommandError'
)<{
  readonly request: CommandRequest
  readonly stream: 'stdout' | 'stderr'
  readonly limitBytes: number
  readonly message: string
}> {
  constructor(
    request: CommandRequest,
    stream: 'stdout' | 'stderr',
    limitBytes: number
  ) {
    super({
      request,
      stream,
      limitBytes,
      message: `${request.executable} exceeded the ${stream} limit of ${limitBytes} bytes`
    })
  }
}

export class ExternalCommandError extends Data.TaggedError(
  'ExternalCommandError'
)<{
  readonly request: CommandRequest
  readonly result: CommandResult
  readonly message: string
}> {
  constructor(message: string, request: CommandRequest, result: CommandResult) {
    super({ message, request, result })
  }
}

interface ChildResource {
  readonly child: ChildProcessWithoutNullStreams
  readonly processGroupId: number
  readonly exit: Deferred.Deferred<
    readonly [code: number | null, signal: NodeJS.Signals | null]
  >
  readonly onExit: (code: number | null, signal: NodeJS.Signals | null) => void
  readonly onProcessError: (error: Error) => void
  readonly stdout: Buffer[]
  readonly stderr: Buffer[]
  stdoutBytes: number
  stderrBytes: number
  terminalError: CommandExecutionError | null
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals
): void {
  try {
    process.kill(-processGroupId, signal)
  } catch (cause) {
    // SAFETY: Node reports process.kill failures as NodeJS.ErrnoException.
    if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw cause
    }
  }
}

/**
 * Runs a child command as an interruptible Effect. The child is acquired in an
 * isolated process group, so interruption completes only after the finalizer
 * has signaled the full group and observed the direct child exit.
 */
function runCommandEffect(
  request: CommandRequest
): Effect.Effect<CommandResult, CommandExecutionError> {
  const stdoutLimit = request.maxStdoutBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const stderrLimit = request.maxStderrBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const killGraceMs = request.killGraceMs ?? DEFAULT_KILL_GRACE_MS

  return Effect.acquireUseRelease(
    Deferred.make<
      readonly [code: number | null, signal: NodeJS.Signals | null]
    >().pipe(
      Effect.flatMap((exit) =>
        Effect.async<ChildResource, SpawnCommandError>((resume) => {
          let child: ChildProcessWithoutNullStreams
          try {
            child = spawn(request.executable, [...request.args], {
              cwd: request.cwd,
              env: request.env ?? process.env,
              stdio: ['pipe', 'pipe', 'pipe'],
              shell: false,
              detached: true
            })
          } catch (cause) {
            resume(Effect.fail(new SpawnCommandError(request, cause)))
            return
          }

          let spawned = false
          const onExit = (
            code: number | null,
            signal: NodeJS.Signals | null
          ) => {
            Deferred.unsafeDone(exit, Effect.succeed([code, signal]))
          }
          // Keep an error listener on stdin for the whole resource lifetime so
          // a late EPIPE cannot become an uncaught EventEmitter error after the
          // use phase has already failed or been interrupted.
          const onStdinResourceError = () => {}
          const onProcessError = (cause: Error) => {
            if (spawned) {
              return
            }

            child.removeListener('spawn', onSpawn)
            child.removeListener('exit', onExit)
            child.removeListener('error', onProcessError)
            resume(Effect.fail(new SpawnCommandError(request, cause)))
          }
          const onSpawn = () => {
            spawned = true
            child.removeListener('spawn', onSpawn)
            resume(
              Effect.succeed({
                child,
                processGroupId: child.pid!,
                exit,
                onExit,
                onProcessError,
                stdout: [],
                stderr: [],
                stdoutBytes: 0,
                stderrBytes: 0,
                terminalError: null
              })
            )
          }

          child.once('spawn', onSpawn)
          child.on('error', onProcessError)
          child.once('exit', onExit)
          child.stdin.on('error', onStdinResourceError)
          child.stdin.once('close', () => {
            child.stdin.removeListener('error', onStdinResourceError)
          })
        })
      )
    ),
    (resource) => {
      const awaitResult = Effect.async<CommandResult, CommandExecutionError>(
        (resume) => {
          let completed = false

          const removeUseListeners = () => {
            resource.child.removeListener('error', onError)
            resource.child.removeListener('close', onClose)
            resource.child.stdout.removeListener('data', onStdout)
            resource.child.stderr.removeListener('data', onStderr)
            resource.child.stdin.removeListener('error', onStdinError)
          }
          const fail = (
            error: Exclude<CommandExecutionError, TimeoutCommandError>
          ) => {
            if (completed) {
              return
            }

            completed = true
            resource.terminalError ??= error
            removeUseListeners()
            resume(Effect.fail(resource.terminalError))
          }
          const collect = (
            stream: 'stdout' | 'stderr',
            chunk: Buffer | string
          ) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            const limit = stream === 'stdout' ? stdoutLimit : stderrLimit
            const bytes =
              stream === 'stdout' ? resource.stdoutBytes : resource.stderrBytes
            const remaining = Math.max(0, limit - bytes)
            if (remaining > 0) {
              ;(stream === 'stdout' ? resource.stdout : resource.stderr).push(
                buffer.subarray(0, remaining)
              )
            }

            if (stream === 'stdout') {
              resource.stdoutBytes += buffer.length
            } else {
              resource.stderrBytes += buffer.length
            }

            if (bytes + buffer.length > limit) {
              fail(new OutputLimitCommandError(request, stream, limit))
            }
          }

          function onStdout(chunk: Buffer | string) {
            collect('stdout', chunk)
          }

          function onStderr(chunk: Buffer | string) {
            collect('stderr', chunk)
          }

          function onError(error: Error) {
            fail(new SpawnCommandError(request, error))
          }

          function onStdinError(error: Error) {
            fail(new StdinCommandError(request, error))
          }

          function onClose(code: number | null, signal: NodeJS.Signals | null) {
            if (completed) {
              return
            }

            completed = true
            removeUseListeners()
            if (signal) {
              resume(Effect.fail(new SignalCommandError(request, signal)))
              return
            }

            resume(
              Effect.succeed({
                stdout: Buffer.concat(resource.stdout).toString('utf8'),
                stderr: Buffer.concat(resource.stderr).toString('utf8'),
                exitCode: code ?? 1
              })
            )
          }

          resource.child.stdout.on('data', onStdout)
          resource.child.stderr.on('data', onStderr)
          resource.child.stdin.on('error', onStdinError)
          resource.child.on('error', onError)
          resource.child.once('close', onClose)

          try {
            resource.child.stdin.end(request.stdin)
          } catch (cause) {
            fail(new StdinCommandError(request, cause))
          }

          return Effect.sync(() => {
            if (completed) {
              return
            }

            completed = true
            removeUseListeners()
          })
        }
      )

      const timeoutMs = request.timeoutMs
      if (timeoutMs === undefined || timeoutMs <= 0) {
        return awaitResult
      }

      return Effect.raceFirst(
        awaitResult,
        Effect.sleep(Duration.millis(timeoutMs)).pipe(
          Effect.flatMap(() =>
            Effect.sync(() => {
              resource.terminalError ??= new TimeoutCommandError(
                request,
                timeoutMs
              )
              return resource.terminalError
            })
          ),
          Effect.flatMap(Effect.fail)
        )
      )
    },
    (resource, useExit) =>
      Deferred.isDone(resource.exit).pipe(
        Effect.flatMap((alreadyExited) => {
          if (alreadyExited && Exit.isSuccess(useExit)) {
            return Effect.void
          }

          return Effect.sync(() => {
            signalProcessGroup(resource.processGroupId, 'SIGTERM')
          }).pipe(
            Effect.zipRight(
              Effect.raceFirst(
                Deferred.await(resource.exit).pipe(
                  Effect.as(true),
                  Effect.interruptible
                ),
                Effect.sleep(Duration.millis(killGraceMs)).pipe(
                  Effect.as(false),
                  Effect.interruptible
                )
              )
            ),
            Effect.flatMap((exited) =>
              Effect.sync(() => {
                signalProcessGroup(resource.processGroupId, 'SIGKILL')
              }).pipe(
                Effect.zipRight(
                  exited ? Effect.void : Deferred.await(resource.exit)
                )
              )
            )
          )
        }),
        Effect.ensuring(
          Effect.sync(() => {
            resource.child.removeListener('exit', resource.onExit)
            resource.child.removeListener('error', resource.onProcessError)
          })
        ),
        Effect.asVoid
      )
  )
}

export class SpawnCommandRunner implements EffectCommandRunner {
  runEffect(
    request: CommandRequest
  ): Effect.Effect<CommandResult, CommandExecutionError> {
    return runCommandEffect(request)
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    const exit = await Effect.runPromiseExit(this.runEffect(request))
    if (Exit.isSuccess(exit)) {
      return exit.value
    }

    const failure = Cause.failureOption(exit.cause)
    if (Option.isSome(failure)) {
      throw failure.value
    }

    throw Cause.squash(exit.cause)
  }
}

export function runCheckedEffect(
  runner: EffectCommandRunner,
  request: CommandRequest
): Effect.Effect<CommandResult, CommandExecutionError | ExternalCommandError> {
  return runner.runEffect(request).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode === 0) {
        return Effect.succeed(result)
      }

      const detail =
        result.stderr.trim() ||
        result.stdout.trim() ||
        `exit ${result.exitCode}`
      return Effect.fail(
        new ExternalCommandError(
          `${request.executable} ${request.args[0] ?? ''} failed: ${detail}`,
          request,
          result
        )
      )
    })
  )
}

export async function runChecked(
  runner: CommandRunner,
  request: CommandRequest
): Promise<CommandResult> {
  const result = await runner.run(request)
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`
    throw new ExternalCommandError(
      `${request.executable} ${request.args[0] ?? ''} failed: ${detail}`,
      request,
      result
    )
  }

  return result
}

export function resolveExecutablePath(
  executable: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (path.isAbsolute(executable) || executable.includes(path.sep)) {
    return executable
  }

  for (const directory of (env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)) {
    const candidate = path.join(directory, executable)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Continue through PATH without invoking a shell.
    }
  }
  return executable
}
