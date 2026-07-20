import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn as spawnChild } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import * as nodePty from 'node-pty'
import {
  resolveExecutablePath,
  SpawnCommandRunner,
  runChecked
} from './command.js'
import { loadConfig } from './config.js'
import { TaskTTYDatabase } from './database.js'
import { GhAdapter } from './gh.js'
import { GitAdapter } from './git.js'
import { TaskTTYService } from './service.js'
import { TMUX_SCROLL_EXIT_SEQUENCE, TmuxAdapter } from './tmux.js'

const enabled = process.env.TASKTTY_REAL_INTEGRATION === '1'
const root = path.join(os.tmpdir(), `tasktty real integration ${process.pid}`)
afterAll(async () => fs.rm(root, { recursive: true, force: true }))

async function executable(command: string, args: string[]) {
  return new Promise<boolean>((resolve) => {
    const child = spawnChild(command, args, { stdio: 'ignore' })
    child.once('error', () => resolve(false))
    child.once('exit', (code) => resolve(code === 0))
  })
}

function ptyEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && key !== 'TMUX' && key !== 'TMUX_PANE'
    )
  ) as Record<string, string>
}

async function waitOperation(service: TaskTTYService, operationId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const operation = service.getOperation(operationId)
    if (operation.status === 'completed' || operation.status === 'failed') {
      return operation
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('cleanup operation timed out')
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  message: string
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

async function makeService(databasePath: string, runtimeDir: string) {
  const config = loadConfig({
    TASKTTY_DATABASE_PATH: databasePath,
    TASKTTY_RUNTIME_DIR: runtimeDir,
    TASKTTY_DATA_DIR: root,
    TASKTTY_SHELL: process.env.SHELL || '/bin/sh'
  })
  const runner = new SpawnCommandRunner()
  const database = new TaskTTYDatabase(databasePath)
  const git = new GitAdapter(runner)
  const launcherPath = fileURLToPath(
    new URL('../dist/launcher.js', import.meta.url)
  )
  const tmux = new TmuxAdapter(runner, runtimeDir, 'tmux', launcherPath)
  const gh = new GhAdapter(runner)
  const service = new TaskTTYService({
    config,
    database,
    runner,
    git,
    tmux,
    gh
  })
  await service.initialize()
  return { service, database, tmux, runner }
}

describe.skipIf(!enabled)(
  'real Git, Zed-style worktrees, and tmux lifecycle',
  () => {
    it('persists two sessions across attachment and daemon restart, then removes them safely', async (context) => {
      if (
        !(await executable('git', ['--version'])) ||
        !(await executable('tmux', ['-V']))
      ) {
        context.skip()
        return
      }

      await fs.mkdir(root, { recursive: true })
      const main = path.join(root, 'main checkout with spaces')
      const remote = path.join(root, 'remote origin.git')
      const databasePath = path.join(root, 'metadata', 'tasktty.db')
      const runtimeDir = path.join(root, 'runtime')
      const command = new SpawnCommandRunner()
      await runChecked(command, {
        executable: 'git',
        args: ['init', '--bare', remote]
      })
      await runChecked(command, {
        executable: 'git',
        args: ['init', '-b', 'trunk', main]
      })
      await runChecked(command, {
        executable: 'git',
        args: ['config', 'user.email', 'tasktty@example.test'],
        cwd: main
      })
      await runChecked(command, {
        executable: 'git',
        args: ['config', 'user.name', 'tasktty test'],
        cwd: main
      })
      await fs.writeFile(path.join(main, 'README.md'), 'fixture\n')
      await fs.mkdir(path.join(main, '.zed'), { recursive: true })
      await fs.writeFile(
        path.join(main, '.zed', 'tasks.json'),
        JSON.stringify([
          {
            label: 'first setup',
            command: process.execPath,
            args: ['-e', "console.log('SETUP_ONE')"],
            hooks: ['create_worktree']
          },
          {
            label: 'second setup',
            command: process.execPath,
            args: ['-e', "console.error('SETUP_TWO')"],
            hooks: ['create_worktree']
          }
        ])
      )
      await runChecked(command, {
        executable: 'git',
        args: ['add', 'README.md', '.zed/tasks.json'],
        cwd: main
      })
      await runChecked(command, {
        executable: 'git',
        args: ['commit', '-m', 'initial'],
        cwd: main
      })
      await runChecked(command, {
        executable: 'git',
        args: ['remote', 'add', 'origin', remote],
        cwd: main
      })
      await runChecked(command, {
        executable: 'git',
        args: ['push', '-u', 'origin', 'trunk'],
        cwd: main
      })
      await runChecked(command, {
        executable: 'git',
        args: ['symbolic-ref', 'HEAD', 'refs/heads/trunk'],
        cwd: remote
      })
      await runChecked(command, {
        executable: 'git',
        args: [
          'symbolic-ref',
          'refs/remotes/origin/HEAD',
          'refs/remotes/origin/trunk'
        ],
        cwd: main
      })

      let fixture = await makeService(databasePath, runtimeDir)
      const project = await fixture.service.registerProject(main)
      const created = await fixture.service.createWorktree(
        project.id,
        'real-topic',
        'default',
        {
          name: 'Pi-like',
          argv: [
            process.execPath,
            '-e',
            "console.log('PI_LIKE');setInterval(()=>{},1000)"
          ]
        }
      )
      const linked = created.worktree
      const first = created.terminal!
      const second = await fixture.service.createTerminal(
        linked.id,
        'Dev-like',
        [
          process.execPath,
          '-e',
          "console.log('DEV_LIKE');setInterval(()=>{},1000)"
        ]
      )
      expect(
        await fixture.tmux.sessionState(
          linked.tmuxSocketName,
          first.tmuxSessionName
        )
      ).toMatchObject({ status: 'running' })
      expect(
        await fixture.tmux.sessionState(
          linked.tmuxSocketName,
          second.tmuxSessionName
        )
      ).toMatchObject({ status: 'running' })

      const attachAndDetach = async (sessionName: string, expected: string) => {
        const client = nodePty.spawn(
          resolveExecutablePath('tmux'),
          fixture.tmux.attachArgs(linked.tmuxSocketName, sessionName),
          {
            cwd: linked.path,
            env: ptyEnvironment(),
            name: 'xterm-256color',
            cols: 100,
            rows: 30
          }
        )
        let output = ''
        client.onData((data) => {
          output += data
        })
        for (
          let attempt = 0;
          attempt < 30 && !output.includes(expected);
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
        client.kill()
        expect(output).toContain(expected)
        return output
      }
      const setupOutput = await attachAndDetach(
        first.tmuxSessionName,
        'PI_LIKE'
      )
      expect(setupOutput.indexOf('SETUP_ONE')).toBeLessThan(
        setupOutput.indexOf('SETUP_TWO')
      )
      expect(setupOutput.indexOf('SETUP_TWO')).toBeLessThan(
        setupOutput.indexOf('PI_LIKE')
      )
      await attachAndDetach(second.tmuxSessionName, 'DEV_LIKE')
      expect(
        (await fixture.service.refreshTerminalStatus(first.id)).status
      ).toBe('running')

      fixture.database.close()
      fixture = await makeService(databasePath, runtimeDir)
      await attachAndDetach(first.tmuxSessionName, 'PI_LIKE')
      expect(
        (await fixture.service.refreshTerminalStatus(first.id)).status
      ).toBe('running')
      expect(
        (await fixture.service.refreshTerminalStatus(second.id)).status
      ).toBe('running')

      await fs.writeFile(
        path.join(main, '.zed', 'tasks.json'),
        JSON.stringify([
          {
            label: 'failure setup one',
            command: process.execPath,
            args: ['-e', "console.log('FAIL_SETUP_ONE')"],
            hooks: ['create_worktree']
          },
          {
            label: 'failure setup two',
            command: process.execPath,
            args: ['-e', "console.error('FAIL_SETUP_TWO');process.exit(17)"],
            hooks: ['create_worktree']
          },
          {
            label: 'skipped setup',
            command: process.execPath,
            args: ['-e', "console.log('SHOULD_NOT_RUN')"],
            hooks: ['create_worktree']
          }
        ])
      )
      const failedCreate = await fixture.service.createWorktree(
        project.id,
        'real-setup-failure',
        'default',
        {
          name: 'Failed setup',
          argv: [process.execPath, '-e', "console.log('FINAL_SHOULD_NOT_RUN')"]
        }
      )
      const failedWorktree = failedCreate.worktree
      const failedTerminal = failedCreate.terminal!
      let failedState = await fixture.tmux.sessionState(
        failedWorktree.tmuxSocketName,
        failedTerminal.tmuxSessionName
      )
      for (
        let attempt = 0;
        attempt < 100 && failedState.status !== 'exited';
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 30))
        failedState = await fixture.tmux.sessionState(
          failedWorktree.tmuxSocketName,
          failedTerminal.tmuxSessionName
        )
      }
      expect(failedState).toMatchObject({ status: 'exited', exitCode: 17 })
      const captured = await fixture.runner.run({
        executable: 'tmux',
        args: [
          '-L',
          failedWorktree.tmuxSocketName,
          '-f',
          fixture.tmux.configPath,
          'capture-pane',
          '-p',
          '-S',
          '-',
          '-t',
          failedTerminal.tmuxSessionName
        ]
      })
      expect(captured.exitCode).toBe(0)
      expect(captured.stdout).toContain('FAIL_SETUP_ONE')
      expect(captured.stdout).toContain('FAIL_SETUP_TWO')
      expect(captured.stdout).not.toContain('SHOULD_NOT_RUN')
      expect(captured.stdout).not.toContain('FINAL_SHOULD_NOT_RUN')
      expect(
        fixture.service
          .getProject(project.id)
          .worktrees.some((worktree) => worktree.id === failedWorktree.id)
      ).toBe(true)
      expect(
        (await fixture.service.refreshTerminalStatus(failedTerminal.id)).status
      ).toBe('exited')
      const failedPreview = await fixture.service.removePreview(
        failedWorktree.id
      )
      const failedRemoval = await fixture.service.beginRemove(
        failedWorktree.id,
        {
          confirmationToken: failedPreview.confirmationToken,
          confirmDestructive: failedPreview.warnings.length > 0
        }
      )
      expect(
        (await waitOperation(fixture.service, failedRemoval.id)).status
      ).toBe('completed')

      await fixture.service.deleteTerminal(first.id)
      expect(
        (await fixture.service.refreshTerminalStatus(second.id)).status
      ).toBe('running')

      await fs.writeFile(path.join(linked.path, 'dirty file.txt'), 'dirty')
      const dirtyPreview = await fixture.service.removePreview(linked.id)
      expect(dirtyPreview.forceRequired).toBe(true)
      expect(dirtyPreview.warnings.join(' ')).toMatch(/untracked/i)
      await fs.rm(path.join(linked.path, 'dirty file.txt'))

      const preview = await fixture.service.removePreview(linked.id)
      const accepted = await fixture.service.beginRemove(linked.id, {
        confirmationToken: preview.confirmationToken,
        confirmDestructive: preview.warnings.length > 0
      })
      const completed = await waitOperation(fixture.service, accepted.id)
      expect(completed.status).toBe('completed')
      expect(
        (
          await fixture.tmux.sessionState(
            linked.tmuxSocketName,
            second.tmuxSessionName
          )
        ).status
      ).toBe('missing')
      expect(fixture.service.getProject(project.id).worktrees).toHaveLength(1)
      expect(
        (
          await fixture.service.removePreview(
            fixture.service.getProject(project.id).worktrees[0]!.id
          )
        ).eligible
      ).toBe(false)
      fixture.database.close()
    })

    it('hides tmux copy mode and forwards the first key typed after scrolling', async (context) => {
      if (!(await executable('tmux', ['-V']))) {
        context.skip()
        return
      }

      const runtimeDir = path.join(root, 'scroll-runtime')
      const inputPath = path.join(root, 'scroll-input')
      const runner = new SpawnCommandRunner()
      const tmux = new TmuxAdapter(runner, runtimeDir)
      const socket = `tasktty-scroll-${process.pid}`
      const session = 'scroll'
      await tmux.initialize()
      const base = ['-L', socket, '-f', tmux.configPath]
      const program = `const fs=require("node:fs");for(let line=0;line<100;line+=1)console.log(\`history-\${line}\`);console.log("READY");process.stdin.setRawMode(true);process.stdin.on("data",data=>fs.appendFileSync(${JSON.stringify(inputPath)},data));setInterval(()=>{},1000);`
      await runChecked(runner, {
        executable: 'tmux',
        args: [
          ...base,
          'new-session',
          '-d',
          '-s',
          session,
          '--',
          process.execPath,
          '-e',
          program
        ]
      })

      const client = nodePty.spawn(
        resolveExecutablePath('tmux'),
        tmux.attachArgs(socket, session),
        {
          cwd: root,
          env: ptyEnvironment(),
          name: 'xterm-256color',
          cols: 80,
          rows: 20
        }
      )
      let output = ''
      client.onData((data) => {
        output += data
      })

      const paneMode = () =>
        runner
          .run({
            executable: 'tmux',
            args: [
              ...base,
              'display-message',
              '-p',
              '-t',
              session,
              '#{pane_in_mode}'
            ]
          })
          .then((result) => result.stdout.trim())
      const input = () => fs.readFile(inputPath, 'utf8').catch(() => '')

      try {
        await waitFor(
          () => output.includes('READY'),
          'tmux client did not attach'
        )
        output = ''
        client.write('\u001b[<64;10;10M')
        await waitFor(
          async () => (await paneMode()) === '1',
          'mouse wheel did not enter copy mode'
        )
        expect(output).not.toMatch(/\[\d+\/\d+\]/)

        client.write(`${TMUX_SCROLL_EXIT_SEQUENCE}☃`)
        await waitFor(
          async () => (await input()) === '☃',
          'the first key was not forwarded'
        )
        expect(await paneMode()).toBe('0')

        client.write(`${TMUX_SCROLL_EXIT_SEQUENCE}z`)
        await waitFor(
          async () => (await input()) === '☃z',
          'the scroll-exit key leaked'
        )
      } finally {
        client.kill()
        await tmux.killServer(socket).catch(() => undefined)
      }
    })
  }
)
