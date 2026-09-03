import * as Effect from 'effect/Effect'
import { describe, expect, it, vi } from 'vitest'
import {
  parseTerminalServerEvent,
  TERMINAL_OUTPUT_HIGH_WATERMARK,
  TERMINAL_OUTPUT_MAX_UNACKNOWLEDGED_BYTES,
  type TerminalServerEvent,
  type TerminalServerEventPayloads,
  type TerminalServerPayload
} from '@treeport/shared'
import type { TreeportService } from './core/index'
import { TerminalAttachmentManager } from './terminal-attachments'
import type { TerminalAttachmentBackend } from './terminal-host-sessions'
import type { TerminalMetadataManager } from './terminal-metadata'
import { testAccess } from './test-access'

class HostDouble implements TerminalAttachmentBackend {
  readonly outputListeners = new Set<(data: string, sequence: number) => void>()
  readonly runtimeListeners = new Set<(event: never) => void>()
  readonly writes: Array<{
    data: string | Buffer
    authority: { attachmentId: string; generation: number }
  }> = []
  readonly activations: Array<{
    transitionId: string
    attachmentId: string
    generation: number
  }> = []
  readonly resizes: Array<{ cols: number; rows: number }> = []
  hostAuthorityCount = 0
  transitionSerial = 0
  snapshotFence = 0
  snapshotData = 'canonical snapshot'
  snapshotGate: Promise<void> | null = null
  writeError: Error | null = null

  async attach(
    _terminalId: string,
    listener: (data: string, sequence: number) => void
  ) {
    this.outputListeners.add(listener)
    await this.snapshotGate
    return {
      data: this.snapshotData,
      links: [],
      fence: this.snapshotFence,
      cols: 100,
      rows: 30,
      unsubscribe: () => this.outputListeners.delete(listener)
    }
  }

  subscribeRuntime() {
    return () => undefined
  }

  terminalTitleState() {
    return Promise.resolve(null)
  }

  runtimeState() {
    return Promise.resolve({
      title: null,
      status: 'running' as const,
      progress: null,
      bell: null
    })
  }

  async write(
    _terminalId: string,
    data: string | Buffer,
    authority: { attachmentId: string; generation: number }
  ): Promise<void> {
    if (this.writeError) {
      throw this.writeError
    }

    this.writes.push({ data, authority })
  }

  prepareQueryAuthority() {
    this.transitionSerial += 1
    return Promise.resolve({
      transitionId: `transition-${this.transitionSerial}`,
      fence: this.snapshotFence
    })
  }

  activateQueryAuthority(
    _terminalId: string,
    transitionId: string,
    attachmentId: string,
    generation: number
  ) {
    this.activations.push({ transitionId, attachmentId, generation })
    return Promise.resolve()
  }

  useHostQueryAuthority() {
    this.hostAuthorityCount += 1
    return Promise.resolve()
  }

  resize(_terminalId: string, cols: number, rows: number) {
    this.resizes.push({ cols, rows })
    return Promise.resolve()
  }

  dispose() {}

  emit(data: string, sequence: number): void {
    for (const listener of [...this.outputListeners]) {
      listener(data, sequence)
    }
  }
}

class TransportDouble {
  connected = true
  readonly sent: Array<{
    event: TerminalServerEvent
    payload: TerminalServerPayload
  }> = []
  readonly disconnects: boolean[] = []
  onSend:
    | ((event: TerminalServerEvent, payload: TerminalServerPayload) => void)
    | null = null

  constructor(readonly id: string) {}

  isConnected = () => this.connected

  send = (event: TerminalServerEvent, payload: TerminalServerPayload) => {
    if (!this.connected) {
      return false
    }

    this.sent.push({ event, payload })
    this.onSend?.(event, payload)
    return true
  }

  disconnect = (retryable: boolean) => {
    this.disconnects.push(retryable)
    this.connected = false
  }
}

