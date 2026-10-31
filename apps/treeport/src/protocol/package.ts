import * as Schema from 'effect/Schema'
import { projectRecordSchema } from './project.ts'
import { treeDecorationSchema } from './worktree.ts'

const nullableStringSchema = Schema.NullOr(Schema.String)

const packageScopeSchema = Schema.Literal('global', 'project')

export type PackageScope = typeof packageScopeSchema.Type

export type PackageResourceDiagnostic =
  typeof packageResourceDiagnosticSchema.Type

export type PackageSource =
  | string
  | {
      source: string
      autoload?: boolean
      webApps?: string[]
      launchers?: string[]
    }

export type PackageListing = typeof packageListingSchema.Type

export type PackageOperationResult = typeof packageOperationResultSchema.Type

export const packageProjectQuerySchema = Schema.Struct({
  path: Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(4_096))
})

export const packageInstallSchema = Schema.Struct({
  source: Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(4_096)),
  projectId: Schema.optional(Schema.String.pipe(Schema.minLength(1)))
})

export const packageRemoveSchema = Schema.Struct({
  source: Schema.String.pipe(Schema.minLength(1)),
  projectId: Schema.optional(Schema.String.pipe(Schema.minLength(1)))
})

export const packageReloadSchema = Schema.Struct({
  projectId: Schema.optional(Schema.String.pipe(Schema.minLength(1)))
})

const packageResourceDiagnosticSchema = Schema.mutable(
  Schema.Struct({
    severity: Schema.Literal('warning', 'error'),
    message: Schema.String,
    scope: packageScopeSchema,
    source: Schema.optional(Schema.String),
    projectId: Schema.optional(Schema.String),
    resourceType: Schema.optional(Schema.Literal('web-app', 'launcher')),
    path: Schema.optional(Schema.String)
  })
)

const packageListingSchema = Schema.Struct({
  source: Schema.String,
  identity: Schema.String,
  scope: packageScopeSchema,
  projectId: nullableStringSchema,
  projectName: nullableStringSchema,
  installedPath: nullableStringSchema,
  resources: Schema.Struct({
    webApps: Schema.NonNegativeInt,
    launchers: Schema.NonNegativeInt
  }),
  diagnostics: Schema.Array(packageResourceDiagnosticSchema)
})

const packageOperationResultSchema = Schema.Struct({
  action: Schema.Literal('install', 'remove', 'reload'),
  source: nullableStringSchema,
  scope: packageScopeSchema,
  projectId: nullableStringSchema,
  status: Schema.Literal('installed', 'removed', 'reloaded'),
  reason: Schema.optional(Schema.String)
})

export const packageListingResponseSchema = Schema.Struct({
  packages: Schema.Array(packageListingSchema),
  diagnostics: Schema.Array(packageResourceDiagnosticSchema)
})

export const packageOperationResponseSchema = Schema.Struct({
  result: packageOperationResultSchema
})

export const packageReloadResponseSchema = Schema.Struct({
  results: Schema.Array(packageOperationResultSchema),
  diagnostics: Schema.Array(packageResourceDiagnosticSchema)
})

export const packageProjectResponseSchema = Schema.Struct({
  project: projectRecordSchema
})

export const packageServiceSelfResponseSchema = Schema.Struct({
  packageId: Schema.String,
  /** Null when the package is configured globally. */
  projectIds: Schema.NullOr(Schema.Array(Schema.String))
})

export const packageServiceProjectsResponseSchema = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      rootPath: Schema.String,
      availability: Schema.Struct({
        state: Schema.Literal('available', 'unavailable'),
        message: nullableStringSchema
      }),
      git: Schema.NullOr(
        Schema.Struct({
          defaultBranch: Schema.String,
          originUrl: nullableStringSchema
        })
      ),
      worktrees: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          git: Schema.NullOr(
            Schema.Struct({ branch: nullableStringSchema, head: Schema.String })
          ),
          decorations: Schema.Array(treeDecorationSchema)
        })
      )
    })
  )
})
