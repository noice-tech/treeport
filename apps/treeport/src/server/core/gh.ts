import type { PrInfo, PrState } from '@treeport/shared'
import { z } from 'zod'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import {
  asEffectCommandRunner,
  type CommandRunner,
  type EffectCommandRunner
} from './command'

const ghPrSchema = z
  .object({
    number: z.number().optional(),
    state: z.string().optional(),
    url: z.string().optional(),
    baseRefName: z.string().optional(),
    headRefName: z.string().optional(),
    mergedAt: z.string().nullable().optional()
  })
  .strict()

type GhPrJson = z.infer<typeof ghPrSchema>

function mapPrState(pr: GhPrJson | null): PrState {
  if (!pr) {
    return 'no_pr'
  }

  if (pr.mergedAt || pr.state?.toUpperCase() === 'MERGED') {
    return 'merged'
  }

  if (pr.state?.toUpperCase() === 'OPEN') {
    return 'open'
  }

  if (pr.state?.toUpperCase() === 'CLOSED') {
    return 'closed'
  }

  return 'unknown'
}

const unknownPr = (): PrInfo => ({
  state: 'unknown',
  number: null,
  url: null,
  baseBranch: null,
  headBranch: null,
  mergedAt: null,
  refreshedAt: new Date().toISOString()
})

class GitHubDecodeError extends Data.TaggedError('GitHubDecodeError')<{
  readonly cause: unknown
  readonly message: string
}> {
  constructor(cause: unknown) {
    super({
      cause,
      message: cause instanceof Error ? cause.message : String(cause)
    })
  }
}

export class GhAdapter {
  private readonly runner: EffectCommandRunner

  constructor(
    runner: CommandRunner,
    private readonly executable = 'gh'
  ) {
    this.runner = asEffectCommandRunner(runner)
  }

  pullRequest(cwd: string, branch: string): Effect.Effect<PrInfo> {
    const lookup = Effect.gen(this, function* () {
      const checkedAt = new Date().toISOString()
      const auth = yield* this.runner.runEffect({
        executable: this.executable,
        args: ['auth', 'status'],
        cwd,
        timeoutMs: 10_000
      })
      if (auth.exitCode !== 0) {
        return unknownPr()
      }

      const result = yield* this.runner.runEffect({
        executable: this.executable,
        args: [
          'pr',
          'list',
          '--head',
          branch,
          '--state',
          'all',
          '--limit',
          '1',
          '--json',
          'number,state,url,baseRefName,headRefName,mergedAt'
        ],
        cwd,
        timeoutMs: 30_000
      })
      if (result.exitCode !== 0) {
        return unknownPr()
      }

      const values = yield* Effect.try({
        try: () => z.array(ghPrSchema).parse(JSON.parse(result.stdout)),
        catch: (cause) => new GitHubDecodeError(cause)
      })
      const pr = values[0] ?? null
      return {
        state: mapPrState(pr),
        number: pr?.number ?? null,
        url: pr?.url ?? null,
        baseBranch: pr?.baseRefName ?? null,
        headBranch: pr?.headRefName ?? null,
        mergedAt: pr?.mergedAt ?? null,
        refreshedAt: checkedAt
      }
    })

    return lookup.pipe(Effect.catchAll(() => Effect.succeed(unknownPr())))
  }
}

export class GitHubPort extends Context.Tag('treeport/GitHub')<
  GitHubPort,
  GhAdapter
>() {}

export function GitHubLayer(
  runner: CommandRunner,
  executable = 'gh'
): Layer.Layer<GitHubPort> {
  return Layer.succeed(GitHubPort, new GhAdapter(runner, executable))
}