function fixture() {
  const host = new HostDouble()
  const refreshTerminalStatus = vi.fn(async () => ({
    id: 'terminal',
    worktreeId: 'worktree',
    name: 'Shell',
    argv: ['/bin/sh'],
    shellCommand: null,
    interactiveShell: true,
    status: 'running',
    exitCode: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }))
  const getWorktree = vi.fn(async () => ({
    id: 'worktree',
    path: '/tmp'
  }))
  // SAFETY: This fixture supplies the service methods exercised by attachments.
  const service = testAccess<TreeportService>({
    refreshTerminalStatus,
    terminals: { refreshTerminalStatus },
    getWorktree,
    projects: { getWorktree },
    runEffect: vi.fn((effect) =>
      Effect.isEffect(effect)
        ? Effect.runPromise(effect as Effect.Effect<unknown, unknown, never>)
        : effect
    ),
    terminalAttachmentMutation: vi.fn((_terminalId, effect) => effect),
    events: { publish: vi.fn() }
  })
  const metadataValue = {
    terminalId: 'terminal',
    title: null,
    program: null,
    progress: null,
    progressStartedAt: null,
    progressClearedAt: null,
    bell: null
  }
  // SAFETY: This fixture supplies the metadata methods exercised by attachments.
  const metadata = testAccess<TerminalMetadataManager>({
    trackTerminal: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
    get: vi.fn(() => metadataValue)
  })
  return {
    host,
    manager: new TerminalAttachmentManager(service, metadata, host)
  }
}

async function waitForEvent(
  transport: TransportDouble,
  event: TerminalServerEvent,
  count = 1
): Promise<void> {
  await vi.waitFor(() =>
    expect(transport.sent.filter((item) => item.event === event)).toHaveLength(
      count
    )
  )
}

function eventPayloads<Event extends TerminalServerEvent>(
  transport: TransportDouble,
  event: Event
): TerminalServerEventPayloads[Event][] {
  return transport.sent
    .filter((item) => item.event === event)
    .map((item) => {
      const payload = parseTerminalServerEvent(event, item.payload)
      if (!payload) {
        throw new Error(`Invalid ${event} payload in test transport`)
      }

      return payload
    })
}

function readyPayload(transport: TransportDouble) {
  const ready = eventPayloads(transport, 'ready')[0]
  if (!ready) {
    throw new Error('Ready event was not sent')
  }

  return ready
}

async function activateAuthority(
  manager: TerminalAttachmentManager,
  connectionId: string,
  transport: TransportDouble,
  generation: number
): Promise<void> {
  manager.message(connectionId, 'query_authority', {
    generation,
    transitionId: null
  })
  await waitForEvent(transport, 'query_authority', 1)
  const transition = eventPayloads(transport, 'query_authority').find(
    (item) => item.transitionId !== null
  )
  if (!transition?.transitionId) {
    throw new Error('Query authority transition was not sent')
  }

  manager.message(connectionId, 'query_authority', {
    generation,
    transitionId: transition.transitionId
  })
  await waitForEvent(transport, 'query_authority', 2)
  manager.message(connectionId, 'query_authority', {
    generation,
    transitionId: transition.transitionId
  })
  await waitForEvent(transport, 'query_authority', 3)
}

