import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import {
  ExternalCommandError,
  OutputLimitCommandError,
  SignalCommandError,
  SpawnCommandError,
  SpawnCommandRunner,
  StdinCommandError,
  TimeoutCommandError,
  runCheckedEffect
} from './command'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-command-'))
  roots.push(root)
  return root
}

async function waitForFile(file: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await fs.readFile(file, 'utf8').catch(() => '')
    if (value) {
      return value
    }

    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${file}`)
}

describe('SpawnCommandRunner', () => {
  it('provides the Promise-compatible successful command boundary', async () => {
    const runner = new SpawnCommandRunner()
    const result = await runner.run({
      executable: process.execPath,
      args: [
        '-e',
        "process.stdin.setEncoding('utf8'); let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => { console.log(input.toUpperCase()); console.error('diagnostic') })"
      ],
      stdin: 'hello'
    })

    expect(result).toEqual({
      stdout: 'HELLO\n',
      stderr: 'diagnostic\n',
      exitCode: 0
    })

    const effectResult = await Effect.runPromise(
      runner.runEffect({
        executable: process.execPath,
        args: ['-e', "process.stdout.write('effect')"]
      })
    )
    expect(effectResult).toEqual({
      stdout: 'effect',
      stderr: '',
      exitCode: 0
    })
  })

  it('reports spawn failures with a stable tag and the original cause', async () => {
    const runner = new SpawnCommandRunner()
    const request = {
      executable: path.join(
        os.tmpdir(),
        `missing-treeport-command-${process.pid}`
      ),
      args: []
    }

    const error = await runner.run(request).catch((cause) => cause)

    expect(error).toBeInstanceOf(SpawnCommandError)
    expect(error).toMatchObject({ _tag: 'SpawnCommandError', request })
    expect(error.cause).toBeInstanceOf(Error)

    const caughtTag = await Effect.runPromise(
      runner
        .runEffect(request)
        .pipe(
          Effect.catchTag('SpawnCommandError', (failure) =>
            Effect.succeed(failure._tag)
          )
        )
    )
    expect(caughtTag).toBe('SpawnCommandError')
  })

  it('reports checked exits and unsolicited signals with typed errors', async () => {
    const runner = new SpawnCommandRunner()
    const checkedError = await Effect.runPromise(
      Effect.flip(
        runCheckedEffect(runner, {
          executable: process.execPath,
          args: [
            '-e',
            "process.stderr.write('bad command'); process.exitCode = 12"
          ]
        })
      )
    )

    expect(checkedError).toBeInstanceOf(ExternalCommandError)
    expect(checkedError).toMatchObject({
      _tag: 'ExternalCommandError',
      result: { exitCode: 12, stderr: 'bad command' }
    })

    const signalError = await runner
      .run({
        executable: process.execPath,
        args: ['-e', "process.kill(process.pid, 'SIGTERM')"]
      })
      .catch((cause) => cause)
    expect(signalError).toBeInstanceOf(SignalCommandError)
    expect(signalError).toMatchObject({
      _tag: 'SignalCommandError',
      signal: 'SIGTERM'
    })
  })

  it('times out after cooperative SIGTERM and escalates an uncooperative process to SIGKILL', async () => {
    const root = await temporaryRoot()
    const cooperativeSignalFile = path.join(root, 'cooperative-term-received')
    const uncooperativeSignalFile = path.join(
      root,
      'uncooperative-term-received'
    )
    const runner = new SpawnCommandRunner()

    const cooperativeError = await runner
      .run({
        executable: process.execPath,
        args: [
          '-e',
          `process.on('SIGTERM', () => { require('fs').writeFileSync(${JSON.stringify(cooperativeSignalFile)}, 'yes'); process.exit(0) }); setInterval(() => {}, 1000)`
        ],
        timeoutMs: 100,
        killGraceMs: 1_000
      })
      .catch((cause) => cause)
    expect(cooperativeError).toBeInstanceOf(TimeoutCommandError)
    expect(await fs.readFile(cooperativeSignalFile, 'utf8')).toBe('yes')

    const startedAt = Date.now()
    const uncooperativeError = await runner
      .run({
        executable: process.execPath,
        args: [
          '-e',
          `process.on('SIGTERM', () => require('fs').writeFileSync(${JSON.stringify(uncooperativeSignalFile)}, 'yes')); setInterval(() => {}, 1000)`
        ],
        timeoutMs: 100,
        killGraceMs: 100
      })
      .catch((cause) => cause)

    expect(uncooperativeError).toBeInstanceOf(TimeoutCommandError)
    expect(uncooperativeError).toMatchObject({
      _tag: 'TimeoutCommandError',
      timeoutMs: 100
    })
    expect(await fs.readFile(uncooperativeSignalFile, 'utf8')).toBe('yes')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180)
  })

  it('reports a broken stdin pipe and terminates the child', async () => {
    const runner = new SpawnCommandRunner()
    const error = await runner
      .run({
        executable: process.execPath,
        args: ['-e', "require('fs').closeSync(0); setInterval(() => {}, 1000)"],
        stdin: 'x'.repeat(1024 * 1024),
        killGraceMs: 50
      })
      .catch((cause) => cause)

    expect(error).toBeInstanceOf(StdinCommandError)
    expect(error).toMatchObject({ _tag: 'StdinCommandError' })
  })

  it('interrupts the Effect only after terminating and reaping the child', async () => {
    const root = await temporaryRoot()
    const pidFile = path.join(root, 'pid')
    const runner = new SpawnCommandRunner()
    const fiber = Effect.runFork(
      runner.runEffect({
        executable: process.execPath,
        args: [
          '-e',
          `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`
        ],
        killGraceMs: 100
      })
    )
    const pid = Number(await waitForFile(pidFile))
    const interruptedAt = Date.now()

    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(Date.now() - interruptedAt).toBeGreaterThanOrEqual(80)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('accepts exact output limits and terminates producers that exceed either stream limit', async () => {
    const runner = new SpawnCommandRunner()
    const exactResult = await runner.run({
      executable: process.execPath,
      args: [
        '-e',
        "process.stdout.write('12345678'); process.stderr.write('abcdefgh')"
      ],
      maxStdoutBytes: 8,
      maxStderrBytes: 8
    })
    expect(exactResult).toMatchObject({
      stdout: '12345678',
      stderr: 'abcdefgh',
      exitCode: 0
    })

    for (const stream of ['stdout', 'stderr'] as const) {
      const error = await runner
        .run({
          executable: process.execPath,
          args: [
            '-e',
            `process.${stream}.write('x'.repeat(1024)); setInterval(() => {}, 1000)`
          ],
          maxStdoutBytes: 32,
          maxStderrBytes: 32,
          killGraceMs: 50
        })
        .catch((cause) => cause)

      expect(error).toBeInstanceOf(OutputLimitCommandError)
      expect(error).toMatchObject({
        _tag: 'OutputLimitCommandError',
        stream,
        limitBytes: 32
      })
    }
  })
})
