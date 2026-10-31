import * as Schema from 'effect/Schema'

const stringArraySchema = Schema.Array(Schema.String)

const nullableStringSchema = Schema.NullOr(Schema.String)

export const gitDiffImageSchema = Schema.Struct({
  dataUrl: Schema.String,
  byteLength: Schema.Number
})

const gitDiffFileSchema = Schema.Struct({
  path: Schema.String,
  previousPath: nullableStringSchema,
  status: Schema.Literal('modified', 'added', 'deleted', 'renamed', 'untracked')
})

const gitDiffSchema = Schema.Struct({
  baseRef: Schema.String,
  baseCommit: Schema.String,
  headCommit: Schema.String,
  generatedAt: Schema.String,
  files: Schema.Array(gitDiffFileSchema),
  lineCounts: Schema.Struct({
    additions: Schema.NonNegativeInt,
    deletions: Schema.NonNegativeInt
  }),
  changeSets: Schema.Struct({
    branch: stringArraySchema,
    staged: stringArraySchema,
    unstaged: stringArraySchema,
    untracked: stringArraySchema
  })
})

export const gitDiffResponseSchema = Schema.Struct({ diff: gitDiffSchema })

export const gitFileDiffResponseSchema = Schema.Struct({
  path: Schema.String,
  status: Schema.Literal('ready', 'oversized'),
  unified: nullableStringSchema,
  revision: nullableStringSchema,
  message: nullableStringSchema
})
