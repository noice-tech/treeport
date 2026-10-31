import * as Schema from 'effect/Schema'

const stringArraySchema = Schema.Array(Schema.String)

export const TREE_FILE_MAX_BYTES = 2 * 1024 * 1024
export const TREE_FILE_LIST_MAX_ENTRIES = 50_000
const TREE_FILE_SEARCH_QUERY_MAX_LENGTH = 256
export const TREE_FILE_SEARCH_MAX_MATCHES = 500
export const TREE_FILE_SEARCH_PREVIEW_MAX_LENGTH = 300

export const treeFilePathSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4_096),
  Schema.filter(
    (value) =>
      !value.includes('\0') &&
      !value.startsWith('/') &&
      value.split('/').every((segment) => segment !== '' && segment !== '..'),
    { message: () => 'File path must be a relative path inside the tree' }
  )
)

export const readTreeFileSchema = Schema.Struct({ path: treeFilePathSchema })

export const searchTreeFilesSchema = Schema.Struct({
  query: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(TREE_FILE_SEARCH_QUERY_MAX_LENGTH),
    Schema.filter((value) => !/[\0\r\n]/.test(value), {
      message: () => 'Search query must be one line and cannot contain NUL'
    })
  )
})

export const writeTreeFileSchema = Schema.Struct({
  path: treeFilePathSchema,
  content: Schema.String,
  expectedRevision: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(128)
  )
})

export const treeFileListingSchema = Schema.Struct({
  paths: stringArraySchema,
  truncated: Schema.Boolean
})

export const treeFileSchema = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  revision: Schema.String
})

export const treeFileSearchResultSchema = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      matches: Schema.Array(
        Schema.Struct({
          lineNumber: Schema.Int,
          column: Schema.NonNegativeInt,
          length: Schema.NonNegativeInt,
          preview: Schema.String,
          previewStart: Schema.NonNegativeInt,
          lineLength: Schema.NonNegativeInt
        })
      )
    })
  ),
  truncated: Schema.Boolean
})

export const treeFileWriteResultSchema = Schema.Struct({
  path: Schema.String,
  revision: Schema.String
})
