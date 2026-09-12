/* eslint-disable anti-slop/no-chained-type-assertions, anti-slop/no-reflect-get, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Test-only adapters intentionally bridge the former Promise/callback fixtures to the Effect API. */
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import {
  connectOrStartTerminalHost as connectOrStartTerminalHostEffect,
  TerminalHostClient as EffectTerminalHostClient,
  type TerminalHostClientOptions
} from './terminal-host-client'
import {
  encodeTerminalHostFrame as encodeTerminalHostFrameEffect,
  makeTerminalHostFrameDecoder,
  type TerminalHostFrame
} from '../terminal-runtime/api'
import {
  makeTerminalHostServer,
  type TerminalHostServerOptions
} from '../terminal-runtime/server'
import type { TerminalHostSessions } from '../terminal-runtime/sessions'

async function runLegacy<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) {
    throw Cause.squash(exit.cause)
  }

  return exit.value
}

type Legacyify<T> = {
  [Key in keyof T]: T[Key] extends (
    ...args: infer Args
  ) => Effect.Effect<infer Value, any, any>
    ? (...args: Args) => Promise<Value>
    : T[Key]
}
type LegacyClient = Omit<
  Legacyify<EffectTerminalHostClient>,
  'attach' | 'runtimeEvents'
> & {
  attach(
    terminalId: string,
    listener: (data: string, sequence: number) => void
  ): Promise<{
    data: string
    links: readonly unknown[]
    images: unknown
    fence: number
    cols: number
    rows: number
    unsubscribe(): void
  } | null>
  subscribeRuntime(
    terminalId: string,
    listener: (event: unknown) => void
  ): Promise<() => void>
  dispose(): void
}

function legacyClient(
  client: EffectTerminalHostClient,
  scope: Scope.CloseableScope
): LegacyClient {
  return new Proxy(client as unknown as LegacyClient, {
    get(target, property, receiver) {
      if (property === 'dispose') {
        return () => void Effect.runPromise(Scope.close(scope, Exit.void))
      }

      if (property === 'attach') {
        return async (
          terminalId: string,
          listener: (data: string, sequence: number) => void
        ) => {
          const attachmentScope = await Effect.runPromise(Scope.make())
          const attachment = await Effect.runPromise(
            Scope.extend(client.attach(terminalId), attachmentScope)
          )
          if (!attachment) {
            await Effect.runPromise(Scope.close(attachmentScope, Exit.void))
            return null
          }

          await Effect.runPromise(
            Scope.extend(
              Effect.forkScoped(
                Stream.runForEach(attachment.output, ({ data, sequence }) =>
                  Effect.sync(() => listener(data, sequence))
                )
              ),
              attachmentScope
            )
          )
          const { output: _output, ...snapshot } = attachment
          return {
            ...snapshot,
            unsubscribe: () =>
              void Effect.runPromise(Scope.close(attachmentScope, Exit.void))
          }
        }
      }

      if (property === 'subscribeRuntime') {
        return async (
          terminalId: string,
          listener: (event: unknown) => void
        ) => {
          const runtimeScope = await Effect.runPromise(Scope.make())
          await Effect.runPromise(
            Scope.extend(
              Effect.forkScoped(
                Stream.runForEach(client.runtimeEvents(terminalId), (event) =>
                  Effect.sync(() => listener(event))
                )
              ),
              runtimeScope
            )
          )
          return () =>
            void Effect.runPromise(Scope.close(runtimeScope, Exit.void))
        }
      }

      const value = Reflect.get(target, property, receiver) as unknown
      if (typeof value !== 'function') {
        return value
      }

      return (...args: unknown[]) => {
        const result = value.apply(client, args) as unknown
        return Effect.isEffect(result)
          ? runLegacy(
              Scope.extend(result as Effect.Effect<unknown, unknown>, scope)
            )
          : result
      }
    }
  })
}

