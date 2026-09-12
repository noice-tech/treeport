import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { TerminalHostFrameDecodeError } from './api'

const nonEmptyString = Schema.String.pipe(Schema.minLength(1))
const positiveInteger = Schema.Int.pipe(Schema.positive())

/** Recognition only: current hosts never write the retired protocol field. */
const terminalHostDiscoveryRecordSchema = Schema.Struct({
  hostId: nonEmptyString,
  hostKey: nonEmptyString,
  pid: positiveInteger,
  socketPath: nonEmptyString,
  startedAt: nonEmptyString,
  launcherPath: Schema.optional(nonEmptyString),
  provisional: Schema.optional(Schema.Boolean),
  protocolVersion: Schema.optional(positiveInteger)
})

export type TerminalHostDiscoveryRecord =
  typeof terminalHostDiscoveryRecordSchema.Type

export function decodeTerminalHostDiscoveryRecord(
  // eslint-disable-next-line anti-slop/no-unknown-parameters -- Discovery file contents are decoded by Effect Schema at this boundary.
  input: unknown
): Effect.Effect<TerminalHostDiscoveryRecord, TerminalHostFrameDecodeError> {
  return Schema.decodeUnknown(terminalHostDiscoveryRecordSchema)(input).pipe(
    Effect.mapError((cause) => new TerminalHostFrameDecodeError({ cause }))
  )
}
