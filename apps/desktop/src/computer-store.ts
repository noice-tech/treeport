import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as Effect from 'effect/Effect'
import { z } from 'zod'
import type { ComputerSummary, SavedComputer } from './desktop-contract'
import { isLoopbackUrl, parseComputerUrl } from './renderer-url'

const desktopSettingsSchema = z.object({
  version: z.literal(1),
  selectedComputerId: z.string().optional(),
  computers: z.array(
    z.object({
      id: z.string(),
      origin: z.string(),
      nameOverride: z.string().optional(),
      advertisedHostname: z.string().optional(),
      createdAt: z.string(),
      lastSelectedAt: z.string().optional()
    })
  )
})

interface DesktopSettings {
  version: 1
  selectedComputerId?: string
  computers: SavedComputer[]
}

interface ComputerUpdateInput {
  origin: string
  nameOverride?: string
}

const parseSettings = z.unknown().transform((value): DesktopSettings | null => {
  const result = desktopSettingsSchema.safeParse(value)
  if (!result.success) {
    return null
  }

  const computers: SavedComputer[] = []
  const origins = new Set<string>()
  const ids = new Set<string>()
  for (const candidate of result.data.computers) {
    let origin: string
    try {
      origin = parseComputerUrl(candidate.origin).origin
    } catch {
      return null
    }
    if (origins.has(origin) || ids.has(candidate.id)) {
      return null
    }

    origins.add(origin)
    ids.add(candidate.id)
    const computer: SavedComputer = {
      id: candidate.id,
      origin,
      createdAt: candidate.createdAt
    }
    if (candidate.nameOverride?.trim()) {
      computer.nameOverride = candidate.nameOverride.trim()
    }

    if (candidate.advertisedHostname?.trim()) {
      computer.advertisedHostname = candidate.advertisedHostname.trim()
    }

    if (candidate.lastSelectedAt) {
      computer.lastSelectedAt = candidate.lastSelectedAt
    }

    computers.push(computer)
  }
  const settings: DesktopSettings = { version: 1, computers }
  if (
    result.data.selectedComputerId &&
    ids.has(result.data.selectedComputerId)
  ) {
    settings.selectedComputerId = result.data.selectedComputerId
  }

  return settings
}).parse

export function computerName(computer: SavedComputer): string {
  if (computer.nameOverride) {
    return computer.nameOverride
  }

  const url = new URL(computer.origin)
  return isLoopbackUrl(url)
    ? 'This computer'
    : computer.advertisedHostname || url.hostname
}

export class ComputerStore {
  private readonly mutations = Effect.unsafeMakeSemaphore(1)

  private constructor(
    private readonly filePath: string,
    private settings: DesktopSettings
  ) {}

  static load(
    filePath: string,
    seedOrigin: string,
    options: { synchronizeSelectedLoopback?: boolean } = {}
  ) {
    return Effect.gen(function* () {
      const contents = yield* Effect.tryPromise(() =>
        fs.readFile(filePath, 'utf8')
      ).pipe(
        Effect.catchAll((error) => {
          const code = z.object({ code: z.string() }).safeParse(error.cause)
          return code.success && code.data.code === 'ENOENT'
            ? Effect.succeed(null)
            : Effect.fail(error)
        })
      )
      if (contents !== null) {
        const parsed = yield* Effect.try(() =>
          parseSettings(JSON.parse(contents))
        ).pipe(Effect.catchAll(() => Effect.succeed(null)))
        if (parsed) {
          const store = new ComputerStore(filePath, parsed)
          const selected = store.selectedComputer
          if (
            options.synchronizeSelectedLoopback &&
            selected &&
            isLoopbackUrl(new URL(selected.origin))
          ) {
            const { origin } = yield* Effect.try(() =>
              parseComputerUrl(seedOrigin)
            )
            if (selected.origin !== origin) {
              const existing = store.findByOrigin(origin, selected.id)
              if (existing) {
                yield* store.select(existing.id)
              } else {
                const update: ComputerUpdateInput = { origin }
                if (selected.nameOverride) {
                  update.nameOverride = selected.nameOverride
                }

                yield* store.update(selected.id, update)
              }
            }
          }

          return store
        }

        const invalidPath = `${filePath}.invalid-${Date.now()}`
        yield* Effect.tryPromise(() => fs.rename(filePath, invalidPath))
        yield* Effect.logError(
          `Invalid desktop settings moved to ${invalidPath}`
        )
      }

      const { origin } = yield* Effect.try(() => parseComputerUrl(seedOrigin))
      const now = new Date().toISOString()
      const computer: SavedComputer = {
        id: crypto.randomUUID(),
        origin,
        createdAt: now,
        lastSelectedAt: now
      }
      const store = new ComputerStore(filePath, {
        version: 1,
        selectedComputerId: computer.id,
        computers: [computer]
      })
      yield* store.persist(store.settings)
      return store
    })
  }

