import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import { getSessionKeeperPayload } from '@treeport/session-keeper'
import type { TerminalRecord, TerminalRuntimeMetadata } from '@treeport/shared'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductEventBus, type TreeportService } from '../server/core/index'
import { makeRpcHttpApp } from '../server/rpc-server'
import { testAccess } from '../server/test-access'
import type { TerminalMetadataManager } from '../server/terminal-metadata'
import { WorkspacePresenceManager } from '../server/workspace-presence'
import { TerminalHostSessions } from '../terminal-runtime/sessions'
import { runCliApplication } from './application'

interface TerminalObservation {
  terminal: TerminalRecord
  metadata: TerminalRuntimeMetadata
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

async function fixture() {
  const events = new ProductEventBus()
  const presence = new WorkspacePresenceManager(events)
  const observation: TerminalObservation = {
    terminal: {
      id: 'term',
      worktreeId: 'tree',
      name: 'Command',
      argv: ['bash'],
      shellCommand: null,
      interactiveShell: false,
      status: 'running',
      exitCode: null,
      commandExitCode: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    metadata: {
      terminalId: 'term',
      title: null,
      program: null,
      progress: null,
      progressStartedAt: null,
      progressClearedAt: null,
      bell: null
    }
  }
  const inspect = vi.fn(async () => observation)
  const snapshot = vi.fn(() => [observation.metadata])
  const service = testAccess<TreeportService>({
    events,
    apps: {
      listWebApps: () => Effect.succeed([]),
      listBrowserApps: () => Effect.succeed([])
    },
    runEffect: (effect: Effect.Effect<unknown, unknown, never>) =>
      Effect.runPromise(effect)
  })
  const scope = await Effect.runPromise(Scope.make())
  const app = await service.runEffect(
    Scope.extend(
      makeRpcHttpApp(
        service,
        testAccess<TerminalMetadataManager>({ snapshot }),
        presence
      ),
      scope
    )
  )
  const rpc = await Effect.runPromise(NodeHttpServer.makeHandler(app))
  const server = http.createServer((request, response) => {
    if (request.url === '/api/terminals/term') {
      void inspect().then((value) => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(value))
      })
    } else {
      rpc(request, response)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // SAFETY: The fixture has just bound a TCP port on the loopback interface.
  const address = server.address() as AddressInfo
  const apiUrl = `http://127.0.0.1:${address.port}`
  cleanups.push(async () => {
    presence.dispose()
    await Effect.runPromise(Scope.close(scope, Exit.void))
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  })
  const wait = async (until = 'exit', timeout = '3s') => {
    let stdout = ''
    let stderr = ''
    const code = await runCliApplication({
      args: [
        'terminal',
        'wait',
        'term',
        '--until',
        until,
        '--timeout',
        timeout,
        '--json'
      ],
      environment: { TREEPORT_API_URL: apiUrl },
      stdout: (value) => {
        stdout += value
      },
      stderr: (value) => {
        stderr += value
      }
    })
    return { code, stdout, stderr }
  }
  const updated = () =>
    events.publish('terminal.updated', {
      terminalId: 'term',
      worktreeId: 'tree'
    })
  const metadata = () =>
    events.publish('terminal.metadata', observation.metadata)
  return { observation, inspect, snapshot, wait, updated, metadata, events }
}

async function runtimeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-wait-exit-'))
  const options = {
    runtimeDir: root,
    launcherPath: path.resolve(
      import.meta.dirname,
      '../../dist/node/server/core/launcher.js'
    ),
    sessionExecutable: getSessionKeeperPayload()
  }
  let scope = await Effect.runPromise(Scope.make())
  let manager = await Effect.runPromise(
    Scope.extend(TerminalHostSessions.make(options), scope)
  )
  cleanups.push(async () => {
    await Effect.runPromise(manager.killWorktree('tree'))
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await fs.rm(root, { recursive: true, force: true })
  })
  const value = await fixture()
  value.inspect.mockImplementation(async () => {
    const terminals = await Effect.runPromise(manager.listTerminals('tree'))
    const {
      closeOnSuccess: _closeOnSuccess,
      closeOnExit: _closeOnExit,
      ...terminal
    } = terminals[0]!
    return { terminal, metadata: value.observation.metadata }
  })
  const subscribe = async () => {
    await Effect.runPromise(
      Scope.extend(
        Effect.forkScoped(
          Stream.runForEach(manager.runtimeEvents('term'), (event) =>
            Effect.sync(() => {
              if (
                event.commandExitCode != null ||
                event.exitCode !== undefined
              ) {
                value.updated()
              }
            })
          )
        ),
        scope
      )
    )
  }
  return {
    ...value,
    root,
    manager: () => manager,
    start: async (exitCode: number, fallback = true) => {
      await Effect.runPromise(
        manager.createTerminal({
          terminalId: 'term',
          worktreeId: 'tree',
          name: 'Command',
          createdAt: new Date().toISOString(),
          cwd: root,
          argv: [
            'bash',
            '-c',
            `printf 'COMMAND_STARTED\\n'; while [ ! -f finish ]; do sleep 0.02; done; printf 'WAIT_EXIT_REPRO_COMMAND_FINISHED\\n'; exit ${exitCode}`
          ],
          shellCommand: null,
          interactiveShell: false,
          fallbackArgv: fallback
            ? ['bash', '--noprofile', '--norc', '-i']
            : undefined,
          env: { HOME: root, PS1: 'FALLBACK_READY> ' }
        })
      )
      await subscribe()
      await vi.waitFor(async () =>
        expect(
          await Effect.runPromise(manager.captureTerminal('term', 20))
        ).toContain('COMMAND_STARTED')
      )
    },
    finish: () => fs.writeFile(path.join(root, 'finish'), ''),
    reconnect: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      scope = await Effect.runPromise(Scope.make())
      manager = await Effect.runPromise(
        Scope.extend(TerminalHostSessions.make(options), scope)
      )
      await subscribe()
    },
    detach: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    input: async (text: string) => {
      const transition = await Effect.runPromise(
        manager.prepareQueryAuthority('term')
      )
      await Effect.runPromise(
        manager.activateQueryAuthority(
          'term',
          transition!.transitionId,
          'test',
          1,
          null
        )
      )
      await Effect.runPromise(
        manager.write('term', text, { attachmentId: 'test', generation: 1 })
      )
    }
  }
}

describe('terminal wait CLI observations and event races', () => {
  it.each([0, 7])(
    'resolves an already completed command (%i) without subscribing',
    async (commandExitCode) => {
      const value = await fixture()
      value.observation.terminal.commandExitCode = commandExitCode
      const result = await value.wait()
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        condition: 'exit',
        terminal: { status: 'running', exitCode: null, commandExitCode }
      })
      expect(value.snapshot).not.toHaveBeenCalled()
    }
  )

