import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  connectOrStartTerminalHost,
  TerminalHostClient
} from './terminal-host-client'
import {
  encodeTerminalHostFrame,
  TERMINAL_HOST_PROTOCOL_VERSION,
  TerminalHostFrameDecoder
} from './terminal-host-protocol'

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

async function localTsxCli(): Promise<string> {
  const packageDirectory = (
    await fs.readdir(path.join(repositoryRoot, 'node_modules/.pnpm'))
  ).find((entry) => entry.startsWith('tsx@'))
  if (!packageDirectory) {
    throw new Error('The local tsx package is unavailable')
  }

  return path.join(
    repositoryRoot,
    'node_modules/.pnpm',
    packageDirectory,
    'node_modules/tsx/dist/cli.mjs'
  )
}

describe('detached terminal host lifecycle', () => {
  const roots: string[] = []
  const hostPids = new Set<number>()
  const clients = new Set<TerminalHostClient>()

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
        'apps/treeport/src/server/terminal-host-entry.ts'
      ),
      hostExecutable: process.execPath,
      hostArguments: [await localTsxCli()]
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

  it('refuses an incompatible live host without replacing or signaling it', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-terminal-host-incompatible-')
    )
    roots.push(root)
    const dataDir = path.join(root, 'data')
    const runtimeDir = path.join(root, 'runtime')
    const socketPath = path.join(root, 'host.sock')
    await Promise.all([
      fs.mkdir(dataDir, { recursive: true }),
      fs.mkdir(runtimeDir, { recursive: true })
    ])
    const hostKey = (await import('node:crypto'))
      .createHash('sha256')
      .update(path.resolve(dataDir))
      .digest('hex')
      .slice(0, 20)
    const server = net.createServer((socket) => {
      const decoder = new TerminalHostFrameDecoder()
      socket.on('data', (chunk) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.type !== 'request') {
            socket.destroy()
            return
          }

          socket.write(
            encodeTerminalHostFrame({
              protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION - 1,
              type: 'response',
              id: frame.id,
              // Historical hosts omitted result on failed responses.
              error: {
                code: 'INCOMPATIBLE_PROTOCOL',
                message: 'The live host uses an older protocol',
                hostProtocolVersion: TERMINAL_HOST_PROTOCOL_VERSION - 1,
                liveSessionCount: 1
              }
            })
          )
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    await fs.writeFile(
      path.join(runtimeDir, `terminal-host-${hostKey}.json`),
      JSON.stringify({
        protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION - 1,
        hostId: 'incompatible-live-host',
        hostKey,
        pid: process.pid,
        socketPath,
        startedAt: new Date().toISOString()
      })
    )
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
            'apps/treeport/src/server/terminal-host-entry.ts'
          ),
          spawnHost: spawnHost as never
        })
      ).rejects.toMatchObject({
        code: 'INCOMPATIBLE_PROTOCOL',
        hostProtocolVersion: TERMINAL_HOST_PROTOCOL_VERSION - 1,
        liveSessionCount: 1
      })
      expect(spawnHost).not.toHaveBeenCalled()
      expect(processExists(process.pid)).toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('does not unlink an unidentified socket that answers with another protocol', async () => {
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
    const server = net.createServer((socket) => {
      const decoder = new TerminalHostFrameDecoder()
      socket.on('data', (chunk) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.type !== 'request') {
            socket.destroy()
            return
          }

          socket.write(
            encodeTerminalHostFrame({
              protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION - 1,
              type: 'response',
              id: frame.id,
              result: {
                protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION - 1,
                hostId: 'unidentified-host',
                hostKey,
                pid: process.pid,
                socketPath,
                startedAt: new Date().toISOString(),
                liveSessionCount: 1
              },
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
            'apps/treeport/src/server/terminal-host-entry.ts'
          ),
          spawnHost: spawnHost as never
        })
      ).rejects.toMatchObject({
        code: 'INCOMPATIBLE_PROTOCOL',
        hostProtocolVersion: TERMINAL_HOST_PROTOCOL_VERSION - 1
      })
      expect(spawnHost).not.toHaveBeenCalled()
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
        protocolVersion: 1,
        hostId: 'unavailable-host',
        hostKey,
        pid: process.pid,
        socketPath: path.join(root, 'missing.sock'),
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
          'apps/treeport/src/server/terminal-host-entry.ts'
        ),
        hostExecutable: process.execPath
      })
    ).rejects.toThrow('will not signal it')
  })
})
