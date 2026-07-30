import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ComputerSummary, SavedComputer } from './desktop-contract.js'
import { isLoopbackUrl, parseComputerUrl } from './renderer-url.js'

interface DesktopSettings {
  version: 1
  selectedComputerId?: string
  computers: SavedComputer[]
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function parseSettings(value: unknown): DesktopSettings | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('computers' in value) ||
    !Array.isArray(value.computers)
  ) {
    return null
  }

  const selectedComputerId =
    'selectedComputerId' in value ? value.selectedComputerId : undefined
  if (!isOptionalString(selectedComputerId)) {
    return null
  }

  const computers: SavedComputer[] = []
  const origins = new Set<string>()
  const ids = new Set<string>()
  for (const candidate of value.computers) {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      !('id' in candidate) ||
      typeof candidate.id !== 'string' ||
      !('origin' in candidate) ||
      typeof candidate.origin !== 'string' ||
      !('createdAt' in candidate) ||
      typeof candidate.createdAt !== 'string'
    ) {
      return null
    }

    const nameOverride =
      'nameOverride' in candidate ? candidate.nameOverride : undefined
    const advertisedHostname =
      'advertisedHostname' in candidate
        ? candidate.advertisedHostname
        : undefined
    const lastSelectedAt =
      'lastSelectedAt' in candidate ? candidate.lastSelectedAt : undefined
    if (
      !isOptionalString(nameOverride) ||
      !isOptionalString(advertisedHostname) ||
      !isOptionalString(lastSelectedAt)
    ) {
      return null
    }

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
      ...(nameOverride?.trim() ? { nameOverride: nameOverride.trim() } : {}),
      ...(advertisedHostname?.trim()
        ? { advertisedHostname: advertisedHostname.trim() }
        : {}),
      ...(lastSelectedAt ? { lastSelectedAt } : {})
    })
  }

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

  private constructor(
    private readonly filePath: string,
    settings: DesktopSettings
  ) {
    this.settings = settings
  }

  static async load(
    filePath: string,
    seedOrigin: string
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
        return new ComputerStore(filePath, parsed)
      }

      const invalidPath = `${filePath}.invalid-${Date.now()}`
      await fs.rename(filePath, invalidPath).catch(() => undefined)
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
  }

  async select(id: string): Promise<boolean> {
    const computer = this.getComputer(id)
    if (!computer) {
      return false
    }

    computer.lastSelectedAt = new Date().toISOString()
    this.settings.selectedComputerId = id
    await this.persist()
    return true
  }

  async update(
    id: string,
    input: { origin: string; nameOverride?: string }
  ): Promise<{ computer: SavedComputer; originChanged: boolean } | null> {
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
  }

  async rememberHostname(id: string, hostname: string): Promise<void> {
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
  }

  async remove(id: string): Promise<{ selectedChanged: boolean }> {
    const wasSelected = this.settings.selectedComputerId === id
    this.settings.computers = this.settings.computers.filter(
      (computer) => computer.id !== id
    )
    if (wasSelected) {
      const local = this.settings.computers
        .filter((computer) => isLoopbackUrl(new URL(computer.origin)))
        .sort((left, right) =>
          (right.lastSelectedAt ?? '').localeCompare(left.lastSelectedAt ?? '')
        )[0]
      const replacement =
        local ??
        [...this.settings.computers].sort((left, right) =>
          (right.lastSelectedAt ?? '').localeCompare(left.lastSelectedAt ?? '')
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
  }
}