  it('resolves an already exited terminal without command completion data', async () => {
    const value = await fixture()
    value.observation.terminal.status = 'exited'
    value.observation.terminal.exitCode = 4
    delete value.observation.terminal.commandExitCode
    expect((await value.wait()).code).toBe(0)
  })

  it('rechecks command completion between initial inspection and subscription', async () => {
    const value = await fixture()
    value.snapshot.mockImplementation(() => {
      value.observation.terminal.commandExitCode = 7
      // No event is delivered: it occurred before subscription's snapshot fence.
      return [value.observation.metadata]
    })
    const result = await value.wait()
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).terminal.commandExitCode).toBe(7)
    expect(value.inspect).toHaveBeenCalledTimes(2)
  })

  it('handles a completion event queued during the snapshot refresh', async () => {
    const value = await fixture()
    const initial = structuredClone(value.observation)
    value.inspect
      .mockImplementationOnce(async () => initial)
      .mockImplementationOnce(async () => {
        value.observation.terminal.commandExitCode = 0
        value.updated()
        return initial
      })
    const result = await value.wait()
    expect(result.code).toBe(0)
    expect(value.inspect).toHaveBeenCalledTimes(3)
    expect(JSON.parse(result.stdout).terminal.commandExitCode).toBe(0)
  })

  it('observes actual terminal exit events', async () => {
    const value = await fixture()
    const pending = value.wait()
    await vi.waitFor(() => expect(value.inspect).toHaveBeenCalledTimes(2))
    value.observation.terminal.status = 'exited'
    value.observation.terminal.exitCode = 9
    value.updated()
    expect((await pending).code).toBe(0)
  })

  it('does not treat title, idle progress, or bells as command completion', async () => {
    const value = await fixture()
    const pending = value.wait('exit', '200ms')
    await vi.waitFor(() => expect(value.inspect).toHaveBeenCalledTimes(2))
    value.observation.metadata.title = 'finished'
    value.observation.metadata.bell = {
      sequence: 1,
      at: new Date().toISOString(),
      unread: true
    }
    value.metadata()
    const result = await pending
    expect(result.code).toBe(4)
    expect(JSON.parse(result.stderr).error.code).toBe('WAIT_TIMEOUT')
  })

  it.each(['idle', 'working', 'bell'])(
    'preserves %s wait semantics after command completion',
    async (condition) => {
      const value = await fixture()
      value.observation.terminal.commandExitCode = 7
      value.observation.metadata.progress =
        condition === 'idle' ? { state: 'normal', value: 1 } : null
      value.observation.metadata.bell = {
        sequence: 3,
        at: new Date().toISOString(),
        unread: true
      }
      const pending = value.wait(condition)
      await vi.waitFor(() => expect(value.inspect).toHaveBeenCalledTimes(2))
      value.observation.metadata.progress =
        condition === 'working' ? { state: 'normal', value: 2 } : null
      value.observation.metadata.bell = {
        sequence: 4,
        at: new Date().toISOString(),
        unread: true
      }
      value.metadata()
      const result = await pending
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout).condition).toBe(condition)
    }
  )
})

