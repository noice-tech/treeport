import * as Schema from 'effect/Schema'

export const COMPUTER_LIMIT = 256

export const computerIdSchema = Schema.String.pipe(
  Schema.pattern(/^cmp_[a-f0-9]{32}$/u)
)

const computerUrlSchema = Schema.String.pipe(
  Schema.maxLength(2_048),
  Schema.filter((value) => {
    const url = URL.parse(value)

    return (
      url !== null &&
      url.protocol === 'https:' &&
      url.origin === value &&
      !url.username &&
      !url.password
    )
  })
)

export const computerEntrySchema = Schema.Struct({
  id: computerIdSchema,
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(253)),
  url: computerUrlSchema,
  seenAt: Schema.Number,
  removed: Schema.Boolean,
  changedAt: Schema.Number
})

export type ComputerEntry = Schema.Schema.Type<typeof computerEntrySchema>

export const computerExchangeSchema = Schema.Struct({
  self: Schema.NullOr(computerEntrySchema),
  computers: Schema.Array(computerEntrySchema).pipe(
    Schema.maxItems(COMPUTER_LIMIT)
  )
})

export type ComputerExchange = Schema.Schema.Type<typeof computerExchangeSchema>

export const computersResponseSchema = Schema.Struct({
  self: Schema.Struct({
    id: computerIdSchema,
    name: Schema.String,
    url: Schema.NullOr(Schema.String)
  }),
  computers: Schema.Array(computerEntrySchema)
})

export const computerAddSchema = Schema.Struct({
  url: computerUrlSchema,
  restoreForgotten: Schema.Boolean
})

export const computerResponseSchema = Schema.Struct({
  computer: computerEntrySchema
})

export const computerForgetSchema = Schema.Struct({ id: computerIdSchema })
