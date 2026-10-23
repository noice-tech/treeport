import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { getSessionKeeperPayload } from '@treeport/session-keeper'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import { expect, it } from 'vitest'
import { SpawnCommandRunner } from './core/command'
import { GitAdapter } from './core/git'
import { TerminalHostClient } from './terminal-host-client'
import { startTerminalEngineWorker } from './terminal-engine-worker'
import { makeTerminalHostSessions } from '../terminal-runtime/sessions'
import { makeTerminalHostServer } from '../terminal-runtime/server'

// Opt-in synthetic mixed-load comparison. Never contacts a running Treeport.
// MEASURE_TREEPORT_THROUGHPUT=1 pnpm exec vitest run --config vitest.integration.config.ts apps/treeport/src/server/throughput.integration.test.ts
it.skipIf(process.env.MEASURE_TREEPORT_THROUGHPUT !== '1')(
  'measures embedded versus worker terminal parsing with Git and HTTP control traffic',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-load-'))
    const runner = new SpawnCommandRunner()
    const run = async (...args: string[]) => {
      const result = await runner.run({ executable: 'git', args, cwd: root })
      expect(result.exitCode, result.stderr).toBe(0)
    }
    const server = http.createServer((_request, response) =>
      response.end('control')
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- Node returns a string only for Unix listeners; this fixture binds an ephemeral TCP port.
    if (!address || typeof address === 'string') {
      throw new Error('Missing HTTP listener')
    }

    const url = `http://127.0.0.1:${address.port}`
    const launcherPath = fileURLToPath(
      new URL('../../dist/node/server/core/launcher.js', import.meta.url)
    )
    const workerEntry = fileURLToPath(
      new URL(
        '../../dist/node/server/terminal-engine-worker.js',
        import.meta.url
      )
    )
    const files = Array.from({ length: 20 }, (_, index) => `file-${index}.txt`)
    const measurements: string[] = []
    try {
      await run('init', '-b', 'main')
      await run('config', 'user.name', 'Benchmark')
      await run('config', 'user.email', 'benchmark@example.test')
      await Promise.all(
        files.map((file) => fs.writeFile(path.join(root, file), 'base\n'))
      )
      await fs.writeFile(
        path.join(root, '.gitignore'),
        'embedded/\nworker/\n*.sock\n'
      )
      await run('add', '.')
      await run('commit', '-m', 'base')
      await Promise.all(
        files.map((file) => fs.appendFile(path.join(root, file), 'changed\n'))
      )
      for (const mode of ['embedded', 'worker'] as const) {
        const scope = await Effect.runPromise(Scope.make())
        const runtimeDir = path.join(root, mode)
        const socketPath = path.join(root, `${mode}.sock`)
        await fs.mkdir(runtimeDir)
        const options = {
          runtimeDir,
          socketPath,
          launcherPath,
          recordPath: path.join(runtimeDir, 'engine.json'),
          sessionExecutable: getSessionKeeperPayload(),
          journalLimitBytes: 64 * 1024 * 1024,
          hostId: mode,
          hostKey: mode,
          token: crypto.randomBytes(32).toString('hex')
        }
        const histogram = monitorEventLoopDelay({ resolution: 10 })
        let client: TerminalHostClient | null = null
        try {
          if (mode === 'worker') {
            await Effect.runPromise(
              Scope.extend(
                startTerminalEngineWorker(workerEntry, options, process.env),
                scope
              )
            )
          } else {
            await Effect.runPromise(
              Scope.extend(
                Effect.gen(function* () {
                  const sessions = yield* makeTerminalHostSessions(options)
                  yield* makeTerminalHostServer({ ...options, sessions })
                }),
                scope
              )
            )
          }

          client = await Effect.runPromise(
            Scope.extend(
              TerminalHostClient.connect(socketPath, options.token, mode, mode),
              scope
            )
          )
          const engine = client
          let outputBytes = 0
          const completed = new Set<string>()
          let finishOutput!: () => void
          const outputFinished = new Promise<void>((resolve) => {
            finishOutput = resolve
          })
          const terminalIds = Array.from(
            { length: 4 },
            (_, index) => `terminal-${index}`
          )
          for (const terminalId of terminalIds) {
            await Effect.runPromise(
              engine.createTerminal({
                terminalId,
                worktreeId: 'benchmark',
                name: terminalId,
                createdAt: new Date().toISOString(),
                cwd: root,
                argv: [
                  process.execPath,
                  '-e',
                  `const timer = setInterval(() => { if (!require('fs').existsSync(${JSON.stringify(path.join(runtimeDir, 'go'))})) return; clearInterval(timer); const data = '\\x1b[32mhello🌲\\x1b[0m\\r\\n'.repeat(256); let n = 0; const write = () => { if (++n <= 512) process.stdout.write(data, () => setImmediate(write)); else process.stdout.write('BENCH_DONE'); }; write(); }, 10);`
                ],
                shellCommand: null,
                interactiveShell: false,
                closeOnSuccess: false,
                initialSize: { cols: 80, rows: 24 },
                env: {}
              })
            )
            await Effect.runPromise(
              Scope.extend(
                Effect.gen(function* () {
                  const attached = yield* engine.attach(terminalId)
                  if (!attached) {
                    throw new Error('Missing benchmark terminal')
                  }

                  let tail = ''
                  yield* Effect.forkScoped(
                    Stream.runForEach(attached.output, (output) =>
                      Effect.sync(() => {
                        outputBytes += Buffer.byteLength(output.data)
                        tail = (tail + output.data).slice(-64)
                        if (tail.includes('BENCH_DONE')) {
                          completed.add(terminalId)
                          if (completed.size === terminalIds.length) {
                            finishOutput()
                          }
                        }
                      })
                    )
                  )
                }),
                scope
              )
            )
          }
          let commands = 0
          const git = new GitAdapter({
            run: (request) => {
              commands++
              return runner.run(request)
            }
          })
          const latencies: number[] = []
          histogram.enable()
          const started = performance.now()
          let terminalMs = 0
          let gitMs = 0
          let httpMs = 0
          const utilization = performance.eventLoopUtilization()
          await fs.writeFile(path.join(runtimeDir, 'go'), '')
          await Promise.all([
            outputFinished.then(() => {
              terminalMs = performance.now() - started
            }),
            (async () => {
              for (let round = 0; round < 6; round++) {
                const patches = await Promise.all(
                  files.map((file) =>
                    Effect.runPromise(
                      git.worktreeFileDiff(root, 'main', file, 'uncommitted')
                    )
                  )
                )
                expect(
                  patches.every((patch) => patch.unified?.includes('+changed'))
                ).toBe(true)
              }
              gitMs = performance.now() - started
            })(),
            (async () => {
              for (let request = 0; request < 200; request++) {
                const begin = performance.now()
                const response = await fetch(url)
                expect(await response.text()).toBe('control')
                latencies.push(performance.now() - begin)
              }
              httpMs = performance.now() - started
            })()
          ])
          latencies.sort((a, b) => a - b)
          expect(outputBytes).toBeGreaterThan(0)
          measurements.push(
            JSON.stringify({
              mode,
              durationMs: performance.now() - started,
              terminalMs,
              gitMs,
              httpMs,
              commands,
              outputBytes,
              httpP99Ms: latencies[Math.floor(latencies.length * 0.99)],
              eventLoopP99Ms: histogram.percentile(99) / 1e6,
              eventLoopUtilization:
                performance.eventLoopUtilization(utilization).utilization
            })
          )
        } finally {
          histogram.disable()
          if (client) {
            await Effect.runPromise(client.killWorktree('benchmark'))
          }

          await Effect.runPromise(Scope.close(scope, Exit.void))
        }
      }
    } finally {
      if (process.env.MEASURE_TREEPORT_RESULTS) {
        await fs.writeFile(
          process.env.MEASURE_TREEPORT_RESULTS,
          measurements.join('\n') + '\n'
        )
      }

      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  60_000
)
