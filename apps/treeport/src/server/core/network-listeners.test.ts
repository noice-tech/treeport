import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandRequest, CommandResult, CommandRunner } from './command'
import { NetworkListenerAdapter } from './network-listeners'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

async function processFixture(
  procRoot: string,
  pid: number,
  ppid: number,
  command: string,
  cwd: string,
  inodes: string[] = []
) {
  const root = path.join(procRoot, String(pid))
  await fs.mkdir(path.join(root, 'fd'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'stat'),
    `${pid} (${command}) S ${ppid} 0 0 0\n`
  )
  await fs.writeFile(path.join(root, 'comm'), `${command}\n`)
  await fs.symlink(cwd, path.join(root, 'cwd'))
  await Promise.all(
    inodes.map((inode, index) =>
      fs.symlink(`socket:[${inode}]`, path.join(root, 'fd', String(index + 3)))
    )
  )
}

describe('NetworkListenerAdapter', () => {
  it('maps Linux sockets and conservatively scopes them by ancestry or cwd', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-listeners-'))
    temporary.push(root)
    const procRoot = path.join(root, 'proc')
    const worktree = path.join(root, 'repo')
    const otherWorktree = path.join(root, 'repo-copy')
    await Promise.all([
      fs.mkdir(path.join(procRoot, 'net'), { recursive: true }),
      fs.mkdir(worktree),
      fs.mkdir(otherWorktree)
    ])
    const header =
      'sl local_address rem_address st tx_queue tr tm->when retrnsmt uid timeout inode\n'
    await fs.writeFile(
      path.join(procRoot, 'net/tcp'),
      `${header} 0: 0100007F:0BB8 00000000:0000 0A 0:0 00:0 0 1000 0 111\n 1: 00000000:143D 00000000:0000 0A 0:0 00:0 0 1000 0 222\n 2: 0100007F:1F90 00000000:0000 01 0:0 00:0 0 1000 0 999\n 3: 0100007F:2328 00000000:0000 0A 0:0 00:0 0 1000 0 333\n`
    )
    await fs.writeFile(path.join(procRoot, 'net/tcp6'), header)
    await processFixture(procRoot, 100, 1, 'zsh', root)
    await processFixture(procRoot, 101, 100, 'vite', root, ['111'])
    await processFixture(procRoot, 200, 1, 'python', worktree, ['222'])
    await processFixture(procRoot, 300, 1, 'other', otherWorktree, ['333'])

    const result = await new NetworkListenerAdapter(
      { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      'linux',
      procRoot
    ).listeners({
      worktreePath: worktree,
      panes: [{ pid: 100, terminalId: 'term_dev' }]
    })

    expect(result).toEqual({
      supported: true,
      message: null,
      listeners: [
        {
          pid: 101,
          command: 'vite',
          host: '127.0.0.1',
          port: 3000,
          terminalId: 'term_dev'
        },
        {
          pid: 200,
          command: 'python',
          host: '0.0.0.0',
          port: 5181,
          terminalId: null
        }
      ]
    })
  })

  it('parses macOS listener, ancestry, and cwd output', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-listeners-'))
    temporary.push(root)
    const worktree = path.join(root, 'repo')
    await fs.mkdir(worktree)
    class Runner implements CommandRunner {
      async run(request: CommandRequest): Promise<CommandResult> {
        if (request.executable === '/bin/ps') {
          return {
            stdout: ' 100 1\n 101 100\n 200 1\n',
            stderr: '',
            exitCode: 0
          }
        }

        if (request.args.includes('-iTCP')) {
          return {
            stdout: 'p101\ncvite\nn*:4173\np200\ncpython\nn[::1]:8000\n',
            stderr: '',
            exitCode: 0
          }
        }

        return {
          stdout: `p101\nn${root}\np200\nn${worktree}\n`,
          stderr: '',
          exitCode: 0
        }
      }
    }

    await expect(
      new NetworkListenerAdapter(new Runner(), 'darwin').listeners({
        worktreePath: worktree,
        panes: [{ pid: 100, terminalId: 'term_dev' }]
      })
    ).resolves.toEqual({
      supported: true,
      message: null,
      listeners: [
        {
          pid: 101,
          command: 'vite',
          host: '*',
          port: 4173,
          terminalId: 'term_dev'
        },
        {
          pid: 200,
          command: 'python',
          host: '::1',
          port: 8000,
          terminalId: null
        }
      ]
    })
  })

  it('reports unsupported platforms without scanning', async () => {
    const runner: CommandRunner = {
      run: async () => {
        throw new Error('must not run')
      }
    }
    await expect(
      new NetworkListenerAdapter(runner, 'win32').listeners({
        worktreePath: '/repo',
        panes: []
      })
    ).resolves.toEqual({
      supported: false,
      message: 'TCP listener discovery is not supported on this platform.',
      listeners: []
    })
  })
})