describe('TerminalAttachmentManager', () => {
  it('fences a canonical snapshot before exactly the concurrent live suffix', async () => {
    const { host, manager } = fixture()
    let releaseSnapshot!: () => void
    host.snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve
    })
    host.snapshotFence = 4
    const transport = new TransportDouble('viewer')
    const connectionId = manager.accept(
      { terminalId: 'terminal', clientId: 'client', cols: 100, rows: 30 },
      transport
    )
    await vi.waitFor(() => expect(host.outputListeners.size).toBe(1))

    const concurrentSuffix = 'x'.repeat(TERMINAL_OUTPUT_HIGH_WATERMARK + 1)
    host.emit('already represented', 4)
    releaseSnapshot()
    host.emit(concurrentSuffix, 5)
    await waitForEvent(transport, 'ready')
    await waitForEvent(transport, 'output')

    expect(readyPayload(transport).snapshot).toBe('canonical snapshot')
    const output = eventPayloads(transport, 'output')
    expect(output.map((item) => item.data)).toEqual([concurrentSuffix])
    expect(transport.connected).toBe(true)
    manager.message(connectionId, 'resize', {
      generation: readyPayload(transport).generation,
      cols: 120,
      rows: 40
    })
    await vi.waitFor(() =>
      expect(host.resizes).toEqual([{ cols: 120, rows: 40 }])
    )
    expect(transport.connected).toBe(true)

    manager.message(connectionId, 'output_ack', {
      streamId: output[0]!.streamId,
      sequence: output[0]!.sequence
    })
    manager.dispose()
  })

  it('disconnects a slow viewer without pausing output to another viewer', async () => {
    const { host, manager } = fixture()
    const slow = new TransportDouble('slow')
    const fast = new TransportDouble('fast')
    const slowId = manager.accept(
      { terminalId: 'terminal', clientId: 'slow-client', cols: 100, rows: 30 },
      slow
    )
    const fastId = manager.accept(
      { terminalId: 'terminal', clientId: 'fast-client', cols: 100, rows: 30 },
      fast
    )
    await Promise.all([
      waitForEvent(slow, 'ready'),
      waitForEvent(fast, 'ready')
    ])
    fast.onSend = (event, payload) => {
      if (event === 'output') {
        const output = parseTerminalServerEvent('output', payload)
        if (!output) {
          throw new Error('Invalid output payload in test transport')
        }

        manager.message(fastId, 'output_ack', {
          streamId: output.streamId,
          sequence: output.sequence
        })
      }
    }

    const transientChunk = 'x'.repeat(TERMINAL_OUTPUT_HIGH_WATERMARK / 2)
    host.emit(transientChunk, 1)
    host.emit(transientChunk, 2)
    expect(slow.connected).toBe(true)
    const transientOutput = eventPayloads(slow, 'output').at(-1)!
    manager.message(slowId, 'output_ack', {
      streamId: transientOutput.streamId,
      sequence: transientOutput.sequence
    })

    const stalledChunk = 'x'.repeat(
      TERMINAL_OUTPUT_MAX_UNACKNOWLEDGED_BYTES / 2
    )
    host.emit(stalledChunk, 3)
    host.emit(stalledChunk, 4)
    await vi.waitFor(() => expect(slow.disconnects).toEqual([true]))
    expect(fast.connected).toBe(true)

    host.emit('still live', 5)
    await vi.waitFor(() =>
      expect(
        eventPayloads(fast, 'output').some((item) => item.data === 'still live')
      ).toBe(true)
    )
    expect(host.outputListeners.size).toBe(1)
    manager.close(slowId)
    manager.dispose()
  })

  it('reports an asynchronous terminal-host write failure and disconnects the controller', async () => {
    const { host, manager } = fixture()
    const transport = new TransportDouble('controller')
    const connectionId = manager.accept(
      { terminalId: 'terminal', clientId: 'client', cols: 100, rows: 30 },
      transport
    )
    await waitForEvent(transport, 'ready')
    const generation = readyPayload(transport).generation
    await activateAuthority(manager, connectionId, transport, generation)

    host.writeError = new Error('terminal host write failed')
    manager.message(connectionId, 'input', { generation, data: 'input' })

    await waitForEvent(transport, 'terminal_error')
    expect(eventPayloads(transport, 'terminal_error')).toContainEqual({
      code: 'INPUT_FAILED',
      message: 'terminal host write failed',
      retryable: true
    })
    expect(transport.disconnects).toEqual([true])
    manager.dispose()
  })

  it('hands query authority between controllers behind parser fences', async () => {
    const { host, manager } = fixture()
    const first = new TransportDouble('first')
    const firstId = manager.accept(
      { terminalId: 'terminal', clientId: 'client-a', cols: 100, rows: 30 },
      first
    )
    await waitForEvent(first, 'ready')
    const firstGeneration = readyPayload(first).generation

    manager.message(firstId, 'input', {
      generation: firstGeneration,
      data: 'blocked-before-authority'
    })
    expect(host.writes).toEqual([])
    await activateAuthority(manager, firstId, first, firstGeneration)
    manager.message(firstId, 'input', {
      generation: firstGeneration,
      data: 'first input'
    })
    await vi.waitFor(() => expect(host.writes).toHaveLength(1))

    const second = new TransportDouble('second')
    const secondId = manager.accept(
      { terminalId: 'terminal', clientId: 'client-b', cols: 100, rows: 30 },
      second
    )
    await waitForEvent(second, 'ready')
    manager.message(secondId, 'take_control', {
      generation: firstGeneration,
      cols: 100,
      rows: 30
    })
    await vi.waitFor(() =>
      expect(
        second.sent.filter((item) => item.event === 'control').at(-1)?.payload
      ).toMatchObject({ controller: true })
    )
    const secondControl = eventPayloads(second, 'control').at(-1)
    if (!secondControl) {
      throw new Error('Second controller state was not sent')
    }

    const secondGeneration = secondControl.generation
    await activateAuthority(manager, secondId, second, secondGeneration)
    manager.message(secondId, 'input', {
      generation: secondGeneration,
      data: 'second input'
    })
    await vi.waitFor(() => expect(host.writes).toHaveLength(2))

    expect(host.writes.map((item) => item.data)).toEqual([
      'first input',
      'second input'
    ])
    expect(host.activations).toHaveLength(2)
    expect(host.hostAuthorityCount).toBeGreaterThanOrEqual(1)
    manager.dispose()
  })
})
