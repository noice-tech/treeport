import * as Schema from 'effect/Schema'
import { worktreeRecordSchema } from './worktree.ts'

const nullableStringSchema = Schema.NullOr(Schema.String)

export const PROJECT_COLORS = [
  'rose',
  'orange',
  'amber',
  'emerald',
  'cyan',
  'blue',
  'violet',
  'pink'
] as const

const projectColorSchema = Schema.Literal(...PROJECT_COLORS)

export type ProjectColor = typeof projectColorSchema.Type

export type ProjectRecord = typeof projectRecordSchema.Type

export type RecentProjectRecord = typeof recentProjectRecordSchema.Type

export type DirectoryBrowseResponse = typeof directoryBrowseResponseSchema.Type

export const browseDirectoryQuerySchema = Schema.Struct({
  input: Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(4_096)),
  hidden: Schema.optionalWith(
    Schema.Literal('true', 'false').pipe(
      Schema.transform(Schema.Boolean, {
        strict: true,
        decode: (value) => value === 'true',
        encode: (value) => (value ? 'true' : 'false')
      })
    ),
    { default: () => false }
  )
})

export const registerProjectSchema = Schema.Struct({
  path: Schema.Trim.pipe(Schema.minLength(1)),
  name: Schema.optional(
    Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(120))
  )
})

export const updateProjectSchema = Schema.Struct({
  color: Schema.NullOr(projectColorSchema)
})

export const projectRecordSchema = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    kind: Schema.Literal('repository', 'folder'),
    /** Canonical root folder for this project. */
    rootPath: Schema.String,
    /**
     * Repository root for repository projects. Folder projects use rootPath here
     * to preserve the version 1 API shape; inspect kind before using Git fields.
     */
    repositoryPath: Schema.String,
    /**
     * Main checkout for repository projects. Folder projects use rootPath here
     * to preserve the version 1 API shape; inspect kind before using Git fields.
     */
    mainWorktreePath: Schema.String,
    /** Empty for folder projects. */
    defaultBranch: Schema.String,
    /** Fetch URL of the repository's origin remote, when it has one. */
    originUrl: nullableStringSchema,
    color: Schema.NullOr(projectColorSchema),
    availability: Schema.Struct({
      state: Schema.Literal('available', 'unavailable'),
      message: nullableStringSchema
    }),
    worktrees: Schema.mutable(Schema.Array(worktreeRecordSchema)),
    createdAt: Schema.String,
    updatedAt: Schema.String
  })
)

const recentProjectRecordSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literal('repository', 'folder'),
  rootPath: Schema.String,
  repositoryPath: Schema.String,
  lastOpenedAt: Schema.String
})

export const directoryBrowseResponseSchema = Schema.Struct({
  input: Schema.String,
  exact: Schema.Boolean,
  directory: Schema.Struct({
    path: Schema.String,
    parentPath: nullableStringSchema,
    homePath: Schema.String,
    rootPath: Schema.String,
    breadcrumbs: Schema.mutable(
      Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String }))
    ),
    entries: Schema.mutable(
      Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String }))
    ),
    truncated: Schema.Boolean
  }),
  project: Schema.Union(
    Schema.Struct({
      state: Schema.Literal('valid'),
      kind: Schema.Literal('repository', 'folder'),
      path: Schema.String
    }),
    Schema.Struct({
      state: Schema.Literal('incomplete'),
      message: Schema.String
    })
  ),
  repository: Schema.Union(
    Schema.Struct({
      state: Schema.Literal('valid'),
      repositoryPath: Schema.String
    }),
    Schema.Struct({
      state: Schema.Literal('incomplete'),
      message: Schema.String
    }),
    Schema.Struct({
      state: Schema.Literal('not-repository'),
      message: Schema.String
    })
  )
})

export const projectsResponseSchema = Schema.Struct({
  projects: Schema.Array(projectRecordSchema)
})

export const recentProjectsResponseSchema = Schema.Struct({
  projects: Schema.Array(recentProjectRecordSchema)
})

export const projectResponseSchema = Schema.Struct({
  project: projectRecordSchema
})
