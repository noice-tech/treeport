import * as Schema from 'effect/Schema'

export const pushSubscriptionSchema = Schema.Struct({
  endpoint: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2048)),
  keys: Schema.Struct({
    p256dh: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{87}=?$/)),
    auth: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{22}={0,2}$/))
  })
})
export type WebPushSubscription = Schema.Schema.Type<
  typeof pushSubscriptionSchema
>
export const pushConfigResponseSchema = Schema.Struct({
  publicKey: Schema.String
})
export const pushUnsubscribeSchema = Schema.Struct({
  endpoint: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2048))
})
