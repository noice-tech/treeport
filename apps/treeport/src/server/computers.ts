import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as Schema from 'effect/Schema'
import {
  COMPUTER_LIMIT,
  computerEntrySchema,
  computerExchangeSchema,
  computerIdSchema,
  type ComputerEntry,
  type ComputerExchange
} from '#protocol/computer'
import type { ViewerIdentity } from '#protocol/presence'
import { DomainError } from './core/index.ts'
import { tailscaleSelf, tailscaleServeUrl } from './tailscale.ts'

const EXCHANGE_TIMEOUT_MS = 5_000
const IDENTITY_TTL_MS = 60_000
const UNSEEN_HIDDEN_AFTER_MS = 30 * 24 * 60 * 60_000

const stateSchema = Schema.Struct({
  id: computerIdSchema,
  computers: Schema.Array(computerEntrySchema)
})

type ComputerState = Schema.Schema.Type<typeof stateSchema>

interface SelfIdentity {
  name: string
  url: string | null
  ownerLogin: string | null
}

export class ComputerDirectory {
  private writes: Promise<void> = Promise.resolve()
  private identity: { value: SelfIdentity; expiresAt: number } | null = null
  private readonly exchanging = new Set<string>()
  private disposed = false
  private readonly filename: string
  private state: ComputerState
  private readonly options: {
    port: number
    remoteUrl: string | null
    fallbackName: string
  }

  private constructor(
    filename: string,
    state: ComputerState,
    options: { port: number; remoteUrl: string | null; fallbackName: string }
  ) {
    this.filename = filename
    this.state = state
    this.options = options
  }

  static async open(options: {
    dataDir: string
    port: number
    remoteUrl: string | null
    fallbackName: string
  }): Promise<ComputerDirectory> {
    const filename = path.join(options.dataDir, 'computers.json')

    const saved = await fs
      .readFile(filename, 'utf8')
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return null
        }

