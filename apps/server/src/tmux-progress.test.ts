import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  TerminalMetadataParser,
  TerminalProgressParser,
  TmuxProgressObserver
} from './tmux-progress.js'

const bytes = (value: string) => Buffer.from(value, 'binary')

describe('TerminalProgressParser', () => {
  it('extracts UTF-8 terminal titles alongside progress metadata', () => {
    const parser = new TerminalMetadataParser()
    expect(
      parser.push(Buffer.from('\x1b]2;Pi · /repo\x07\x1b]9;4;1;42\x1b\\'))
    ).toEqual([
      { type: 'title', title: 'Pi · /repo' },
      { type: 'progress', progress: { state: 'normal', value: 42 } }
    ])
  })

  it('extracts OSC 9;4 updates terminated by BEL or ST', () => {
    const parser = new TerminalProgressParser()
    expect(parser.push(bytes('before\x1b]9;4;3\x07after'))).toEqual([
      { state: 'indeterminate', value: null }
    ])
    expect(parser.push(bytes('\x1b]9;4;1;42\x1b\\'))).toEqual([
      { state: 'normal', value: 42 }
    ])
    expect(parser.push(bytes('\x9d9;4;2;100\x9c'))).toEqual([
      { state: 'error', value: 100 }
    ])
    expect(parser.push(bytes('\x1b]9;4;0\x07'))).toEqual([null])
  })

  it('preserves OSC parser state across arbitrary chunks', () => {
    const sequence = bytes('text\x1b]9;4;4;7\x1b\\more')
    for (let split = 1; split < sequence.length; split += 1) {
      const parser = new TerminalProgressParser()
      expect([
        ...parser.push(sequence.subarray(0, split)),
        ...parser.push(sequence.subarray(split))
      ]).toEqual([{ state: 'paused', value: 7 }])
    }
  })

  it('ignores unrelated, malformed, and oversized OSC payloads and then recovers', () => {
    const parser = new TerminalProgressParser()
    expect(
      parser.push(
        bytes(
          `\x1b]0;title\x07\x1b]9;4;1;101\x07\x1b]${'x'.repeat(80)}\x1b]9;4;3\x07`
        )
      )
    ).toEqual([{ state: 'indeterminate', value: null }])
  })

  it('extracts multiple updates from one chunk', () => {
    const parser = new TerminalProgressParser()
    expect(parser.push(bytes('\x1b]9;4;3\x07x\x1b]9;4;0\x07'))).toEqual([
      { state: 'indeterminate', value: null },
      null
    ])
  })
})

describe('TmuxProgressObserver', () => {
  it('decodes control-mode output and treats observer failure as ancillary', () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      killed: false,
      kill: vi.fn(() => true)
    })
    const onTitle = vi.fn()
    const onProgress = vi.fn()
    const onExit = vi.fn()
    const observer = new TmuxProgressObserver(
      {
        executable: 'tmux',
        args: ['-C', 'attach'],
        cwd: '/tmp',
        env: {},
        onTitle,
        onProgress,
        onExit
      },
      vi.fn(() => child) as never
    )

    child.stdout.write(
      '%output %0 before\\033]2;Pi\\007\\033]9;4;3\\007after\n'
    )
    expect(onTitle).toHaveBeenCalledWith('Pi')
    expect(onProgress).toHaveBeenCalledWith({
      state: 'indeterminate',
      value: null
    })

    child.emit('error', new Error('observer failed'))
    expect(onExit).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledOnce()
    observer.dispose()
    expect(child.kill).toHaveBeenCalledOnce()
  })
})
