import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { terminalHostRecordSchema } from './terminal-host-protocol'
import { TerminalHostSessionManager } from './terminal-host-sessions'

const execute = promisify(execFile)
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..'
)
const treeportCli = path.join(repositoryRoot, 'apps/treeport/bin/treeport.mjs')
const temporaryDirectories: string[] = []
const cleanupProcesses: number[] = []
const registeredProjectSchema = z.object({
  project: z.object({
    worktrees: z.array(z.object({ id: z.string() })).min(1)
  })
})
const createdTerminalSchema = z.object({
  terminal: z.object({ id: z.string() })
})
const daemonStatusSchema = z.object({
  state: z.object({ pid: z.number().int().positive() })
})
const captureSchema = z.object({ content: z.string() })

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor<Value>(
  read: () => Promise<Value | null>
): Promise<Value> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null) {
      return value
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for terminal lifecycle state')
}

async function reservePort(): Promise<number> {
  const server = http.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address) {
    throw new Error('Could not reserve a daemon port')
  }

  // SAFETY: This server listened on a TCP host, so Node returns AddressInfo.
  const port = (address as AddressInfo).port

  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return port
}

afterEach(async () => {
  for (const pid of cleanupProcesses.splice(0)) {
    if (processExists(pid)) {
      process.kill(pid, 'SIGKILL')
    }
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('detached terminal host lifecycle', () => {
  it('keeps a child and canonical history across crashed and normally restarted API daemon processes', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-host-restart-')
    )
    temporaryDirectories.push(root)
    const repository = path.join(root, 'repository')
    const dataDir = path.join(root, 'data')
    const runtimeDir = path.join(root, 'runtime')
    await fs.mkdir(repository)
    await execute('git', ['init', '-b', 'main'], { cwd: repository })
    await execute('git', ['config', 'user.name', 'Treeport test'], {
      cwd: repository
    })
    await execute('git', ['config', 'user.email', 'treeport@example.test'], {
      cwd: repository
    })
    await fs.writeFile(path.join(repository, 'README.md'), '# host restart\n')
    await execute('git', ['add', 'README.md'], { cwd: repository })
    await execute('git', ['commit', '-m', 'Initial'], { cwd: repository })

    const port = await reservePort()
    const apiUrl = `http://127.0.0.1:${port}`
    const environment: NodeJS.ProcessEnv = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      SHELL: process.env.SHELL,
      TMPDIR: process.env.TMPDIR,
      TREEPORT_API_URL: '',
      TREEPORT_HOST: '127.0.0.1',
      TREEPORT_PORT: String(port),
      TREEPORT_DATA_DIR: dataDir,
      TREEPORT_RUNTIME_DIR: runtimeDir,
      TREEPORT_GIT_PATH: (await execute('which', ['git'])).stdout.trim()
    }
    const runCli = (args: string[]) =>
      execute(process.execPath, [treeportCli, ...args], {
        env: environment,
        timeout: 15_000
      })

    const stopDestructively = async () => {
      await runCli(['start']).catch(() => undefined)
      await runCli(['stop', '--terminate-terminals', '--force']).catch(
        () => undefined
      )
    }

    try {
      await runCli(['start'])
      const registered = registeredProjectSchema.parse(
        await fetch(`${apiUrl}/api/projects`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: repository })
        }).then((response) => response.json())
      )
      const worktreeId = registered.project.worktrees[0]?.id
      if (!worktreeId) {
        throw new Error('Registered project did not have a worktree')
      }

      const childProgram = [
        "let line=0; process.stdout.write('terminal-before-restart\\n');",
        'setInterval(() => process.stdout.write(`host-line-${++line}\\n`), 50)'
      ].join('')
      const created = createdTerminalSchema.parse(
        await fetch(`${apiUrl}/api/worktrees/${worktreeId}/terminals`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Restart survivor',
            argv: [process.execPath, '-e', childProgram]
          })
        }).then((response) => response.json())
      )
      const terminalId = created.terminal.id
      await waitFor(async () => {
        const capture = captureSchema.parse(
          await fetch(
            `${apiUrl}/api/terminals/${terminalId}/capture?lines=200`
          ).then((response) => response.json())
        )
        return capture.content.includes('host-line-3') ? capture.content : null
      })

      const firstStatus = daemonStatusSchema.parse(
        JSON.parse((await runCli(['status', '--json'])).stdout)
      )
      const firstDaemonPid = firstStatus.state.pid
      process.kill(firstDaemonPid, 'SIGKILL')
      await waitFor(async () => (processExists(firstDaemonPid) ? null : true))

      await runCli(['start'])
      const afterCrash = await waitFor(async () => {
        const response = await fetch(
          `${apiUrl}/api/terminals/${terminalId}/capture?lines=200`
        ).catch(() => null)
        if (!response?.ok) {
          return null
        }

        const capture = captureSchema.parse(await response.json())
        return capture.content.includes('host-line-8') ? capture.content : null
      })
      expect(afterCrash).toContain('terminal-before-restart')
      const secondStatus = daemonStatusSchema.parse(
        JSON.parse((await runCli(['status', '--json'])).stdout)
      )
      expect(secondStatus.state.pid).not.toBe(firstDaemonPid)

      await runCli(['stop'])
      await runCli(['start'])
      const afterNormalRestart = await waitFor(async () => {
        const response = await fetch(
          `${apiUrl}/api/terminals/${terminalId}/capture?lines=200`
        ).catch(() => null)
        if (!response?.ok) {
          return null
        }

        const capture = captureSchema.parse(await response.json())
        return capture.content.includes('host-line-12') ? capture.content : null
      })
      expect(afterNormalRestart).toContain('terminal-before-restart')

      const removed = await fetch(`${apiUrl}/api/terminals/${terminalId}`, {
        method: 'DELETE'
      })
      expect(removed.ok).toBe(true)
      await stopDestructively()
    } finally {
      await stopDestructively()
      const records = await fs.readdir(runtimeDir).catch(() => [])
      for (const name of records.filter(
        (entry) => entry.startsWith('terminal-host-') && entry.endsWith('.json')
      )) {
        const record = terminalHostRecordSchema.parse(
          JSON.parse(await fs.readFile(path.join(runtimeDir, name), 'utf8'))
        )
        if (Number.isInteger(record.pid) && processExists(record.pid)) {
          process.kill(record.pid, 'SIGTERM')
        }
      }
    }
  }, 45_000)

  it('kills detached descendants when a hosted terminal is removed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-host-tree-'))
    temporaryDirectories.push(root)
    const descendantPath = path.join(root, 'descendant.pid')
    const launcherPath = path.join(root, 'launcher.mjs')
    const descendantProgram =
      "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"
    await fs.writeFile(
      launcherPath,
      `import { spawn } from 'node:child_process'\n` +
        `import fs from 'node:fs'\n` +
        `const child=spawn(process.execPath,['-e',${JSON.stringify(descendantProgram)}],{detached:true,stdio:'ignore'})\n` +
        `fs.writeFileSync(${JSON.stringify(descendantPath)},String(child.pid))\n` +
        `setInterval(()=>{},1000)\n`
    )
    const manager = new TerminalHostSessionManager(root, launcherPath)
    await manager.createTerminal({
      terminalId: 'tree',
      worktreeId: 'worktree',
      name: 'Tree',
      createdAt: new Date().toISOString(),
      cwd: root,
      argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
      shellCommand: null,
      interactiveShell: false,
      env: {}
    })
    const descendantPid = await waitFor(async () =>
      fs
        .readFile(descendantPath, 'utf8')
        .then((value) => Number(value))
        .catch(() => null)
    )
    cleanupProcesses.push(descendantPid)
    expect(processExists(descendantPid)).toBe(true)

    await manager.killTerminal('tree')
    await waitFor(async () => (processExists(descendantPid) ? null : true))
    cleanupProcesses.splice(cleanupProcesses.indexOf(descendantPid), 1)
    await expect(manager.terminalState('tree')).resolves.toEqual({
      status: 'missing',
      exitCode: null
    })
    await manager.shutdown()
  })
})