        throw error
      })

    const state =
      saved === null
        ? {
            id: `cmp_${crypto.randomBytes(16).toString('hex')}`,
            computers: []
          }
        : Schema.decodeUnknownSync(stateSchema)(JSON.parse(saved))

    const directory = new ComputerDirectory(filename, state, options)

    if (saved === null) {
      await directory.persist(state)
    }

    return directory
  }

  get id(): string {
    return this.state.id
  }

  async self(): Promise<SelfIdentity> {
    if (this.identity && this.identity.expiresAt > Date.now()) {
      return this.identity.value
    }

    const [tailscale, serve] = await Promise.all([
      tailscaleSelf(),
      this.options.remoteUrl
        ? { installed: true, url: this.options.remoteUrl }
        : tailscaleServeUrl(this.options.port)
    ])

    const value = {
      name: tailscale?.name || this.options.fallbackName,
      url: serve.url ? new URL(serve.url).origin : null,
      ownerLogin: tailscale?.ownerLogin ?? null
    }

    this.identity = { value, expiresAt: Date.now() + IDENTITY_TTL_MS }

    return value
  }

  async authorize(identity: ViewerIdentity | undefined): Promise<void> {
    if (identity?.source === 'local') {
      return
    }

    const self = await this.self()

    if (
      identity?.source !== 'tailscale' ||
      self.ownerLogin === null ||
      identity.login !== self.ownerLogin
    ) {
      throw new DomainError(
        'COMPUTER_OWNER_REQUIRED',
        'Only the owner of this computer can manage its computer list',
        403
      )
    }
  }

  list(): ComputerEntry[] {
    const visibleAfter = Date.now() - UNSEEN_HIDDEN_AFTER_MS

    return this.state.computers
      .filter((entry) => !entry.removed && entry.seenAt >= visibleAfter)
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async receive(incoming: ComputerExchange): Promise<ComputerExchange> {
    const learned = await this.merge(incoming, incoming.self?.id ?? null)
    this.spread(learned)

    return this.outgoing()
  }

  async add(url: string, restoreForgotten: boolean): Promise<ComputerEntry> {
    const existing = this.state.computers.find((entry) => entry.url === url)

    if (existing && !restoreForgotten) {
      return existing
    }

    const self = await this.outgoing()

    if (self.self?.url === url) {
      throw new DomainError(
        'COMPUTER_IS_SELF',
        'That URL is this computer',
        400
      )
    }

    const response = await this.contact(url, self)

    if (!response.self) {
      throw new DomainError(
        'COMPUTER_UNREACHABLE',
        `${url} answered, but isn't reachable through Tailscale Serve`,
        502
      )
    }

    const added = restoreForgotten
      ? { ...response.self, removed: false, changedAt: Date.now() }
      : response.self

    const learned = await this.merge(
      { self: added, computers: response.computers },
      added.id
    )

    this.spread(learned)

    return added
  }

  async forget(id: string): Promise<void> {
    const existing = this.state.computers.find((entry) => entry.id === id)

    if (!existing || existing.removed) {
      throw new DomainError(
        'COMPUTER_NOT_FOUND',
        'This computer is not in the list',
        404
      )
    }

    await this.mutate((state) => ({
      ...state,
      computers: state.computers.map((entry) =>
        entry.id === id
          ? { ...entry, removed: true, changedAt: Date.now() }
          : entry
      )
    }))

    this.spread(this.list().map((entry) => entry.id))
  }

  announce(): void {
    this.spread(this.list().map((entry) => entry.id))
  }

  private spread(ids: readonly string[]): void {
    for (const id of ids) {
      const entry = this.state.computers.find(
        (candidate) => candidate.id === id
      )

      if (!entry || entry.removed || this.exchanging.has(id) || this.disposed) {
        continue
      }

      this.exchanging.add(id)
      void this.outgoing()
        .then((outgoing) => this.contact(entry.url, outgoing))
        .then(async (response) => {
          if (response.self?.id !== id) {
            return
          }

          this.spread(await this.merge(response, id))
        })
        .catch((error: Error) => {
          console.warn('[Treeport] Computer exchange failed', {
            computer: entry.name,
            error: error.message
          })
        })
        .finally(() => {
          this.exchanging.delete(id)
        })
    }
  }

  private async contact(
    url: string,
    outgoing: ComputerExchange
  ): Promise<ComputerExchange> {
    const response = await fetch(`${url}/api/computers/exchange`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify(outgoing),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)
    }).catch((error: Error) => {
      throw new DomainError(
        'COMPUTER_UNREACHABLE',
        `Cannot reach Treeport at ${url}: ${error.message}`,
        502
      )
    })

    if (!response.ok) {
      throw new DomainError(
        'COMPUTER_REFUSED',
        `Treeport at ${url} refused the exchange (HTTP ${response.status})`,
        502
      )
    }

    const body: unknown = await response.json().catch(() => null)

    return Schema.decodeUnknownSync(computerExchangeSchema)(body)
  }

  private async outgoing(): Promise<ComputerExchange> {
    const self = await this.self()

    return {
      self: self.url
        ? {
            id: this.state.id,
            name: self.name,
            url: self.url,
            seenAt: Date.now(),
            removed: false,
            changedAt: 0
          }
        : null,
      computers: this.state.computers
    }
  }

  private async merge(
    incoming: ComputerExchange,
    reached: string | null
  ): Promise<string[]> {
    const learned: string[] = []

    await this.mutate((state) => {
      const computers = new Map(
        state.computers.map((entry) => [entry.id, entry])
      )

      const entries = incoming.self
        ? [
            {
              ...incoming.self,
              seenAt: Date.now()
            },
            ...incoming.computers
          ]
        : incoming.computers

      for (const entry of entries) {
        if (entry.id === state.id) {
          continue
        }

        const current = computers.get(entry.id)

        if (!current) {
          if (computers.size >= COMPUTER_LIMIT) {
            continue
          }

          computers.set(entry.id, entry)

          if (!entry.removed && entry.id !== reached) {
            learned.push(entry.id)
          }

          continue
        }

        const newer = entry.seenAt > current.seenAt ? entry : current
        const membership = entry.changedAt > current.changedAt ? entry : current

        computers.set(entry.id, {
          id: entry.id,
          name: newer.name,
          url: newer.url,
          seenAt: newer.seenAt,
          removed: membership.removed,
          changedAt: membership.changedAt
        })
      }

      return { ...state, computers: [...computers.values()] }
    })

    return learned
  }

  private mutate(
    update: (state: ComputerState) => ComputerState
  ): Promise<void> {
    const write = this.writes.then(async () => {
      const state = update(this.state)
      await this.persist(state)
      this.state = state
    })

    this.writes = write.catch(() => {})

    return write
  }

  private async persist(state: ComputerState): Promise<void> {
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
    await this.writes
  }
}
