import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import xtermHeadless from '@xterm/headless'
import { describe, expect, it, vi } from 'vitest'
import {
  TerminalMetadataParser,
  TmuxProgressObserver,
  type TerminalMetadataUpdate
} from './tmux-progress.js'

const { Terminal } = xtermHeadless
// Fixed by @xterm/headless 5.5's public string-handler implementation.
const XTERM_OSC_PAYLOAD_LIMIT = 10_000_000
const bytes = (value: string) => Buffer.from(value, 'binary')

async function metadata(
  chunks: Uint8Array[]
): Promise<TerminalMetadataUpdate[]> {
  const updates: TerminalMetadataUpdate[] = []
  const parser = new TerminalMetadataParser((update) => updates.push(update))
  await Promise.all(chunks.map((chunk) => parser.push(chunk)))
  parser.dispose()
  return updates
}

describe('TerminalMetadataParser', () => {
  it('extracts OSC 0/2 UTF-8 titles and OSC 9;4 progress', async () => {
    await expect(
      metadata([
        Buffer.from(
          '\x1b]0;shell\x07\x1b]2;Pi · /repo\x1b\\\x1b]9;4;1;42\x1b\\'
        )
      ])
    ).resolves.toEqual([
      { type: 'title', title: 'shell' },
      { type: 'title', title: 'Pi · /repo' },
      { type: 'progress', progress: { state: 'normal', value: 42 } }
    ])
  })

  it('decodes fragmented UTF-8 titles across every byte split without false bells', async () => {
    const title = '✓ #6 — Fix title parsing'
    const sequence = Buffer.from(`\x1b]0;${title}\x07`)
    const chunkings: Uint8Array[][] = [
      [...sequence.keys()].map((index) => sequence.subarray(index, index + 1)),
      ...Array.from({ length: sequence.length - 1 }, (_, index) => [
        sequence.subarray(0, index + 1),
        sequence.subarray(index + 1)
      ])
    ]

    for (const chunks of chunkings) {
      await expect(metadata(chunks)).resolves.toEqual([
        { type: 'title', title }
      ])
    }
  })

  it('extracts real BEL without treating OSC terminators as bells', async () => {
    await expect(
      metadata([bytes('before\x07\x1b]2;Pi\x07\x1b]9;4;3\x07after\x07')])
    ).resolves.toEqual([
      { type: 'bell' },
      { type: 'title', title: 'Pi' },
      { type: 'progress', progress: { state: 'indeterminate', value: null } },
      { type: 'bell' }
    ])
  })

  it('accepts BEL, 7-bit ST, and UTF-8 C1 OSC/ST sequences', async () => {
    await expect(
      metadata([
        bytes('before\x1b]9;4;3\x07after'),
        bytes('\x1b]9;4;1;42\x1b\\'),
        Buffer.from('\u009d9;4;2;100\u009c'),
        bytes('\x1b]9;4;0\x07')
      ])
    ).resolves.toEqual([
      { type: 'progress', progress: { state: 'indeterminate', value: null } },
      { type: 'progress', progress: { state: 'normal', value: 42 } },
      { type: 'progress', progress: { state: 'error', value: 100 } },
      { type: 'progress', progress: null }
    ])
  })

  it('does not treat a UTF-8 continuation byte as C1 OSC', async () => {
    await expect(metadata([Buffer.from('Ý9;4;3\x07')])).resolves.toEqual([
      { type: 'bell' }
    ])
  })

  it('preserves UTF-8 C1 OSC/ST across every byte split', async () => {
    const sequence = Buffer.from('\u009d9;4;3\u009c')
    for (let split = 1; split < sequence.length; split += 1) {
      await expect(
        metadata([sequence.subarray(0, split), sequence.subarray(split)])
      ).resolves.toEqual([
        {
          type: 'progress',
          progress: { state: 'indeterminate', value: null }
        }
      ])
    }
  })

  it('preserves OSC parser state across arbitrary chunks', async () => {
    const sequence = bytes('text\x1b]9;4;4;7\x1b\\more')
    for (let split = 1; split < sequence.length; split += 1) {
      await expect(
        metadata([sequence.subarray(0, split), sequence.subarray(split)])
      ).resolves.toEqual([
        { type: 'progress', progress: { state: 'paused', value: 7 } }
      ])
    }
  })

  it('ignores unrelated and malformed progress payloads and then recovers', async () => {
    await expect(
      metadata([
        bytes(
          '\x1b]8;;https://example.test\x07\x1b]9;4;1;101\x07\x1b]9;invalid\x07\x1b]9;4;3\x07'
        )
      ])
    ).resolves.toEqual([
      { type: 'progress', progress: { state: 'indeterminate', value: null } }
    ])
  })

  it('holds an unterminated OSC across writes and recovers after termination', async () => {
    const updates: TerminalMetadataUpdate[] = []
    const parser = new TerminalMetadataParser((update) => updates.push(update))
    await parser.push(bytes('\x1b]9;incomplete'))
    expect(updates).toEqual([])

    await parser.push(bytes('\x07\x1b]9;4;3\x07'))
    parser.dispose()
    expect(updates).toEqual([
      { type: 'progress', progress: { state: 'indeterminate', value: null } }
    ])
  })

  it('recovers after xterm discards an oversized unterminated OSC payload', async () => {
    const oversized = Buffer.alloc(XTERM_OSC_PAYLOAD_LIMIT + 1, 0x78)
    await expect(
      metadata([
        Buffer.concat([bytes('\x1b]2;'), oversized, bytes('\x1b]9;4;3\x07')])
      ])
    ).resolves.toEqual([
      {
        type: 'progress',
        progress: { state: 'indeterminate', value: null }
      }
    ])
  }, 30_000)

  it('preserves multiple metadata updates in one write', async () => {
    await expect(
      metadata([bytes('\x1b]2;Pi\x07\x1b]9;4;3\x07\x07\x1b]9;4;0\x07')])
    ).resolves.toEqual([
      { type: 'title', title: 'Pi' },
      { type: 'progress', progress: { state: 'indeterminate', value: null } },
      { type: 'bell' },
      { type: 'progress', progress: null }
    ])
  })

  it('processes sustained plain output with scrollback disabled', async () => {
    const updates: TerminalMetadataUpdate[] = []
    const parser = new TerminalMetadataParser((update) => updates.push(update))
    const output = Buffer.from('sustained output\r\n'.repeat(4_096))
    await Promise.all(Array.from({ length: 64 }, () => parser.push(output)))
    await parser.push(bytes('\x1b]9;4;3\x07'))
    parser.dispose()

    expect(updates).toEqual([
      { type: 'progress', progress: { state: 'indeterminate', value: null } }
    ])
  })

  it('disposes the terminal and prevents queued or later updates', async () => {
    const disposeTerminal = vi.spyOn(Terminal.prototype, 'dispose')
    const updates: TerminalMetadataUpdate[] = []
    const parser = new TerminalMetadataParser((update) => updates.push(update))
    const queued = parser.push(bytes('\x1b]2;stale\x07\x07'))

    parser.dispose()
    parser.dispose()
    await queued
    await parser.push(bytes('\x1b]9;4;3\x07'))

    expect(updates).toEqual([])
    expect(disposeTerminal).toHaveBeenCalledOnce()
    disposeTerminal.mockRestore()
  })
})

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    killed: false,
    kill: vi.fn(() => true)
  })
}

