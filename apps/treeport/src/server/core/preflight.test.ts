import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'
import {
  SpawnCommandError,
  type CommandRequest,
  type CommandResult,
  type EffectCommandRunner
} from './command'
import { checkRuntimePrerequisites } from './preflight'

function runner(
  effect: (
    request: CommandRequest
  ) => Effect.Effect<CommandResult, SpawnCommandError>
): EffectCommandRunner {
  return {
    run: (request) => Effect.runPromise(effect(request)),
    runEffect: effect
  }
}

describe('runtime prerequisite checks', () => {
  it('returns the configured Git version', async () => {
    const result = await Effect.runPromise(
      checkRuntimePrerequisites(
        { gitPath: '/custom/git' },
        runner((request) => {
          expect(request).toMatchObject({
            executable: '/custom/git',
            args: ['--version'],
            timeoutMs: 5_000
          })
          return Effect.succeed({
            stdout: 'git version 2.49.0\n',
            stderr: '',
            exitCode: 0
          })
        })
      )
    )

    expect(result).toEqual({ gitVersion: 'git version 2.49.0' })
  })

  it('maps execution and nonzero failures to PrerequisiteError', async () => {
    const requestFailure = await Effect.runPromise(
      Effect.flip(
        checkRuntimePrerequisites(
          { gitPath: 'git' },
          runner((request) =>
            Effect.fail(new SpawnCommandError(request, new Error('missing')))
          )
        )
      )
    )
    expect(requestFailure).toMatchObject({
      _tag: 'PrerequisiteError',
      prerequisite: 'git'
    })
    expect(requestFailure.message).toContain('Git is required')

    const exitFailure = await Effect.runPromise(
      Effect.flip(
        checkRuntimePrerequisites(
          { gitPath: 'git' },
          runner(() =>
            Effect.succeed({
              stdout: '',
              stderr: 'not executable',
              exitCode: 1
            })
          )
        )
      )
    )
    expect(exitFailure).toMatchObject({
      _tag: 'PrerequisiteError',
      prerequisite: 'git'
    })
    expect(exitFailure.message).toContain('not executable')
  })
})
