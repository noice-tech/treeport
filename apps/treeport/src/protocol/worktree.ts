import type { TreeDecorationTone } from '@treeport/app-sdk'
import * as Schema from 'effect/Schema'
import {
  terminalNameSchema,
  terminalCommandSchema,
  terminalAfterExitSchema,
  terminalArgvSchema,
  terminalRecordSchema
} from './terminal.ts'
import { workspaceItemSchema } from './workspace.ts'
import { terminalSizeSchema } from './terminal-session.ts'

const nullableStringSchema = Schema.NullOr(Schema.String)

export const TREE_DECORATION_TONES = [
  'neutral',
  'info',
  'success',
  'warning',
  'danger',
  'done'
] as const satisfies readonly TreeDecorationTone[]

export type WorktreeRecord = typeof worktreeRecordSchema.Type

export type DirtyState = typeof dirtyStateSchema.Type

export const WORKTREE_TITLE_MAX_LENGTH = 120

export function normalizeWorktreeName(input: string): string {
  const name = input
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')

  if (!name) {
    throw new Error('Tree name is required')
  }

  if (name.length > 120) {
    throw new Error('Tree name must be 120 characters or fewer')
  }

  return name
}

const TREE_NAME_ADJECTIVES = [
  'amber',
  'bold',
  'brave',
  'bright',
  'brisk',
  'calm',
  'clever',
  'cosy',
  'crisp',
  'daring',
  'eager',
  'early',
  'fair',
  'fleet',
  'fresh',
  'gentle',
  'golden',
  'grand',
  'happy',
  'hidden',
  'jolly',
  'keen',
  'kind',
  'lively',
  'lucky',
  'merry',
  'mellow',
  'misty',
  'nimble',
  'noble',
  'proud',
  'quick',
  'quiet',
  'rapid',
  'silver',
  'steady',
  'sunny',
  'swift',
  'tidy',
  'wild'
]

const TREE_NAME_NOUNS = [
  'acorn',
  'alder',
  'aspen',
  'bamboo',
  'banyan',
  'baobab',
  'birch',
  'cedar',
  'cherry',
  'cypress',
  'elm',
  'fern',
  'fig',
  'fir',
  'grove',
  'hazel',
  'hemlock',
  'holly',
  'juniper',
  'larch',
  'laurel',
  'linden',
  'magnolia',
  'maple',
  'meadow',
  'moss',
  'oak',
  'olive',
  'palm',
  'pine',
  'poplar',
  'redwood',
  'rowan',
  'sequoia',
  'spruce',
  'sycamore',
  'thicket',
  'walnut',
  'willow',
  'yew'
]

/** A random `adjective-noun` name, with a numeric suffix if every tried name is taken. */
export function availableTreeName(takenNames: readonly string[]): string {
  const taken = new Set(takenNames.map((name) => name.toLowerCase()))

  const pick = (words: readonly string[]) =>
    words[Math.floor(Math.random() * words.length)]!

  let name = `${pick(TREE_NAME_ADJECTIVES)}-${pick(TREE_NAME_NOUNS)}`

  for (let attempt = 1; taken.has(name); attempt += 1) {
    name = `${pick(TREE_NAME_ADJECTIVES)}-${pick(TREE_NAME_NOUNS)}${attempt > 32 ? `-${attempt}` : ''}`
  }

  return name
}

const initialTerminalSchema = Schema.Struct({
  name: terminalNameSchema,
  command: Schema.optional(terminalCommandSchema),
  afterExit: Schema.optional(terminalAfterExitSchema),
  initialSize: Schema.optional(terminalSizeSchema)
})

export const createWorktreeSchema = Schema.Struct({
  name: Schema.optional(
    Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(120))
  ),
  base: Schema.optionalWith(Schema.Literal('default', 'current'), {
    default: () => 'default' as const
  }),
  sourceWorktreeId: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  originWorktreeId: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  initialTerminal: Schema.optional(initialTerminalSchema),
  treeTitle: Schema.optional(
    Schema.Struct({
      command: terminalArgvSchema,
      pendingTitle: Schema.Trim.pipe(
        Schema.minLength(1),
        Schema.maxLength(WORKTREE_TITLE_MAX_LENGTH)
      )
    })
  )
}).pipe(
  Schema.filter(
    (value) => value.base !== 'current' || Boolean(value.sourceWorktreeId),
    { message: () => 'A source tree is required when starting from current' }
  )
)

