import type { PrInfo, PrState } from '@treeport/shared'
import { z } from 'zod'
import type { CommandRunner } from './command'

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

export function mapPrState(pr: GhPrJson | null): PrState {
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

export class GhAdapter {
  constructor(
    private readonly runner: CommandRunner,
    private readonly executable = 'gh'
  ) {}

  async pullRequest(cwd: string, branch: string): Promise<PrInfo> {
    const checkedAt = new Date().toISOString()
    try {
      const auth = await this.runner.run({
        executable: this.executable,
        args: ['auth', 'status'],
        cwd,
        timeoutMs: 10_000
      })
      if (auth.exitCode !== 0) {
        return unknownPr()
      }

      const result = await this.runner.run({
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

      const values = z.array(ghPrSchema).parse(JSON.parse(result.stdout))
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
    } catch {
      return unknownPr()
    }
  }
}
