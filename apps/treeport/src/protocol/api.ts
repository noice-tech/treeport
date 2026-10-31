import * as Schema from 'effect/Schema'
import type { ProjectRecord } from './project.ts'
import type { WorktreeRecord } from './worktree.ts'
import type { TerminalRecord } from './terminal.ts'

const nullableStringSchema = Schema.NullOr(Schema.String)

export const DESKTOP_PROTOCOL_VERSION = 3

export type TreeportContext =
  | {
      managed: false
      reason: 'outside_treeport'
    }
  | {
      managed: true
      apiUrl: string
      project: Pick<
        ProjectRecord,
        | 'id'
        | 'name'
        | 'kind'
        | 'rootPath'
        | 'repositoryPath'
        | 'mainWorktreePath'
        | 'defaultBranch'
        | 'availability'
      >
      worktree: Pick<
        WorktreeRecord,
        | 'id'
        | 'projectId'
        | 'name'
        | 'path'
        | 'head'
        | 'branch'
        | 'detached'
        | 'kind'
      >
      terminal: Pick<
        TerminalRecord,
        'id' | 'worktreeId' | 'name' | 'status' | 'exitCode'
      >
    }

export const apiErrorBodySchema = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    details: Schema.optional(Schema.Unknown)
  })
})

export type ApiErrorBody = Schema.Schema.Type<typeof apiErrorBodySchema>

export const okResponseSchema = Schema.Struct({ ok: Schema.Literal(true) })

export const phoneAccessResponseSchema = Schema.Struct({
  url: nullableStringSchema,
  error: nullableStringSchema,
  setupCommand: nullableStringSchema
})

export const healthResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  version: Schema.String,
  protocolVersion: Schema.Int,
  hostname: Schema.String,
  pid: Schema.Int,
  instanceId: nullableStringSchema,
  installationMethod: Schema.String,
  url: Schema.String
})

export type HealthResponse = Schema.Schema.Type<typeof healthResponseSchema>

export const uploadedFileResponseSchema = Schema.Struct({
  file: Schema.Struct({ path: Schema.String })
})