export const updateWorktreeTitleSchema = Schema.Struct({
  title: Schema.NullOr(
    Schema.Trim.pipe(
      Schema.minLength(1),
      Schema.maxLength(WORKTREE_TITLE_MAX_LENGTH)
    )
  )
})

export const TREE_DECORATION_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const TREE_DECORATION_TEXT_MAX_LENGTH = 32

export const setTreeDecorationSchema = Schema.Struct({
  text: Schema.Trim.pipe(
    Schema.minLength(1),
    Schema.maxLength(TREE_DECORATION_TEXT_MAX_LENGTH)
  ),
  title: Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(256)),
  tone: Schema.optionalWith(Schema.Literal(...TREE_DECORATION_TONES), {
    default: () => 'neutral' as const
  }),
  url: Schema.optionalWith(
    Schema.NullOr(
      Schema.String.pipe(
        Schema.maxLength(2_048),
        Schema.filter(
          (url) =>
            URL.canParse(url) &&
            ['http:', 'https:'].includes(new URL(url).protocol),
          { message: () => 'A decoration URL must use http or https' }
        )
      )
    ),
    { default: () => null }
  ),
  icon: Schema.optionalWith(
    Schema.NullOr(
      Schema.Trim.pipe(
        Schema.maxLength(8_192),
        Schema.filter(
          (icon) => icon.startsWith('<svg') && icon.endsWith('</svg>'),
          { message: () => 'A decoration icon must be an <svg> element' }
        )
      )
    ),
    { default: () => null }
  )
})

export const treeDecorationSchema = Schema.Struct({
  key: Schema.String,
  text: Schema.String,
  title: Schema.String,
  tone: Schema.Literal(...TREE_DECORATION_TONES),
  url: nullableStringSchema,
  icon: nullableStringSchema,
  source: nullableStringSchema,
  updatedAt: Schema.String
})

export const dirtyStateSchema = Schema.Struct({
  dirty: Schema.Boolean,
  staged: Schema.NonNegativeInt,
  unstaged: Schema.NonNegativeInt,
  untracked: Schema.NonNegativeInt,
  conflicts: Schema.NonNegativeInt,
  total: Schema.NonNegativeInt
})

export const worktreeRecordSchema = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    projectId: Schema.String,
    name: Schema.String,
    title: nullableStringSchema,
    /** Shown while the launcher's tree title command runs; null otherwise. */
    pendingTitle: nullableStringSchema,
    path: Schema.String,
    head: Schema.String,
    branch: nullableStringSchema,
    detached: Schema.Boolean,
    locked: Schema.Boolean,
    lockReason: nullableStringSchema,
    prunable: Schema.Boolean,
    kind: Schema.Literal('main', 'linked', 'folder'),
    managedWrapperPath: nullableStringSchema,
    originWorktreeId: nullableStringSchema,
    decorations: Schema.mutable(Schema.Array(treeDecorationSchema)),
    dirty: Schema.NullOr(dirtyStateSchema),
    terminals: Schema.mutable(Schema.Array(terminalRecordSchema)),
    workspaceItems: Schema.mutable(Schema.Array(workspaceItemSchema)),
    createdAt: Schema.String,
    updatedAt: Schema.String
  })
)

const worktreeListenerDiscoverySchema = Schema.Struct({
  supported: Schema.Boolean,
  message: nullableStringSchema,
  listeners: Schema.Array(
    Schema.Struct({
      pid: Schema.Int,
      command: Schema.String,
      host: Schema.String,
      port: Schema.Int,
      terminalId: nullableStringSchema
    })
  )
})

export const worktreeResponseSchema = Schema.Struct({
  worktree: worktreeRecordSchema
})

export const worktreesResponseSchema = Schema.Struct({
  worktrees: Schema.Array(worktreeRecordSchema)
})

export const listenerDiscoveryResponseSchema = Schema.Struct({
  discovery: worktreeListenerDiscoverySchema
})