describe('TmuxProgressObserver', () => {
  it('decodes control-mode output in order and treats observer failure as ancillary', async () => {
    const child = fakeChild()
    const updates: TerminalMetadataUpdate[] = []
    const onExit = vi.fn()
    const observer = new TmuxProgressObserver(
      {
        executable: 'tmux',
        args: ['-C', 'attach'],
        cwd: '/tmp',
        env: {},
        onTitle: (title) => updates.push({ type: 'title', title }),
        onProgress: (progress) => updates.push({ type: 'progress', progress }),
        onBell: () => updates.push({ type: 'bell' }),
        onExit
      },
      vi.fn(() => child) as never
    )

    child.stdout.write(
      '%output %0 before\\007\\033]0;\\342\n' +
        '%output %0 \\234\\223 #6 \\342\\200\\224 Fix title parsing\\007\\033]9;4;3\\007after\n'
    )
    expect(child.stdout.isPaused()).toBe(true)
    await vi.waitFor(() =>
      expect(updates).toEqual([
        { type: 'bell' },
        { type: 'title', title: '✓ #6 — Fix title parsing' },
        {
          type: 'progress',
          progress: { state: 'indeterminate', value: null }
        }
      ])
    )
    await vi.waitFor(() => expect(child.stdout.isPaused()).toBe(false))

    child.emit('error', new Error('observer failed'))
    expect(onExit).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledOnce()
    observer.dispose()
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('isolates metadata callback failures and suppresses later updates', async () => {
    const child = fakeChild()
    const onTitle = vi.fn()
    const onExit = vi.fn()
    const observer = new TmuxProgressObserver(
      {
        executable: 'tmux',
        args: ['-C', 'attach'],
        cwd: '/tmp',
        env: {},
        onTitle,
        onProgress: () => {
          throw new Error('metadata consumer failed')
        },
        onExit
      },
      vi.fn(() => child) as never
    )

    child.stdout.write('%output %0 \\033]9;4;3\\007\\033]2;stale\\007\n')
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce())

    expect(onTitle).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledOnce()
    observer.dispose()
  })

  it('does not publish queued metadata after disposal', async () => {
    const child = fakeChild()
    const onTitle = vi.fn()
    const onProgress = vi.fn()
    const onBell = vi.fn()
    const onExit = vi.fn()
    const observer = new TmuxProgressObserver(
      {
        executable: 'tmux',
        args: ['-C', 'attach'],
        cwd: '/tmp',
        env: {},
        onTitle,
        onProgress,
        onBell,
        onExit
      },
      vi.fn(() => child) as never
    )

    child.stdout.write('%output %0 \\033]2;stale\\007\\033]9;4;3\\007\\007\n')
    observer.dispose()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(onTitle).not.toHaveBeenCalled()
    expect(onProgress).not.toHaveBeenCalled()
    expect(onBell).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledOnce()
  })
})
