import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { SpawnCommandRunner, TmuxAdapter } from './core/index.js'
import { afterAll, describe, expect, it } from 'vitest'
import {
  TerminalMetadataParser,
  TmuxProgressObserver,
  type TerminalMetadataUpdate
} from './tmux-progress.js'
import {
  controlAttachArgs,
  encodeControlInput,
  progressControlAttachArgs,
  resizeControlClient,
  TmuxControlParser,
  type TmuxControlEvent
} from './tmux-control.js'

const enabled = process.env.TASKTTY_REAL_INTEGRATION === '1'
const root = path.join(
  os.tmpdir(),
  `tasktty control characterization ${process.pid}`
)
const execute = promisify(execFile)
afterAll(async () => fs.rm(root, { recursive: true, force: true }))

async function waitFor(
  check: () => boolean | Promise<boolean>,
  message: string
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

function supportsCsiU(version: string): boolean {
  const match = version.match(/(\d+)\.(\d+)/)
  if (!match) {
    return false
  }

  const [major, minor] = match.slice(1).map(Number)
  return major! > 3 || (major === 3 && minor! >= 5)
}

describe.skipIf(!enabled)('real tmux control-mode characterization', () => {
  it('applies production config, round-trips bytes, resizes, and leaves the session alive', async (context) => {
    let tmuxVersion: string
    try {
      tmuxVersion = (await execute('tmux', ['-V'])).stdout.trim()
    } catch {
      context.skip()
      return
    }

    await fs.mkdir(root, { recursive: true })
    const socket = `tasktty-control-${process.pid}`
    const session = 'control-characterization'
    const tmux = new TmuxAdapter(new SpawnCommandRunner(), root)
    await tmux.initialize()
    const base = ['-L', socket, '-f', tmux.configPath]
    const program = [
      'process.stdin.setRawMode?.(true);',
      'process.stdin.resume();',
      'let pending = Buffer.alloc(0);',
      "process.stdin.on('data', data => {",
      '  pending = Buffer.concat([pending, data]);',
      '  if (pending.length < 13) return;',
      "  process.stdout.write(Buffer.from('\\x1b]2;Real tmux title\\x07\\x1b]9;4;3\\x07\\x1b]9;4;0\\x1b\\\\\\x07\\x1b]8;;https://example.test\\x07LINK\\x1b]8;;\\x07|'));",
      '  process.stdout.write(pending);',
      "  process.stdout.write(Buffer.from('|END'));",
      '  pending = Buffer.alloc(0);',
      '});',
      'setInterval(() => {}, 1000);'
    ].join('')

    await execute('tmux', [
      ...base,
      'new-session',
      '-d',
      '-s',
      session,
      '-x',
      '80',
      '-y',
      '24',
      '--',
      process.execPath,
      '-e',
      program
    ])

    try {
      await execute('tmux', [...base, 'set-option', '-g', 'mouse', 'off'])
      await tmux.configureServer(socket)
      await tmux.useManualWindowSize(socket, session)
      await expect(
        execute('tmux', [...base, 'show-options', '-gv', 'mouse']).then(
          (result) => result.stdout.trim()
        )
      ).resolves.toBe('on')
      if (supportsCsiU(tmuxVersion)) {
        await expect(
          execute('tmux', [
            ...base,
            'show-options',
            '-sv',
            'extended-keys-format'
          ]).then((result) => result.stdout.trim())
        ).resolves.toBe('csi-u')
      }

      const paneId = (
        await execute('tmux', [
          ...base,
          'display-message',
          '-p',
          '-t',
          session,
          '#{pane_id}'
        ])
      ).stdout.trim()
      const control = spawn(
        'tmux',
        controlAttachArgs(socket, tmux.configPath, session),
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              ([key, value]) =>
                value !== undefined && key !== 'TMUX' && key !== 'TMUX_PANE'
            )
          ) as NodeJS.ProcessEnv
        }
      )
      const parser = new TmuxControlParser()
      const events: TmuxControlEvent[] = []
      let parserError: Error | null = null
      let stderr = ''
      control.stdout.on('data', (chunk: Buffer) => {
        try {
          events.push(...parser.push(chunk))
        } catch (error) {
          parserError = error as Error
        }
      })
      control.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))

      await waitFor(
        () =>
          events.some(
            (event) =>
              event.type === 'notification' && event.name === 'session-changed'
          ),
        'control client did not attach'
      )

      const sent = Buffer.concat([
        Buffer.from([0x1b, 0x00]),
        Buffer.from('☃', 'utf8'),
        Buffer.from([0x7f]),
        Buffer.from('\x1b[65;5u')
      ])
      for (const command of encodeControlInput(paneId, sent, 3)) {
        control.stdin.write(command)
      }

      const outputBytes = () =>
        Buffer.concat(
          events
            .filter(
              (event): event is Extract<TmuxControlEvent, { type: 'output' }> =>
                event.type === 'output' && event.paneId === paneId
            )
            .map((event) => Buffer.from(event.data))
        )
      await waitFor(
        () => outputBytes().includes(Buffer.from('|END')),
        'pane output did not arrive'
      )
      const output = outputBytes()
      expect(
        output.indexOf(Buffer.from('\x1b]9;4;3\x07'))
      ).toBeGreaterThanOrEqual(0)
      expect(
        output.indexOf(
          Buffer.from('\x1b]8;;https://example.test\x07LINK\x1b]8;;\x07|')
        )
      ).toBeGreaterThanOrEqual(0)
      const start = output.indexOf(Buffer.from('LINK\x1b]8;;\x07|'))
      const echoed = output.subarray(
        start + Buffer.byteLength('LINK\x1b]8;;\x07|')
      )
      expect(echoed.subarray(0, sent.length)).toEqual(sent)

      const progressControl = spawn(
        'tmux',
        progressControlAttachArgs(socket, tmux.configPath, session),
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              ([key, value]) =>
                value !== undefined && key !== 'TMUX' && key !== 'TMUX_PANE'
            )
          ) as NodeJS.ProcessEnv
        }
      )
      const progressParser = new TmuxControlParser()
      const progressEvents: TmuxControlEvent[] = []
      progressControl.stdout.on('data', (chunk: Buffer) =>
        progressEvents.push(...progressParser.push(chunk))
      )
      progressControl.stderr.resume()
      await waitFor(
        () =>
          progressEvents.some(
            (event) =>
              event.type === 'notification' && event.name === 'session-changed'
          ),
        'read-only progress observer did not attach'
      )
      for (const command of encodeControlInput(paneId, sent, 3)) {
        control.stdin.write(command)
      }
      const progressOutput = () =>
        Buffer.concat(
          progressEvents
            .filter(
              (event): event is Extract<TmuxControlEvent, { type: 'output' }> =>
                event.type === 'output' && event.paneId === paneId
            )
            .map((event) => Buffer.from(event.data))
        )
      await waitFor(
        () => progressOutput().includes(Buffer.from('\x1b]9;4;0\x1b\\\x07')),
        'read-only progress observer did not receive terminal metadata'
      )
      const metadataUpdates: unknown[] = []
      const metadataParser = new TerminalMetadataParser((update) =>
        metadataUpdates.push(update)
      )
      await metadataParser.push(progressOutput())
      metadataParser.dispose()
      expect(metadataUpdates).toEqual(
        expect.arrayContaining([
          { type: 'title', title: 'Real tmux title' },
          {
            type: 'progress',
            progress: { state: 'indeterminate', value: null }
          },
          { type: 'progress', progress: null },
          { type: 'bell' }
        ])
      )
      await expect(
        execute('tmux', [
          ...base,
          'display-message',
          '-p',
          '-t',
          session,
          '#{window_width}x#{window_height}'
        ]).then((result) => result.stdout.trim())
      ).resolves.toBe('80x24')
      const progressControlExited = new Promise<void>((resolve) =>
        progressControl.once('exit', () => resolve())
      )
      progressControl.kill()
      await progressControlExited

      const clientsBeforeObserver = (
        await execute('tmux', [...base, 'list-clients', '-F', '#{client_pid}'])
      ).stdout
        .trim()
        .split('\n')
        .filter(Boolean).length
      const observerUpdates: TerminalMetadataUpdate[] = []
      let observerExited = false
      const observer = new TmuxProgressObserver({
        executable: 'tmux',
        args: progressControlAttachArgs(socket, tmux.configPath, session),
        cwd: root,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key, value]) =>
              value !== undefined && key !== 'TMUX' && key !== 'TMUX_PANE'
          )
        ) as NodeJS.ProcessEnv,
        onTitle: (title) => observerUpdates.push({ type: 'title', title }),
        onProgress: (progress) =>
          observerUpdates.push({ type: 'progress', progress }),
        onBell: () => observerUpdates.push({ type: 'bell' }),
        onExit: () => {
          observerExited = true
        }
      })
      await waitFor(async () => {
        const clients = (
          await execute('tmux', [
            ...base,
            'list-clients',
            '-F',
            '#{client_pid}'
          ])
        ).stdout
          .trim()
          .split('\n')
          .filter(Boolean).length
        return clients > clientsBeforeObserver
      }, 'production progress observer did not attach')

      observerUpdates.length = 0
      for (const command of encodeControlInput(paneId, sent, 3)) {
        control.stdin.write(command)
      }
      await waitFor(
        () => observerUpdates.length >= 4,
        'production progress observer did not publish terminal metadata'
      )
      expect(observerUpdates).toEqual([
        { type: 'title', title: 'Real tmux title' },
        {
          type: 'progress',
          progress: { state: 'indeterminate', value: null }
        },
        { type: 'progress', progress: null },
        { type: 'bell' }
      ])

      observer.dispose()
      const updateCount = observerUpdates.length
      const outputLength = outputBytes().length
      for (const command of encodeControlInput(paneId, sent, 3)) {
        control.stdin.write(command)
      }
      await waitFor(
        () => outputBytes().length > outputLength,
        'pane did not respond after progress observer disposal'
      )
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(observerUpdates).toHaveLength(updateCount)
      expect(observerExited).toBe(false)

      control.stdin.write(resizeControlClient(91, 27))
      await new Promise((resolve) => setTimeout(resolve, 25))
      await expect(
        execute('tmux', [
          ...base,
          'display-message',
          '-p',
          '-t',
          session,
          '#{window_width}x#{window_height}'
        ]).then((result) => result.stdout.trim())
      ).resolves.toBe('80x24')

      await tmux.resizeWindow(socket, session, 91, 27)
      await waitFor(async () => {
        const size = (
          await execute('tmux', [
            ...base,
            'display-message',
            '-p',
            '-t',
            session,
            '#{window_width}x#{window_height}'
          ])
        ).stdout.trim()
        return size === '91x27'
      }, 'explicit canonical window resize was not applied')

      control.stdin.write('detach-client\n')
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('control client did not exit')),
          5_000
        )
        control.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      expect(parserError).toBeNull()
      expect(stderr).toBe('')
      await expect(
        execute('tmux', [...base, 'has-session', '-t', session])
      ).resolves.toBeTruthy()
    } finally {
      await execute('tmux', [...base, 'kill-server']).catch(() => undefined)
    }
  })
})