async function connectClient(
  socketPath: string,
  token: string,
  hostKey: string,
  expectedHostId?: string
): Promise<LegacyClient> {
  const scope = await Effect.runPromise(Scope.make())
  const client = await runLegacy(
    Scope.extend(
      EffectTerminalHostClient.connect(
        socketPath,
        token,
        hostKey,
        expectedHostId
      ),
      scope
    )
  )
  return legacyClient(client, scope)
}

const TerminalHostClient = { connect: connectClient }

async function connectOrStartTerminalHost(
  options: TerminalHostClientOptions
): Promise<LegacyClient> {
  const scope = await Effect.runPromise(Scope.make())
  const client = await runLegacy(
    Scope.extend(connectOrStartTerminalHostEffect(options), scope)
  )
  await runLegacy(client.commitStartup())
  return legacyClient(client, scope)
}

function adaptSessions(legacy: Record<string, any>): TerminalHostSessions {
  return new Proxy(legacy as TerminalHostSessions, {
    get(target, property, receiver) {
      if (property === 'sessionCount') {
        return Effect.succeed(legacy.sessionCount ?? 0)
      }

      if (property === 'attach') {
        return (terminalId: string) =>
          Effect.gen(function* () {
            const output = Stream.asyncScoped<{
              data: string
              sequence: number
            }>((emit) =>
              Effect.acquireRelease(
                Effect.sync(() =>
                  legacy.subscribeOutput(
                    terminalId,
                    (data: string, sequence: number) =>
                      emit.single({ data, sequence })
                  )
                ),
                (unsubscribe: () => void) => Effect.sync(unsubscribe)
              )
            )
            const snapshot = yield* Effect.tryPromise({
              try: () => Promise.resolve(legacy.snapshot(terminalId)),
              catch: (cause) => cause
            })
            return snapshot ? { ...snapshot, output } : null
          })
      }

      if (property === 'runtimeEvents') {
        return (terminalId: string) =>
          Stream.asyncScoped((emit) =>
            Effect.acquireRelease(
              Effect.sync(() =>
                legacy.subscribeRuntime(terminalId, (event: unknown) =>
                  emit.single(event)
                )
              ),
              (unsubscribe: () => void) => Effect.sync(unsubscribe)
            )
          )
      }

      if (property === 'pauseOutput') {
        return (terminalId: string) =>
          Effect.acquireRelease(
            Effect.sync(() => legacy.pauseOutput?.(terminalId) ?? null),
            (release: (() => void) | null) => Effect.sync(() => release?.())
          ).pipe(Effect.map((release) => release !== null))
      }

      const value = Reflect.get(target, property, receiver) as unknown
      if (typeof value !== 'function') {
        return value
      }

      return (...args: unknown[]) =>
        Effect.tryPromise({
          try: () => Promise.resolve(value.apply(legacy, args)),
          catch: (cause) => cause
        })
    }
  })
}

