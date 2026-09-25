import * as Schema from 'effect/Schema'

const identifier = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128)
)

export const viewerIdentitySchema = Schema.Struct({
  source: Schema.Literal('local', 'tailscale'),
  login: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  profilePicture: Schema.NullOr(Schema.String)
})
export type ViewerIdentity = Schema.Schema.Type<typeof viewerIdentitySchema>

export const presenceUpdateSchema = Schema.Struct({
  sessionId: Schema.UUID,
  worktreeId: Schema.NullOr(identifier),
  focusedPanelId: Schema.NullOr(identifier),
  visible: Schema.Boolean,
  focused: Schema.Boolean
})
export type PresenceUpdate = Schema.Schema.Type<typeof presenceUpdateSchema>

export const workspacePresenceSchema = Schema.Struct({
  ...presenceUpdateSchema.fields,
  identity: viewerIdentitySchema
})
export type WorkspacePresence = Schema.Schema.Type<
  typeof workspacePresenceSchema
>

export const presenceResponseSchema = Schema.Struct({
  identity: viewerIdentitySchema
})

export const PRESENCE_HEARTBEAT_MS = 15_000
export const PRESENCE_TIMEOUT_MS = 45_000