  private persist(settings: DesktopSettings) {
    return Effect.gen(this, function* () {
      yield* Effect.tryPromise(() =>
        fs.mkdir(path.dirname(this.filePath), { recursive: true })
      )
      const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
      yield* Effect.tryPromise(() =>
        fs.writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
          mode: 0o600
        })
      ).pipe(
        Effect.zipRight(
          Effect.tryPromise(() => fs.rename(temporaryPath, this.filePath))
        ),
        Effect.onError(() =>
          Effect.tryPromise(() => fs.rm(temporaryPath, { force: true })).pipe(
            Effect.catchAll((error) =>
              Effect.logError(
                'Could not remove temporary desktop settings',
                error
              )
            )
          )
        )
      )
    }).pipe(Effect.uninterruptible)
  }

  // Waiters are interruptible. Once admitted, commit the file before publishing
  // the draft in memory, even during shutdown. Failed writes never leak state.
  private mutate<A>(mutation: (draft: DesktopSettings) => A) {
    return this.mutations.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(this, function* () {
          const draft = structuredClone(this.settings)
          const result = yield* Effect.try(() => mutation(draft))
          yield* this.persist(draft)
          this.settings = draft
          return result
        })
      )
    )
  }

  get selectedComputer(): SavedComputer | undefined {
    return this.getComputer(this.settings.selectedComputerId ?? '')
  }

  getComputer(id: string): SavedComputer | undefined {
    return this.settings.computers.find((computer) => computer.id === id)
  }

  summaries(): ComputerSummary[] {
    const selectedId = this.settings.selectedComputerId
    return [...this.settings.computers]
      .sort((left, right) => {
        const localDifference =
          Number(isLoopbackUrl(new URL(right.origin))) -
          Number(isLoopbackUrl(new URL(left.origin)))
        if (localDifference !== 0) {
          return localDifference
        }

        const recentDifference = (right.lastSelectedAt ?? '').localeCompare(
          left.lastSelectedAt ?? ''
        )
        return recentDifference || left.createdAt.localeCompare(right.createdAt)
      })
      .map((computer) => ({
        ...computer,
        name: computerName(computer),
        selected: computer.id === selectedId,
        loopback: isLoopbackUrl(new URL(computer.origin))
      }))
  }

  findByOrigin(origin: string, exceptId?: string): SavedComputer | undefined {
    return this.settings.computers.find(
      (computer) => computer.origin === origin && computer.id !== exceptId
    )
  }

  add(origin: string) {
    return this.mutate((draft) => {
      const normalizedOrigin = parseComputerUrl(origin).origin
      if (
        draft.computers.some((computer) => computer.origin === normalizedOrigin)
      ) {
        throw new Error('That computer is already saved.')
      }

      const now = new Date().toISOString()
      const computer: SavedComputer = {
        id: crypto.randomUUID(),
        origin: normalizedOrigin,
        createdAt: now,
        lastSelectedAt: now
      }
      draft.computers.push(computer)
      draft.selectedComputerId = computer.id
      return computer
    })
  }

  select(id: string) {
    return this.mutate((draft) => {
      const computer = draft.computers.find((candidate) => candidate.id === id)
      if (!computer) {
        return false
      }

      computer.lastSelectedAt = new Date().toISOString()
      draft.selectedComputerId = id
      return true
    })
  }

  update(id: string, input: ComputerUpdateInput) {
    return this.mutate((draft) => {
      const computer = draft.computers.find((candidate) => candidate.id === id)
      if (!computer) {
        return null
      }

      const origin = parseComputerUrl(input.origin).origin
      if (
        draft.computers.some(
          (candidate) => candidate.origin === origin && candidate.id !== id
        )
      ) {
        throw new Error('That computer is already saved.')
      }

      const originChanged = computer.origin !== origin
      computer.origin = origin
      const name = input.nameOverride?.trim()
      if (name) {
        computer.nameOverride = name
      } else {
        delete computer.nameOverride
      }

      if (originChanged) {
        delete computer.advertisedHostname
      }

      return { computer, originChanged }
    })
  }

  rememberHostname(id: string, hostname: string) {
    return Effect.suspend(() => {
      const computer = this.getComputer(id)
      const normalized = hostname.trim()
      if (
        !computer ||
        !normalized ||
        computer.advertisedHostname === normalized
      ) {
        return Effect.void
      }

      return this.mutate((draft) => {
        const candidate = draft.computers.find((value) => value.id === id)
        if (candidate) {
          candidate.advertisedHostname = normalized
        }
      })
    })
  }

  remove(id: string) {
    return this.mutate((draft) => {
      const wasSelected = draft.selectedComputerId === id
      draft.computers = draft.computers.filter((computer) => computer.id !== id)
      if (wasSelected) {
        const recent = [...draft.computers].sort((left, right) =>
          (right.lastSelectedAt ?? '').localeCompare(left.lastSelectedAt ?? '')
        )
        const replacement =
          recent.find((computer) => isLoopbackUrl(new URL(computer.origin))) ??
          recent[0]
        if (replacement) {
          replacement.lastSelectedAt = new Date().toISOString()
          draft.selectedComputerId = replacement.id
        } else {
          delete draft.selectedComputerId
        }
      }

      return { selectedChanged: wasSelected }
    })
  }
}
