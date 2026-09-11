import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import type { EffectCommandRunner } from './command'
import type { AppConfig } from './config'

export interface RuntimePrerequisites {
  gitVersion: string
}

export class PrerequisiteError extends Data.TaggedError('PrerequisiteError')<{
  readonly prerequisite: 'git'
  readonly cause: unknown
  readonly message: string
}> {
  constructor(gitPath: string, cause: unknown) {
    super({
      prerequisite: 'git',
      cause,
      message: `Git is required but ${gitPath} could not be executed: ${cause instanceof Error ? cause.message : String(cause)}`
    })
  }
}

export function checkRuntimePrerequisites(
  config: Pick<AppConfig, 'gitPath'>,
  runner: EffectCommandRunner
): Effect.Effect<RuntimePrerequisites, PrerequisiteError> {
  return runner
    .runEffect({
      executable: config.gitPath,
      args: ['--version'],
      timeoutMs: 5_000
    })
    .pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed({ gitVersion: result.stdout.trim() })
          : Effect.fail(
              new PrerequisiteError(
                config.gitPath,
                result.stderr.trim() ||
                  `Git exited with code ${result.exitCode}`
              )
            )
      ),
      Effect.mapError((cause) =>
        cause instanceof PrerequisiteError
          ? cause
          : new PrerequisiteError(config.gitPath, cause)
      )
    )
}
