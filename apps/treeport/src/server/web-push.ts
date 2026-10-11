import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { Agent } from 'node:https'
import path from 'node:path'
import webpush from 'web-push'
import * as Schema from 'effect/Schema'
import {
  pushSubscriptionSchema,
  type WebPushSubscription,
  type ViewerIdentity
} from '@treeport/shared'
import { DomainError } from './core/index'

const stateSchema = Schema.Struct({
  publicKey: Schema.String,
  privateKey: Schema.String,
  subscriptions: Schema.Array(
    Schema.Struct({
      owner: Schema.String,
      subscription: pushSubscriptionSchema
    })
  )
})
type PushState = Schema.Schema.Type<typeof stateSchema>

// Subscription endpoints are browser-supplied URLs. Only known push services
// may receive server-side requests; never turn this API into an SSRF proxy.
function validateEndpoint(endpoint: string): void {
  if (!URL.canParse(endpoint)) {
    throw new DomainError(
      'INVALID_PUSH_ENDPOINT',
      'Invalid push endpoint URL',
      400
    )
  }

  const url = new URL(endpoint)
  const allowed =
    url.hostname === 'fcm.googleapis.com' ||
    url.hostname === 'web.push.apple.com' ||
    url.hostname === 'updates.push.services.mozilla.com' ||
    url.hostname.endsWith('.notify.windows.com')
  if (
    !allowed ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    url.hash
  ) {
    throw new DomainError(
      'INVALID_PUSH_ENDPOINT',
      'Unsupported push service endpoint',
      400
    )
  }
}

export class WebPushManager {
  private writes: Promise<void> = Promise.resolve()
  private disposed = false
  private readonly agent = new Agent({
    keepAlive: true,
    maxSockets: 4,
    maxTotalSockets: 4
  })

  private constructor(
    private readonly filename: string,
    private state: PushState
  ) {}

  static async open(dataDir: string): Promise<WebPushManager> {
    const filename = path.join(dataDir, 'web-push.json')
    const saved = await fs
      .readFile(filename, 'utf8')
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return null
        }

        throw error
      })
    // Do not silently rotate keys on corrupt state: that strands installed PWAs.
    const state =
      saved === null
        ? { ...webpush.generateVAPIDKeys(), subscriptions: [] }
        : Schema.decodeUnknownSync(stateSchema)(JSON.parse(saved))
    for (const record of state.subscriptions) {
      validateEndpoint(record.subscription.endpoint)
    }
    const manager = new WebPushManager(filename, state)
    if (saved === null) {
      await manager.persist(state)
    }

    return manager
  }

  get publicKey(): string {
    return this.state.publicKey
  }
  get hasSubscriptions(): boolean {
    return !this.disposed && this.state.subscriptions.length > 0
  }

  update(
    identity: ViewerIdentity,
    subscription: WebPushSubscription | null,
    endpoint: string
  ): Promise<void> {
    validateEndpoint(endpoint)
    const owner = JSON.stringify([identity.source, identity.login])
    return this.mutate((state) => {
      const existing = state.subscriptions.find(
        (record) => record.subscription.endpoint === endpoint
      )
      if (existing && existing.owner !== owner) {
        throw new DomainError(
          'PUSH_SUBSCRIPTION_OWNER',
          'This push subscription belongs to another user',
          403
        )
      }

      const subscriptions = state.subscriptions.filter(
        (record) => record.subscription.endpoint !== endpoint
      )
      if (subscription) {
        if (subscriptions.length >= 128) {
          throw new DomainError(
            'PUSH_LIMIT',
            'Too many push subscriptions',
            429
          )
        }

        subscriptions.push({ owner, subscription })
      }

      return { ...state, subscriptions }
    })
  }

  async notify(payload: {
    title: string
    body: string
    url: string
    tag: string
  }): Promise<void> {
    if (!this.hasSubscriptions) {
      return
    }

    const subscriptions = [...this.state.subscriptions]
    // Bound fan-out and network waits; expired endpoints are pruned without
    // deleting a subscription that was replaced while a delivery was in flight.
    for (
      let index = 0;
      index < subscriptions.length && !this.disposed;
      index += 4
    ) {
      await Promise.all(
        subscriptions.slice(index, index + 4).map(async (record) => {
          await webpush
            .sendNotification(record.subscription, JSON.stringify(payload), {
              vapidDetails: {
                subject: 'https://treeport.app',
                publicKey: this.state.publicKey,
                privateKey: this.state.privateKey
              },
              TTL: 300,
              urgency: 'high',
              timeout: 5000,
              agent: this.agent
            })
            .catch(async (error: webpush.WebPushError) => {
              if (error.statusCode === 404 || error.statusCode === 410) {
                await this.mutate((state) => ({
                  ...state,
                  subscriptions: state.subscriptions.filter(
                    (candidate) => candidate !== record
                  )
                }))
              } else {
                // Do not log endpoints, encryption keys, or provider response bodies.
                console.warn('[Treeport] Web Push delivery failed', {
                  status: error.statusCode ?? null
                })
              }
            })
        })
      )
    }
  }

  private mutate(update: (state: PushState) => PushState): Promise<void> {
    const write = this.writes.then(async () => {
      const state = update(this.state)
      await this.persist(state)
      this.state = state
    })
    this.writes = write.catch(() => {})
    return write
  }

  private async persist(state: PushState): Promise<void> {
    await fs.mkdir(path.dirname(this.filename), {
      recursive: true,
      mode: 0o700
    })
    const temporary = `${this.filename}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(temporary, JSON.stringify(state), {
      mode: 0o600,
      flag: 'wx'
    })
    await fs.rename(temporary, this.filename).catch(async (error: Error) => {
      await fs.rm(temporary, { force: true })
      throw error
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.agent.destroy()
    await this.writes
  }
}