async function startTerminalHostServer(
  options: Omit<TerminalHostServerOptions, 'sessions'> & { sessions: any }
) {
  const scope = await Effect.runPromise(Scope.make())
  const host = await Effect.runPromise(
    Scope.extend(
      makeTerminalHostServer({
        ...options,
        sessions: adaptSessions(options.sessions)
      }),
      scope
    )
  )
  return {
    ...host,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

function encodeTerminalHostFrame(frame: TerminalHostFrame): Buffer {
  return Effect.runSync(encodeTerminalHostFrameEffect(frame))
}

class TerminalHostFrameDecoder {
  private readonly decode = makeTerminalHostFrameDecoder()
  push(chunk: Buffer): readonly TerminalHostFrame[] {
    return Effect.runSync(this.decode(chunk))
  }
}

interface OutputSubscriptionFixture {
  listener: ((data: string, sequence: number) => void) | null
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url))

describe('detached terminal host lifecycle', () => {
  const roots: string[] = []
  const hostPids = new Set<number>()
  const clients = new Set<LegacyClient>()

  afterEach(async () => {
    for (const client of clients) {
      client.dispose()
    }
    for (const pid of hostPids) {
      if (processExists(pid)) {
        process.kill(pid, 'SIGTERM')
      }
    }
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true })))
    roots.length = 0
    hostPids.clear()
    clients.clear()
  })

  it('fails pending requests on scope close and unsubscribes only after the last local attachment', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-terminal-client-scope-')
    )
    roots.push(root)
    const socketPath = path.join(root, 'host.sock')
    const hostKey = 'scope-host-key'
    const token = 'scope-token'
    const methods: string[] = []
    const server = net.createServer((socket) => {
      const decoder = new TerminalHostFrameDecoder()
      socket.on('data', (chunk) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.type !== 'request') {
            continue
          }

          methods.push(frame.method)
          if (frame.method === 'capture') {
            continue
          }

          const result =
            frame.method === 'handshake'
              ? {
                  hostId: 'scope-host',
                  hostKey,
                  pid: process.pid,
                  socketPath,
                  startedAt: '2026-01-01T00:00:00.000Z',
                  liveSessionCount: 1,
                  traceContext: true
                }
              : frame.method === 'attach'
                ? {
                    data: '',
                    links: [],
                    images: null,
                    fence: 0,
                    cols: 80,
                    rows: 24
                  }
                : null
          socket.write(
            encodeTerminalHostFrame({
              type: 'response',
              id: frame.id,
              result,
              error: null
            })
          )
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })

    const clientScope = await Effect.runPromise(Scope.make())
    const client = await runLegacy(
      Scope.extend(
        EffectTerminalHostClient.connect(socketPath, token, hostKey),
        clientScope
      )
    )
    const firstScope = await Effect.runPromise(Scope.make())
    const secondScope = await Effect.runPromise(Scope.make())
    await runLegacy(Scope.extend(client.attach('terminal'), firstScope))
    await runLegacy(Scope.extend(client.attach('terminal'), secondScope))
    expect(methods.filter((method) => method === 'attach')).toHaveLength(2)

    await Effect.runPromise(Scope.close(firstScope, Exit.void))
    expect(methods).not.toContain('unsubscribeOutput')
    await Effect.runPromise(Scope.close(secondScope, Exit.void))
    expect(
      methods.filter((method) => method === 'unsubscribeOutput')
    ).toHaveLength(1)

    const pending = Effect.runPromise(
      Effect.exit(client.captureTerminal('terminal', 10))
    )
    await waitFor(
      () => methods.includes('capture'),
      'The pending request was not admitted'
    )
    await Effect.runPromise(Scope.close(clientScope, Exit.void))
    const pendingExit = await pending
    expect(Exit.isFailure(pendingExit)).toBe(true)
    if (Exit.isFailure(pendingExit)) {
      expect(Cause.squash(pendingExit.cause)).toMatchObject({
        _tag: 'TerminalHostDisconnected'
      })
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  it('adopts the same PTY and canonical history after its daemon client restarts', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-terminal-host-test-')
    )
    roots.push(root)
    const dataDir = path.join(root, 'data')
    const runtimeDir = path.join(root, 'runtime')
    await Promise.all([
      fs.mkdir(dataDir, { recursive: true }),
      fs.mkdir(runtimeDir, { recursive: true })
    ])
    const launcherPath = path.join(root, 'launcher.mjs')
    await fs.writeFile(
      launcherPath,
      `import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
const spec = JSON.parse(await fs.readFile(process.argv[2], 'utf8'))
const child = spawn(spec.argv[0], spec.argv.slice(1), {
  cwd: spec.cwd,
  env: { ...process.env, ...spec.env },
  stdio: 'inherit'
})
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}
child.once('exit', (code) => process.exit(code ?? 1))
`
    )
    const options = {
      dataDir,
      runtimeDir,
      launcherPath,
      hostEntryPath: path.join(
        repositoryRoot,
        'apps/treeport/dist/node/server/terminal-host-entry.js'
      ),
      hostExecutable: process.execPath,
      hostArguments: []
    }

    const firstDaemon = await connectOrStartTerminalHost(options)
    clients.add(firstDaemon)
    hostPids.add(firstDaemon.record.pid)
    await expect(
      TerminalHostClient.connect(
        firstDaemon.record.socketPath,
        'not-the-local-host-token',
        firstDaemon.record.hostKey,
        firstDaemon.record.hostId
      )
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' })
    expect(processExists(firstDaemon.record.pid)).toBe(true)

    await firstDaemon.createTerminal({
      terminalId: 'terminal-host',
      worktreeId: 'worktree-host',
      name: 'Persistent terminal',
      createdAt: new Date().toISOString(),
      cwd: root,
      argv: [
        process.execPath,
        '-e',
        `process.stdin.setEncoding('utf8'); console.log('HOST_BOOT'); process.stdin.on('data', data => process.stdout.write('ECHO:' + data)); setInterval(() => {}, 1000)`
      ],
      shellCommand: null,
      interactiveShell: false,
      closeOnSuccess: false,
      initialSize: { cols: 80, rows: 24 },
      env: {}
    })
    await waitFor(
      async () =>
        (await firstDaemon.captureTerminal('terminal-host', 20))?.includes(
          'HOST_BOOT'
        ) ?? false,
      'The first daemon did not observe terminal output'
    )
    const hostPid = firstDaemon.record.pid
    firstDaemon.dispose()
    clients.delete(firstDaemon)
    expect(processExists(hostPid)).toBe(true)

    const restartedDaemon = await connectOrStartTerminalHost(options)
    clients.add(restartedDaemon)
    expect(restartedDaemon.record.pid).toBe(hostPid)
    expect(await restartedDaemon.listTerminals('worktree-host')).toEqual([
      expect.objectContaining({
        id: 'terminal-host',
        status: 'running'
      })
    ])
    expect(
      await restartedDaemon.captureTerminal('terminal-host', 20)
    ).toContain('HOST_BOOT')

    let liveOutput = ''
    const attachment = await restartedDaemon.attach(
      'terminal-host',
      (output) => {
        liveOutput += output
      }
    )
    expect(attachment?.data).toContain('HOST_BOOT')
    await restartedDaemon.resize('terminal-host', 100, 30)
    const transition =
      await restartedDaemon.prepareQueryAuthority('terminal-host')
    await restartedDaemon.activateQueryAuthority(
      'terminal-host',
      transition.transitionId,
      'test-viewer',
      1
    )
    restartedDaemon.write('terminal-host', 'AFTER_RESTART\n', {
      attachmentId: 'test-viewer',
      generation: 1
    })
    await waitFor(
      () => liveOutput.includes('ECHO:AFTER_RESTART'),
      'The adopted PTY did not accept input'
    )
    attachment?.unsubscribe()

    await restartedDaemon.killTerminal('terminal-host')
    await restartedDaemon.shutdownIfEmpty()
    restartedDaemon.dispose()
    clients.delete(restartedDaemon)
    await waitFor(
      () => !processExists(hostPid),
      'The empty terminal host did not stop'
    )
    hostPids.delete(hostPid)
  }, 20_000)

  it('removes only a transaction-owned provisional host when startup fails', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-terminal-host-provisional-')
    )
    roots.push(root)
    const dataDir = path.join(root, 'data')
    const runtimeDir = path.join(root, 'runtime')
    await Promise.all([
      fs.mkdir(dataDir, { recursive: true }),
      fs.mkdir(runtimeDir, { recursive: true })
    ])
    const scope = await Effect.runPromise(Scope.make())
    const client = await runLegacy(
      Scope.extend(
        connectOrStartTerminalHostEffect({
          dataDir,
          runtimeDir,
          launcherPath: path.join(
            repositoryRoot,
            'apps/treeport/dist/node/server/core/launcher.js'
          ),
          hostEntryPath: path.join(
            repositoryRoot,
            'apps/treeport/dist/node/server/terminal-host-entry.js'
          )
        }),
        scope
      )
    )
    const pid = client.record.pid
    hostPids.add(pid)

    await expect(
      runLegacy(
        client.createTerminal({
          terminalId: 'not-committed',
          worktreeId: 'worktree',
          name: 'Must not launch',
          createdAt: new Date().toISOString(),
          cwd: root,
          argv: ['/bin/sh'],
          shellCommand: null,
          interactiveShell: false,
          env: {}
        })
      )
    ).rejects.toMatchObject({ code: 'HOST_PROVISIONAL' })

    await Effect.runPromise(Scope.close(scope, Exit.fail('startup failed')))
    await waitFor(
      () => !processExists(pid),
      'The failed startup left its provisional terminal host running'
    )
    hostPids.delete(pid)
    await expect(
      fs
        .readdir(runtimeDir)
        .then((names) =>
          names.filter(
            (name) =>
              name.startsWith('terminal-host-') && name.endsWith('.json')
          )
        )
    ).resolves.toEqual([])
  })

  it('delivers live output after a large snapshot without dropping or reordering frames', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-terminal-host-large-snapshot-')
    )
    roots.push(root)
    const socketPath = path.join(root, 'host.sock')
    const recordPath = path.join(root, 'host.json')
    const outputSubscription: OutputSubscriptionFixture = { listener: null }
    const sessions = {
      initialize: async () => undefined,
      get sessionCount() {
        return 1
      },
      subscribeOutput(
        _terminalId: string,
        listener: (data: string, sequence: number) => void
      ) {
        outputSubscription.listener = listener
        return () => {
          outputSubscription.listener = null
        }
      },
      snapshot: async () => {
        setImmediate(() => outputSubscription.listener?.('after-snapshot', 1))
        return {
          data: 'x'.repeat(5 * 1024 * 1024),
          links: [],
          fence: 0,
          cols: 80,
          rows: 24
        }
      },
      captureTerminal: async () => 'still-connected',
      restoreHostQueryAuthority: async () => undefined
    }
    const host = await startTerminalHostServer({
      hostId: 'large-snapshot-host',
      hostKey: 'large-snapshot-key',
      token: 'large-snapshot-token',
      socketPath,
      recordPath,
      // SAFETY: The fixture implements every session-manager operation exercised by this host scenario.
      sessions: sessions as never
    })
    const client = await TerminalHostClient.connect(
      socketPath,
      'large-snapshot-token',
      'large-snapshot-key',
      'large-snapshot-host'
    )
    clients.add(client)

    try {
      const received: string[] = []
      const attachment = await client.attach('terminal', (output) => {
        received.push(output)
      })
      expect(attachment?.data).toHaveLength(5 * 1024 * 1024)
      await waitFor(
        () => received.length > 0,
        'Live output did not follow the large snapshot'
      )
      expect(received).toEqual(['after-snapshot'])
      expect(await client.captureTerminal('terminal', 1)).toBe(
        'still-connected'
      )
      attachment?.unsubscribe()
    } finally {
      client.dispose()
      clients.delete(client)
      await host.close()
    }
  })

  it('delivers concurrent large snapshots without closing the host connection', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-large-snapshots-')
    )
    roots.push(root)
    const socketPath = path.join(root, 'host.sock')
    const recordPath = path.join(root, 'host.json')
    const sessions = {
      initialize: async () => undefined,
      get sessionCount() {
        return 1
      },
      subscribeOutput: () => () => undefined,
      snapshot: async () => ({
        data: 'x'.repeat(5 * 1024 * 1024),
        links: [],
        images: null,
        fence: 0,
        cols: 80,
        rows: 24
      }),
      captureTerminal: async () => 'still-connected',
      restoreHostQueryAuthority: async () => undefined
    }
    const host = await startTerminalHostServer({
      hostId: 'concurrent-snapshots-host',
      hostKey: 'concurrent-snapshots-key',
      token: 'concurrent-snapshots-token',
      socketPath,
      recordPath,
      // SAFETY: The fixture implements every session-manager operation exercised by this host scenario.
      sessions: sessions as never
    })
    const client = await TerminalHostClient.connect(
      socketPath,
      'concurrent-snapshots-token',
      'concurrent-snapshots-key',
      'concurrent-snapshots-host'
    )
    clients.add(client)

    try {
      const attachments = await Promise.all([
        client.attach('terminal', () => undefined),
        client.attach('terminal', () => undefined)
      ])
      expect(attachments[0]?.data).toHaveLength(5 * 1024 * 1024)
      expect(attachments[1]?.data).toHaveLength(5 * 1024 * 1024)
      attachments.forEach((attachment) => attachment?.unsubscribe())
      expect(await client.captureTerminal('terminal', 1)).toBe(
        'still-connected'
      )
    } finally {
      client.dispose()
      clients.delete(client)
      await host.close()
    }
  })

  it('pauses terminal output while a large live image burst drains', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-terminal-host-output-flow-')
    )
    roots.push(root)
    const socketPath = path.join(root, 'host.sock')
    const recordPath = path.join(root, 'host.json')
    const outputSubscription: OutputSubscriptionFixture = { listener: null }
    const output = 'x'.repeat(128 * 1024)
    const outputChunks = 64
    let nextSequence = 1
    let paused = false
    let pauseCount = 0
    let resumeCount = 0
    let emit = () => undefined
    const sessions = {
      initialize: async () => undefined,
      get sessionCount() {
        return 1
      },
      subscribeOutput(
        _terminalId: string,
        listener: (data: string, sequence: number) => void
      ) {
        outputSubscription.listener = listener
        return () => {
          outputSubscription.listener = null
        }
      },
      pauseOutput() {
        paused = true
        pauseCount++
        let active = true
        return () => {
          if (!active) {
            return
          }

          active = false
          paused = false
          resumeCount++
          setImmediate(emit)
        }
      },
      snapshot: async () => ({
        data: '',
        links: [],
        images: null,
        fence: 0,
        cols: 80,
        rows: 24
      }),
      captureTerminal: async () => 'still-connected',
      restoreHostQueryAuthority: async () => undefined
    }
    const host = await startTerminalHostServer({
      hostId: 'output-flow-host',
      hostKey: 'output-flow-key',
      token: 'output-flow-token',
      socketPath,
      recordPath,
      // SAFETY: The fixture implements every session-manager operation exercised by this host scenario.
      sessions: sessions as never
    })
    const client = await TerminalHostClient.connect(
      socketPath,
      'output-flow-token',
      'output-flow-key',
      'output-flow-host'
    )
    clients.add(client)

    try {
      let receivedBytes = 0
      const attachment = await client.attach('terminal', (data) => {
        receivedBytes += data.length
      })
      emit = () => {
        while (!paused && nextSequence <= outputChunks) {
          outputSubscription.listener?.(output, nextSequence++)
        }
      }
      emit()

      await waitFor(
        () => receivedBytes === output.length * outputChunks,
        'The live output burst did not drain',
        10_000
      )
      expect(pauseCount).toBeGreaterThan(0)
      expect(resumeCount).toBe(pauseCount)
      expect(await client.captureTerminal('terminal', 1)).toBe(
        'still-connected'
      )
      attachment?.unsubscribe()
    } finally {
      client.dispose()
      clients.delete(client)
      await host.close()
    }
  })

  it('disconnects a producer that ignores output backpressure without affecting the host', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-terminal-host-slow-client-')
    )
    roots.push(root)
    const socketPath = path.join(root, 'host.sock')
    const recordPath = path.join(root, 'host.json')
    const outputSubscription: OutputSubscriptionFixture = { listener: null }
    let unsubscribed = false
    const sessions = {
      initialize: async () => undefined,
      get sessionCount() {
        return 1
      },
      subscribeOutput(
        _terminalId: string,
        listener: (data: string, sequence: number) => void
      ) {
        outputSubscription.listener = listener
        return () => {
          outputSubscription.listener = null
          unsubscribed = true
        }
      },
      pauseOutput: () => null,
      snapshot: async () => ({
        data: '',
        links: [],
        images: null,
        fence: 0,
        cols: 80,
        rows: 24
      }),
      captureTerminal: async () => 'host-available',
      restoreHostQueryAuthority: async () => undefined
    }
    const host = await startTerminalHostServer({
      hostId: 'slow-client-host',
      hostKey: 'slow-client-key',
      token: 'slow-client-token',
      socketPath,
      recordPath,
      // SAFETY: The fixture implements every session-manager operation exercised by this host scenario.
      sessions: sessions as never
    })
    const slowClient = await TerminalHostClient.connect(
      socketPath,
      'slow-client-token',
      'slow-client-key',
      'slow-client-host'
    )
    clients.add(slowClient)

    try {
      await slowClient.attach('terminal', () => undefined)
      const emitOutput = outputSubscription.listener
      if (!emitOutput) {
        throw new Error('The host did not subscribe the client to output')
      }

      for (let sequence = 1; sequence <= 80; sequence += 1) {
        emitOutput('x'.repeat(256 * 1024), sequence)
      }

      await expect(slowClient.captureTerminal('terminal', 1)).rejects.toThrow(
        'Terminal host connection closed'
      )
      await waitFor(
        () => unsubscribed,
        'The disconnected client retained its output subscription'
      )

      const nextClient = await TerminalHostClient.connect(
        socketPath,
        'slow-client-token',
        'slow-client-key',
        'slow-client-host'
      )
      clients.add(nextClient)
      expect(await nextClient.captureTerminal('terminal', 1)).toBe(
        'host-available'
      )
      nextClient.dispose()
      clients.delete(nextClient)
    } finally {
      slowClient.dispose()
      clients.delete(slowClient)
      await host.close()
    }
  })

  it('returns UNSUPPORTED_METHOD and keeps an authenticated connection usable', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-terminal-host-unknown-method-')
    )
    roots.push(root)
    const socketPath = path.join(root, 'host.sock')
    const host = await startTerminalHostServer({
      hostId: 'unknown-method-host',
      hostKey: 'unknown-method-key',
      token: 'unknown-method-token',
      socketPath,
      recordPath: path.join(root, 'host.json'),
      sessions: {
        initialize: async () => undefined,
        get sessionCount() {
          return 0
        },
        captureTerminal: async () => 'still-usable',
        restoreHostQueryAuthority: async () => undefined
      }
    })
    const socket = net.createConnection(socketPath)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const decoder = new TerminalHostFrameDecoder()
    const responses: TerminalHostFrame[] = []
    socket.on('data', (chunk) => responses.push(...decoder.push(chunk)))
    const request = async (
      id: string,
      method: string,
      input: {
        token?: string
        hostKey?: string
        terminalId?: string
        lines?: number
      }
    ) => {
      socket.write(
        encodeTerminalHostFrame({ type: 'request', id, method, input })
      )
      await waitFor(
        () =>
          responses.some(
            (frame) => frame.type === 'response' && frame.id === id
          ),
        `No response for ${method}`
      )
      return responses.find(
        (frame) => frame.type === 'response' && frame.id === id
      )
    }

    try {
      expect(
        await request('handshake', 'handshake', {
          token: 'unknown-method-token',
          hostKey: 'unknown-method-key'
        })
      ).toMatchObject({ type: 'response', error: null })
      expect(await request('unknown', 'futureMethod', {})).toMatchObject({
        type: 'response',
        error: { code: 'UNSUPPORTED_METHOD' }
      })
      expect(
        await request('capture', 'capture', {
          terminalId: 'terminal',
          lines: 1
        })
      ).toMatchObject({
        type: 'response',
        result: 'still-usable',
        error: null
      })
      expect(socket.destroyed).toBe(false)
    } finally {
      socket.destroy()
      await host.close()
    }
  })

  it('refuses a live historical host without replacing or signaling it', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-terminal-host-legacy-')
    )
    roots.push(root)
    const dataDir = path.join(root, 'data')
    const runtimeDir = path.join(root, 'runtime')
    await Promise.all([
      fs.mkdir(dataDir, { recursive: true }),
      fs.mkdir(runtimeDir, { recursive: true })
    ])
    const hostKey = (await import('node:crypto'))
      .createHash('sha256')
      .update(path.resolve(dataDir))
      .digest('hex')
      .slice(0, 20)
    const socketPath = path.join(
      os.tmpdir(),
      `treeport-${process.getuid?.() ?? 'user'}`,
      `terminal-${hostKey}.sock`
    )
    const recordPath = path.join(runtimeDir, `terminal-host-${hostKey}.json`)
    const source = JSON.stringify({
      protocolVersion: 4,
      hostId: 'legacy-live-host',
      hostKey,
      pid: process.pid,
      socketPath,
      startedAt: new Date().toISOString()
    })
    await fs.writeFile(recordPath, source)
    const spawnHost = vi.fn()

    // SAFETY: This test spy replaces spawn, which this path must not invoke.
    await expect(
      connectOrStartTerminalHost({
        dataDir,
        runtimeDir,
        launcherPath: path.join(root, 'launcher.mjs'),
        hostEntryPath: path.join(
          repositoryRoot,
          'apps/treeport/src/terminal-runtime/entry.ts'
        ),
        spawnHost: spawnHost as never
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_HOST' })
    expect(spawnHost).not.toHaveBeenCalled()
    expect(processExists(process.pid)).toBe(true)
    expect(await fs.readFile(recordPath, 'utf8')).toBe(source)
  })

  it('does not contact or unlink an unidentified socket without a discovery record', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-terminal-host-unidentified-')
    )
    roots.push(root)
    const dataDir = path.join(root, 'data')
    const runtimeDir = path.join(root, 'runtime')
    await Promise.all([
      fs.mkdir(dataDir, { recursive: true }),
      fs.mkdir(runtimeDir, { recursive: true })
    ])
    const hostKey = (await import('node:crypto'))
      .createHash('sha256')
      .update(path.resolve(dataDir))
      .digest('hex')
      .slice(0, 20)
    const socketPath = path.join(
      os.tmpdir(),
      `treeport-${process.getuid?.() ?? 'user'}`,
      `terminal-${hostKey}.sock`
    )
    await fs.mkdir(path.dirname(socketPath), { recursive: true })
    let connections = 0
    const server = net.createServer((socket) => {
      connections += 1
      socket.destroy()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    const spawnHost = vi.fn()

    try {
      // SAFETY: This test spy replaces spawn, which this path must not invoke.
      await expect(
        connectOrStartTerminalHost({
          dataDir,
          runtimeDir,
          launcherPath: path.join(root, 'launcher.mjs'),
          hostEntryPath: path.join(
            repositoryRoot,
            'apps/treeport/src/terminal-runtime/entry.ts'
          ),
          spawnHost: spawnHost as never
        })
      ).rejects.toThrow('without a valid discovery record')
      expect(spawnHost).not.toHaveBeenCalled()
      expect(connections).toBe(0)
      await expect(fs.stat(socketPath)).resolves.toBeDefined()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await fs.rm(socketPath, { force: true })
    }
  })

  it('does not replace a recorded live process when its socket is unavailable', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-terminal-host-stale-test-')
    )
    roots.push(root)
    const dataDir = path.join(root, 'data')
    const runtimeDir = path.join(root, 'runtime')
    await Promise.all([
      fs.mkdir(dataDir, { recursive: true }),
      fs.mkdir(runtimeDir, { recursive: true })
    ])
    const hostKey = (await import('node:crypto'))
      .createHash('sha256')
      .update(path.resolve(dataDir))
      .digest('hex')
      .slice(0, 20)
    await fs.writeFile(
      path.join(runtimeDir, `terminal-host-${hostKey}.json`),
      JSON.stringify({
        hostId: 'unavailable-host',
        hostKey,
        pid: process.pid,
        socketPath: path.join(
          os.tmpdir(),
          `treeport-${process.getuid?.() ?? 'user'}`,
          `terminal-${hostKey}.sock`
        ),
        startedAt: new Date().toISOString()
      })
    )

    await expect(
      connectOrStartTerminalHost({
        dataDir,
        runtimeDir,
        launcherPath: path.join(root, 'launcher.mjs'),
        hostEntryPath: path.join(
          repositoryRoot,
          'apps/treeport/src/terminal-runtime/entry.ts'
        ),
        hostExecutable: process.execPath
      })
    ).rejects.toThrow('will not signal it')
  })
})