describe('launcher, persistent PTY, and CLI wait lifecycle', () => {
  it.each([0, 7])(
    'waits for program exit %i while preserving a usable fallback shell and independent session exit',
    async (commandExitCode) => {
      const value = await runtimeFixture()
      await value.start(commandExitCode)
      const pending = value.wait()
      await vi.waitFor(() => expect(value.inspect).toHaveBeenCalledTimes(2))
      await value.finish()
      const result = await pending
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        terminal: { status: 'running', exitCode: null, commandExitCode }
      })
      await value.input("printf 'SHELL_%s\\n' USABLE\r")
      await vi.waitFor(async () =>
        expect(
          await Effect.runPromise(value.manager().captureTerminal('term', 20))
        ).toContain('SHELL_USABLE')
      )
      expect((await value.wait()).code).toBe(0)
      await value.reconnect()
      expect(JSON.parse((await value.wait()).stdout).terminal).toMatchObject({
        status: 'running',
        exitCode: null,
        commandExitCode
      })
      await value.input('exit 3\r')
      await vi.waitFor(async () =>
        expect(
          await Effect.runPromise(value.manager().terminalState('term'))
        ).toMatchObject({ status: 'exited', exitCode: 3, commandExitCode })
      )
      await value.reconnect()
      expect(JSON.parse((await value.wait()).stdout).terminal).toMatchObject({
        status: 'exited',
        exitCode: 3,
        commandExitCode
      })
    }
  )

  it('does not treat commands typed inside an interactive shell as the launched process exiting', async () => {
    const value = await runtimeFixture()
    await Effect.runPromise(
      value.manager().createTerminal({
        terminalId: 'term',
        worktreeId: 'tree',
        name: 'Shell',
        createdAt: new Date().toISOString(),
        cwd: value.root,
        argv: ['bash', '--noprofile', '--norc', '-i'],
        shellCommand: null,
        interactiveShell: true,
        env: { HOME: value.root }
      })
    )
    await value.input("printf 'TYPED_%s\\n' FINISHED\r")
    await vi.waitFor(async () =>
      expect(
        await Effect.runPromise(value.manager().captureTerminal('term', 20))
      ).toContain('TYPED_FINISHED')
    )
    const result = await value.wait('exit', '200ms')
    expect(result.code).toBe(4)
    expect(
      await Effect.runPromise(value.manager().terminalState('term'))
    ).toMatchObject({
      status: 'running',
      commandExitCode: null
    })
    await value.input('exit 5\r')
    await vi.waitFor(async () =>
      expect(
        await Effect.runPromise(value.manager().terminalState('term'))
      ).toMatchObject({ status: 'exited', exitCode: 5 })
    )
    expect((await value.wait()).code).toBe(0)
  })

  it('restores completion that happened while the engine was detached', async () => {
    const value = await runtimeFixture()
    await value.start(7)
    await value.detach()
    await value.finish()
    await vi.waitFor(async () => {
      const names = await fs.readdir(path.join(value.root, 'terminal-specs'))
      expect(names.some((name) => name.endsWith('.result'))).toBe(true)
    })
    await value.reconnect()
    expect(JSON.parse((await value.wait()).stdout).terminal).toMatchObject({
      status: 'running',
      exitCode: null,
      commandExitCode: 7
    })
  })

  it('times out while the real program still runs, then observes its actual terminal exit', async () => {
    const value = await runtimeFixture()
    await value.start(7, false)
    const result = await value.wait('exit', '200ms')
    expect(result.code).toBe(4)
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: 'WAIT_TIMEOUT',
      details: {
        lastObservation: {
          terminal: { status: 'running', commandExitCode: null }
        }
      }
    })
    await value.finish()
    await vi.waitFor(async () =>
      expect(
        await Effect.runPromise(value.manager().terminalState('term'))
      ).toMatchObject({ status: 'exited', exitCode: 7 })
    )
    expect((await value.wait()).code).toBe(0)
  })
})
