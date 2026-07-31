import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
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

function parseSettings(value: unknown): DesktopSettings | null {
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
    computers.push({
      id: candidate.id,
      origin,
      createdAt: candidate.createdAt,
      ...(candidate.nameOverride?.trim()
        ? { nameOverride: candidate.nameOverride.trim() }
        : {}),
      ...(candidate.advertisedHostname?.trim()
        ? { advertisedHostname: candidate.advertisedHostname.trim() }
        : {}),
      ...(candidate.lastSelectedAt
        ? { lastSelectedAt: candidate.lastSelectedAt }
        : {})
    })
  }

  const { selectedComputerId } = result.data
  return {
    version: 1,
    computers,
    ...(selectedComputerId && ids.has(selectedComputerId)
      ? { selectedComputerId }
      : {})
  }
}

export function computerName(computer: SavedComputer): string {
  if (computer.nameOverride) {
    return computer.nameOverride
  }

  const url = new URL(computer.origin)
  if (isLoopbackUrl(url)) {
    return 'This computer'
  }

  return computer.advertisedHostname || url.hostname
}

export class ComputerStore {
  private settings: DesktopSettings
  private mutationQueue: Promise<void> = Promise.resolve()

  private constructor(
    private readonly filePath: string,
    settings: DesktopSettings
  ) {
    this.settings = settings
  }

  static async load(
    filePath: string,
    seedOrigin: string,
    options: { synchronizeSelectedLoopback?: boolean } = {}
  ): Promise<ComputerStore> {
    const contents = await fs
      .readFile(filePath, 'utf8')
      .catch((error: unknown) => {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          return null
        }

        throw error
      })

    if (contents !== null) {
      const parsed = await Promise.resolve()
        .then(() => JSON.parse(contents) as unknown)
        .then(parseSettings)
        .catch(() => null)
      if (parsed) {
        const store = new ComputerStore(filePath, parsed)
        const selected = store.selectedComputer
        if (
          options.synchronizeSelectedLoopback &&
          selected &&
          isLoopbackUrl(new URL(selected.origin))
        ) {
          const origin = parseComputerUrl(seedOrigin).origin
          if (selected.origin !== origin) {
            const existing = store.findByOrigin(origin, selected.id)
            if (existing) {
              await store.select(existing.id)
            } else {
              await store.update(selected.id, {
                origin,
                ...(selected.nameOverride
                  ? { nameOverride: selected.nameOverride }
                  : {})
              })
            }
          }
        }

        return store
      }

      const invalidPath = `${filePath}.invalid-${Date.now()}`
      await fs.rename(filePath, invalidPath)
      console.error(
        `[Treeport] Invalid desktop settings moved to ${invalidPath}`
      )
    }

    const origin = parseComputerUrl(seedOrigin).origin
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
    await store.persist()
    return store
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(this.settings, null, 2)}\n`,
      {
        mode: 0o600
      }
    )
    await fs.rename(temporaryPath, this.filePath)
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(() => {
      const previousSettings = structuredClone(this.settings)
      return mutation().then(
        (value) => value,
        (error: unknown) => {
          this.settings = previousSettings
          throw error
        }
      )
    })
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  get selectedComputer(): SavedComputer | undefined {
    return this.settings.computers.find(
      (computer) => computer.id === this.settings.selectedComputerId
    )
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

  async add(origin: string): Promise<SavedComputer> {
    return this.enqueueMutation(async () => {
      const normalizedOrigin = parseComputerUrl(origin).origin
      if (this.findByOrigin(normalizedOrigin)) {
        throw new Error('That computer is already saved.')
      }

      const now = new Date().toISOString()
      const computer: SavedComputer = {
        id: crypto.randomUUID(),
        origin: normalizedOrigin,
        createdAt: now,
        lastSelectedAt: now
      }
      this.settings.computers.push(computer)
      this.settings.selectedComputerId = computer.id
      await this.persist()
      return computer
    })
  }

  async select(id: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      const computer = this.getComputer(id)
      if (!computer) {
        return false
      }

      computer.lastSelectedAt = new Date().toISOString()
      this.settings.selectedComputerId = id
      await this.persist()
      return true
    })
  }

  async update(
    id: string,
    input: { origin: string; nameOverride?: string }
  ): Promise<{ computer: SavedComputer; originChanged: boolean } | null> {
    return this.enqueueMutation(async () => {
      const computer = this.getComputer(id)
      if (!computer) {
        return null
      }

      const origin = parseComputerUrl(input.origin).origin
      if (this.findByOrigin(origin, id)) {
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

      await this.persist()
      return { computer, originChanged }
    })
  }

  async rememberHostname(id: string, hostname: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const computer = this.getComputer(id)
      const normalized = hostname.trim()
      if (
        !computer ||
        !normalized ||
        computer.advertisedHostname === normalized
      ) {
        return
      }

      computer.advertisedHostname = normalized
      await this.persist()
    })
  }

  async remove(id: string): Promise<{ selectedChanged: boolean }> {
    return this.enqueueMutation(async () => {
      const wasSelected = this.settings.selectedComputerId === id
      this.settings.computers = this.settings.computers.filter(
        (computer) => computer.id !== id
      )
      if (wasSelected) {
        const local = this.settings.computers
          .filter((computer) => isLoopbackUrl(new URL(computer.origin)))
          .sort((left, right) =>
            (right.lastSelectedAt ?? '').localeCompare(
              left.lastSelectedAt ?? ''
            )
          )[0]
        const replacement =
          local ??
          [...this.settings.computers].sort((left, right) =>
            (right.lastSelectedAt ?? '').localeCompare(
              left.lastSelectedAt ?? ''
            )
          )[0]
        if (replacement) {
          replacement.lastSelectedAt = new Date().toISOString()
          this.settings.selectedComputerId = replacement.id
        } else {
          delete this.settings.selectedComputerId
        }
      }

      await this.persist()
      return { selectedChanged: wasSelected }
    })
  }
}
