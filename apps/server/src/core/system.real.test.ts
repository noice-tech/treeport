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
      let main = path.join(root, 'main checkout with spaces')
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

      const renamedMain = path.join(root, 'renamed main checkout with spaces')
      await fs.rename(main, renamedMain)
      main = renamedMain
      const recoveredProject = await fixture.service.getProjectSnapshot(
        project.id
      )
      expect(recoveredProject).toMatchObject({
        id: project.id,
        name: path.basename(renamedMain),
        repositoryPath: await fs.realpath(renamedMain),
        mainWorktreePath: await fs.realpath(renamedMain),
        availability: { state: 'available' }
      })
      expect(
        recoveredProject.worktrees.find(
          (worktree) => worktree.kind === 'linked'
        )
      ).toMatchObject({
        id: linked.id,
        tmuxSocketName: linked.tmuxSocketName,
        terminals: expect.arrayContaining([
          expect.objectContaining({ id: first.id }),
          expect.objectContaining({ id: second.id })
        ])
      })

      const movedPath = path.join(root, 'externally moved real topic')
      await runChecked(command, {
        executable: 'git',
        args: ['worktree', 'move', linked.path, movedPath],
        cwd: main
      })
      const moved = (
        await fixture.service.getProjectSnapshot(project.id)
      ).worktrees.find((worktree) => worktree.id === linked.id)!
      expect(moved.path).toBe(await fs.realpath(movedPath))
      expect(moved.tmuxSocketName).toBe(linked.tmuxSocketName)
      expect(moved.terminals.map((terminal) => terminal.id)).toEqual(
        expect.arrayContaining([first.id, second.id])
      )
      linked.path = moved.path

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

      const externallyRemoved = await fixture.service.createWorktree(
        project.id,
        'real-external-removal',
        'default'
      )
      await runChecked(command, {
        executable: 'git',
        args: ['worktree', 'remove', externallyRemoved.worktree.path],
        cwd: main
      })
      const afterExternalRemoval = await fixture.service.getProjectSnapshot(
        project.id
      )
      expect(afterExternalRemoval.availability).toEqual({
        state: 'available',
        message: null
      })
      expect(
        afterExternalRemoval.worktrees.some(
          (worktree) => worktree.id === externallyRemoved.worktree.id
        )
      ).toBe(false)
      expect(
        fixture.database.worktree(externallyRemoved.worktree.id)
      ).toBeNull()

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
      await expect(fs.stat(linked.path)).rejects.toMatchObject({
        code: 'ENOENT'
      })
      expect(
        (await new GitAdapter(fixture.runner).listWorktrees(main)).some(
          (worktree) => worktree.path === linked.path
        )
      ).toBe(false)

      const noServer = await fixture.service.createWorktree(
        project.id,
        'real-no-tmux-server',
        'default'
      )
      expect(
        (
          await fixture.tmux.sessionState(
            noServer.worktree.tmuxSocketName,
            'missing-session'
          )
        ).status
      ).toBe('missing')
      const noServerPreview = await fixture.service.removePreview(
        noServer.worktree.id
      )
      const noServerRemoval = await fixture.service.beginRemove(
        noServer.worktree.id,
        {
          confirmationToken: noServerPreview.confirmationToken,
          confirmDestructive: noServerPreview.warnings.length > 0
        }
      )
      expect(
        (await waitOperation(fixture.service, noServerRemoval.id)).status
      ).toBe('completed')
      await expect(fs.stat(noServer.worktree.path)).rejects.toMatchObject({
        code: 'ENOENT'
      })
      expect(fixture.service.getProject(project.id).worktrees).toHaveLength(1)
      const mainWorktree = fixture.service.getProject(project.id).worktrees[0]!
      expect(
        (await fixture.service.removePreview(mainWorktree.id)).eligible
      ).toBe(false)
      const closingTerminal = await fixture.service.createTerminal(
        mainWorktree.id,
        'Closing terminal',
        [
          process.execPath,
          '-e',
          "console.log('CLOSING');setInterval(()=>{},1000)"
        ]
      )
      await fixture.service.closeProject(project.id)
      expect(
        (
          await fixture.tmux.sessionState(
            mainWorktree.tmuxSocketName,
            closingTerminal.tmuxSessionName
          )
        ).status
      ).toBe('missing')
      expect(await fixture.service.listProjects()).toEqual([])
      expect(fixture.service.listRecentProjects()).toEqual([
        expect.objectContaining({ id: project.id })
      ])

      fixture.database.close()
      fixture = await makeService(databasePath, runtimeDir)
      expect(await fixture.service.listProjects()).toEqual([])
      const reopened = await fixture.service.openProject(project.id)
      expect(reopened.id).toBe(project.id)
      expect(reopened.worktrees.map((worktree) => worktree.id)).toContain(
        mainWorktree.id
      )
      expect(
        reopened.worktrees.flatMap((worktree) => worktree.terminals)
      ).toEqual([])
      fixture.database.close()
    })

    it('starts a terminal process at its requested initial dimensions', async (context) => {
      if (!(await executable('tmux', ['-V']))) {
        context.skip()
        return
      }

      const runtimeDir = path.join(root, 'initial-size-runtime')
      const outputPath = path.join(root, 'initial-size.json')
      const runner = new SpawnCommandRunner()
      const launcherPath = fileURLToPath(
        new URL('../dist/launcher.js', import.meta.url)
      )
      const tmux = new TmuxAdapter(runner, runtimeDir, 'tmux', launcherPath)
      const socket = `tasktty-initial-size-${process.pid}`
      await fs.mkdir(root, { recursive: true })
      try {
        await tmux.createSession({
          socketName: socket,
          sessionName: 'initial-size',
          terminalId: 'term_initial_size',
          worktreeId: 'wt_initial_size',
          name: 'Initial size',
          createdAt: '2026-01-02T03:04:05.000Z',
          cwd: root,
          argv: [
            process.execPath,
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ cols: process.stdout.columns, rows: process.stdout.rows }))`
          ],
          initialSize: { cols: 132, rows: 47 },
          env: {}
        })
        await waitFor(
          () =>
            fs.access(outputPath).then(
              () => true,
              () => false
            ),
          'terminal process did not report its initial size'
        )
        await expect(
          fs.readFile(outputPath, 'utf8').then(JSON.parse)
        ).resolves.toEqual({ cols: 132, rows: 47 })
      } finally {
        await tmux.killServer(socket).catch(() => undefined)
      }
    })

    it('retains and redraws SIXEL images for same-size browser attachments', async (context) => {
      if (!(await executable('tmux', ['-V']))) {
        context.skip()
        return
      }

      const runtimeDir = path.join(root, 'sixel-runtime')
      const runner = new SpawnCommandRunner()
      const launcherPath = fileURLToPath(
        new URL('../dist/launcher.js', import.meta.url)
      )
      const tmux = new TmuxAdapter(runner, runtimeDir, 'tmux', launcherPath)
      const socket = `tasktty-sixel-${process.pid}`
      const session = 'sixel'
      const fixture = '\x1bP0;0;q"1;1;8;6#0;2;100;0;0#0!8~\x1b\\'
      try {
        await tmux.createSession({
          socketName: socket,
          sessionName: session,
          terminalId: 'term_sixel',
          worktreeId: 'wt_sixel',
          name: 'SIXEL',
          createdAt: '2026-01-02T03:04:05.000Z',
          cwd: root,
          argv: [
            process.execPath,
            '-e',
            `process.stdin.setRawMode(true);process.stdin.on('data',data=>{if(data.includes(0x69))process.stdout.write(${JSON.stringify(fixture)})});console.log('READY');setInterval(()=>{},1000)`
          ],
          initialSize: { cols: 80, rows: 24 },
          env: {}
        })
        const spec = await fs
          .readFile(path.join(tmux.specsDir, 'term_sixel.json'), 'utf8')
          .then(JSON.parse)
        if (spec.env.TASKTTY_IMAGE_PROTOCOL !== 'sixel') {
          context.skip()
          return
        }

        const attach = () => {
          const client = nodePty.spawn(
            resolveExecutablePath('tmux'),
            tmux.attachArgs(socket, session),
            {
              cwd: root,
              env: { ...ptyEnvironment(), TERM: 'xterm-256color' },
              name: 'xterm-256color',
              cols: 80,
              rows: 24
            }
          )
          let output = ''
          let answeredCharacters = false
          let answeredPixels = false
          client.onData((data) => {
            output += data
            if (!answeredCharacters && output.includes('\x1b[18t')) {
              answeredCharacters = true
              client.write('\x1b[8;24;80t')
            }

            if (!answeredPixels && output.includes('\x1b[14t')) {
              answeredPixels = true
              client.write('\x1b[4;432;720t')
            }
          })
          return {
            client,
            output: () => output,
            ready: () => answeredCharacters && answeredPixels
          }
        }

        const first = attach()
        await waitFor(
          () => first.output().includes('READY') && first.ready(),
          'tmux did not finish the attachment size handshake'
        )
        await new Promise((resolve) => setTimeout(resolve, 50))
        const clients = await runner.run({
          executable: 'tmux',
          args: [
            '-L',
            socket,
            '-f',
            tmux.configPath,
            'list-clients',
            '-F',
            '#{client_termname}\t#{client_termfeatures}'
          ]
        })
        expect(clients.stdout).toContain('sixel')
        first.client.write('i')
        await waitFor(
          () => first.output().includes('\x1bP0;0q'),
          'tmux did not forward the SIXEL image'
        )
        first.client.kill()
        await waitFor(async () => {
          const result = await runner.run({
            executable: 'tmux',
            args: [
              '-L',
              socket,
              '-f',
              tmux.configPath,
              'list-clients',
              '-F',
              '#{client_name}'
            ]
          })
          return !result.stdout.trim()
        }, 'tmux did not detach the first image client')

        const second = attach()
        await waitFor(
          () => second.output().includes('SIXEL IMAGE') && second.ready(),
          'tmux did not finish the fresh attachment redraw'
        )
        const secondClient = await runner.run({
          executable: 'tmux',
          args: [
            '-L',
            socket,
            '-f',
            tmux.configPath,
            'list-clients',
            '-F',
            '#{client_name}'
          ]
        })
        await runChecked(runner, {
          executable: 'tmux',
          args: [
            '-L',
            socket,
            '-f',
            tmux.configPath,
            'refresh-client',
            '-t',
            secondClient.stdout.trim()
          ]
        })
        await waitFor(
          () => second.output().includes('\x1bP0;0q'),
          'tmux did not redraw the retained SIXEL image'
        )
        second.client.kill()
      } finally {
        await tmux.killServer(socket).catch(() => undefined)
      }
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
