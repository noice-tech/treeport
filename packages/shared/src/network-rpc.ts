import { Rpc, RpcGroup } from '@effect/rpc'
import * as Schema from 'effect/Schema'
import {
  EVENT_PROTOCOL_VERSION,
  eventsSnapshotSchema,
  productEventSchema
} from './socket-protocol.js'

export const projectEventsItemSchema = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal('Snapshot'),
    snapshot: eventsSnapshotSchema
  }),
  Schema.Struct({
    _tag: Schema.Literal('ProductEvent'),
    event: productEventSchema
  })
)
export type ProjectEventsItem = Schema.Schema.Type<
  typeof projectEventsItemSchema
>

export const projectEventsFailureSchema = Schema.Struct({
  _tag: Schema.Literal('ProjectEventsFailure'),
  message: Schema.String
})
export type ProjectEventsFailure = Schema.Schema.Type<
  typeof projectEventsFailureSchema
>

export const WatchProjectEvents = Rpc.make('WatchProjectEvents', {
  payload: {
    protocol: Schema.Literal(EVENT_PROTOCOL_VERSION)
  },
  success: projectEventsItemSchema,
  error: projectEventsFailureSchema,
  stream: true
})

export class TreeportRpcs extends RpcGroup.make(WatchProjectEvents) {}
