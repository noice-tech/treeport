import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TerminalHostSessionManager } from './terminal-host-sessions'

const launcherPath = fileURLToPath(
  new URL('../../dist/node/server/core/launcher.js', import.meta.url)
)
let root: string
let socketPath: string
let launchctlPath: string
let agent: net.Server
let manager: TerminalHostSessionManager

beforeEach(async () => {
  // Keep Unix socket paths below the macOS length limit.
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'tp-ssh-'))
  socketPath = path.join(root, 'agent.sock')
  agent = net.createServer((socket) => socket.end())
  await new Promise<void>((resolve) => agent.listen(socketPath, resolve))
  launchctlPath = path.join(root, 'launchctl')
  // A fixture replaces only the external OS command. Use real subprocesses,
  // socket checks, PTYs, the launcher, and shell integration on every path.
  await fs.writeFile(
    launchctlPath,
    `#!/bin/sh
printf '%s %s\\n' "$1" "$2" >> '${root}/calls'
/bin/cat '${root}/socket'
`,
    { mode: 0o700 }
  )
  await fs.writeFile(path.join(root, 'socket'), `${socketPath}\n`)
  manager = new TerminalHostSessionManager(
    root,
    launcherPath,
    undefined,
    undefined,
    undefined,
    { platform: 'darwin', launchctlPath }
  )
  vi.stubEnv('SSH_AUTH_SOCK', undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(async () => {
  await manager.shutdown()
  await new Promise<void>((resolve, reject) =>
    agent.close((error) => (error ? reject(error) : resolve()))
  )
  await fs.rm(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function launch(
  interactiveShell: boolean,
  expected: string | undefined,
  env: Record<string, string> = {}
) {
  const terminalId = `term-${manager.sessionCount}`
  const probe = `process.stdout.write('agent=' + JSON.stringify(process.env.SSH_AUTH_SOCK) + '\\n')`
  await manager.createTerminal({
    terminalId,
    worktreeId: 'worktree',
    name: 'SSH environment probe',
    createdAt: new Date().toISOString(),
    cwd: root,
    argv: interactiveShell
      ? ['/bin/bash', '-l']
      : [process.execPath, '-e', probe],
    shellCommand: null,
    interactiveShell,
    env: { HOME: root, ...env }
  })
  if (interactiveShell) {
    const authority = await manager.prepareQueryAuthority(terminalId)
    await manager.activateQueryAuthority(
      terminalId,
      authority.transitionId,
      'test',
      1
    )
    await manager.write(
      terminalId,
      `'${process.execPath}' -e '${probe.replaceAll("'", "'\\''")}'\r`,
      { attachmentId: 'test', generation: 1 }
    )
  }

  await vi.waitFor(
    async () => {
      expect(await manager.captureTerminal(terminalId, 30)).toContain(
        `agent=${JSON.stringify(expected)}`
      )
    },
    { timeout: 5_000 }
  )
}

it.for([false, true])(
  'discovers an agent at launch (interactive shell: %s)',
  async (interactiveShell) => {
    await launch(interactiveShell, socketPath)
    expect(process.env.SSH_AUTH_SOCK).toBeUndefined()
    // No cached discovery: a persistent host must see the next login's socket.
    const nextSocket = path.join(root, 'next.sock')
    await fs.symlink(socketPath, nextSocket)
    await fs.writeFile(path.join(root, 'socket'), `${nextSocket}\n`)
    await launch(interactiveShell, nextSocket)
    expect(await fs.readFile(path.join(root, 'calls'), 'utf8')).toBe(
      'getenv SSH_AUTH_SOCK\ngetenv SSH_AUTH_SOCK\n'
    )
  }
)

it.for([false, true])(
  'preserves explicit and inherited agents (interactive shell: %s)',
  async (interactiveShell) => {
    await launch(interactiveShell, '/custom/explicit', {
      SSH_AUTH_SOCK: '/custom/explicit'
    })
    await launch(interactiveShell, '', { SSH_AUTH_SOCK: '' })
    vi.stubEnv('SSH_AUTH_SOCK', '/custom/inherited')
    await launch(interactiveShell, '/custom/inherited')
    await launch(interactiveShell, '/custom/override', {
      SSH_AUTH_SOCK: '/custom/override'
    })
    vi.stubEnv('SSH_AUTH_SOCK', '')
    await launch(interactiveShell, '')
    await expect(fs.stat(path.join(root, 'calls'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  }
)

it('does not discover a Mac agent on Linux hosts', async () => {
  manager = new TerminalHostSessionManager(
    root,
    launcherPath,
    undefined,
    undefined,
    undefined,
    { platform: 'linux', launchctlPath }
  )
  await launch(false, undefined)
  await expect(fs.stat(path.join(root, 'calls'))).rejects.toMatchObject({
    code: 'ENOENT'
  })
})

it.for([
  'empty',
  'missing',
  'file',
  'relative',
  'unavailable',
  'timeout'
] as const)(
  'launches without an agent when discovery is %s',
  async (failure) => {
    if (failure === 'unavailable') {
      await fs.rm(launchctlPath)
    } else if (failure === 'timeout') {
      await fs.writeFile(launchctlPath, '#!/bin/sh\nexec /bin/sleep 10\n')
    } else {
      const regularFile = path.join(root, 'not-a-socket')
      await fs.writeFile(regularFile, '')
      await fs.writeFile(
        path.join(root, 'socket'),
        {
          empty: '\n',
          missing: path.join(root, 'missing.sock'),
          file: regularFile,
          relative: 'relative.sock'
        }[failure]
      )
    }

    const started = Date.now()
    await launch(false, undefined)
    expect(Date.now() - started).toBeLessThan(5_000)
    if (failure === 'empty') {
      expect(console.warn).not.toHaveBeenCalled()
    } else {
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('SSH_AUTH_SOCK')
      )
    }
  }
)
