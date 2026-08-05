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
} from './command'
import { loadConfig } from './config'
import { TreeportDatabase } from './database'
import { GhAdapter } from './gh'
import { GitAdapter } from './git'
import { TreeportService } from './service'
import {
  TMUX_SCROLL_EXIT_SEQUENCE,
  TMUX_SELECTION_CLEAR_SEQUENCE,
  TMUX_SELECTION_RESTORE_SEQUENCE,
  TMUX_SELECTION_START_SEQUENCE,
  TMUX_SELECTION_STOP_SEQUENCE,
  TmuxAdapter
} from './tmux'

const enabled = process.env.TREEPORT_REAL_INTEGRATION === '1'
const root = path.join(os.tmpdir(), `treeport real integration ${process.pid}`)
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

async function waitOperation(service: TreeportService, operationId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const operation = await service.getOperation(operationId)
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
    TREEPORT_DATABASE_PATH: databasePath,
    TREEPORT_RUNTIME_DIR: runtimeDir,
    TREEPORT_DATA_DIR: root,
    TREEPORT_SHELL: process.env.SHELL || '/bin/sh'
  })
  const runner = new SpawnCommandRunner()
  const database = await TreeportDatabase.open(databasePath)
  const git = new GitAdapter(runner)
  const launcherPath = fileURLToPath(
    new URL('../../../dist/node/server/core/launcher.js', import.meta.url)
  )
  const tmux = new TmuxAdapter(runner, runtimeDir, 'tmux', launcherPath)
  const gh = new GhAdapter(runner)
  const service = new TreeportService({
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
      const databasePath = path.join(root, 'metadata', 'treeport.db')
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
        args: ['config', 'user.email', 'treeport@example.test'],
        cwd: main
      })
      await runChecked(command, {
        executable: 'git',
        args: ['config', 'user.name', 'treeport test'],
        cwd: main
      })
      await fs.writeFile(path.join(main, 'README.md'), 'fixture\n')
      await fs.mkdir(path.join(main, '.treeport'), { recursive: true })
      await fs.writeFile(
        path.join(main, '.treeport', 'setup.json'),
        JSON.stringify({
          version: 1,
          commands: [
            {
              name: 'first setup',
              argv: [process.execPath, '-e', "console.log('SETUP_ONE')"]
            },
            {
              name: 'second setup',
              argv: [process.execPath, '-e', "console.error('SETUP_TWO')"]
            }
          ]
        })
      )
      await runChecked(command, {
        executable: 'git',
        args: ['add', 'README.md', '.treeport/setup.json'],
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
      const successfulSetupTerminal = (
        await fixture.tmux.listSessions(linked.tmuxSocketName)
      ).find((terminal) => terminal.name === 'Setup')!
      await waitFor(
        async () =>
          (
            await fixture.tmux.sessionState(
              linked.tmuxSocketName,
              successfulSetupTerminal.sessionName
            )
          ).status === 'exited',
        'setup terminal did not finish'
      )
      const setupCapture = await fixture.runner.run({
        executable: 'tmux',
        args: [
          '-L',
          linked.tmuxSocketName,
          '-f',
          fixture.tmux.configPath,
          'capture-pane',
          '-p',
          '-S',
          '-',
          '-t',
          successfulSetupTerminal.sessionName
        ]
      })
      expect(setupCapture.stdout.indexOf('SETUP_ONE')).toBeLessThan(
        setupCapture.stdout.indexOf('SETUP_TWO')
      )
      expect(setupCapture.stdout).not.toContain('PI_LIKE')
      expect(
        (await fixture.service.getWorktreeSnapshot(linked.id)).terminals.map(
          (terminal) => terminal.id
        )
      ).toEqual([first.id])
      expect(
        (await fixture.tmux.listSessions(linked.tmuxSocketName)).map(
          (terminal) => terminal.id
        )
      ).not.toContain(successfulSetupTerminal.id)

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
      const initialOutput = await attachAndDetach(
        first.tmuxSessionName,
        'PI_LIKE'
      )
      expect(initialOutput).not.toContain('SETUP_ONE')
      expect(initialOutput).not.toContain('SETUP_TWO')
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
        path.join(main, '.treeport', 'setup.json'),
        JSON.stringify({
          version: 1,
          commands: [
            {
              name: 'failure setup one',
              argv: [process.execPath, '-e', "console.log('FAIL_SETUP_ONE')"]
            },
            {
              name: 'failure setup two',
              argv: [
                process.execPath,
                '-e',
                "console.error('FAIL_SETUP_TWO');process.exit(17)"
              ]
            },
            {
              name: 'skipped setup',
              argv: [process.execPath, '-e', "console.log('SHOULD_NOT_RUN')"]
            }
          ]
        })
      )
      const failedCreate = await fixture.service.createWorktree(
        project.id,
        'real-setup-failure',
        'default',
        {
          name: 'Failed setup',
          argv: [process.execPath, '-e', "console.log('INITIAL_STARTED')"]
        }
      )
      const failedWorktree = failedCreate.worktree
      const initialTerminal = failedCreate.terminal!
      const setupTerminal = (
        await fixture.service.getWorktreeSnapshot(failedWorktree.id)
      ).terminals.find((terminal) => terminal.name === 'Setup')!
      let failedState = await fixture.tmux.sessionState(
        failedWorktree.tmuxSocketName,
        setupTerminal.tmuxSessionName
      )
      for (
        let attempt = 0;
        attempt < 100 && failedState.status !== 'exited';
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 30))
        failedState = await fixture.tmux.sessionState(
          failedWorktree.tmuxSocketName,
          setupTerminal.tmuxSessionName
        )
      }
      expect(failedState).toMatchObject({ status: 'exited', exitCode: 17 })
      expect(
        await fixture.tmux.sessionState(
          failedWorktree.tmuxSocketName,
          initialTerminal.tmuxSessionName
        )
      ).toMatchObject({ status: 'exited', exitCode: 0 })
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
          setupTerminal.tmuxSessionName
        ]
      })
      expect(captured.exitCode).toBe(0)
      expect(captured.stdout).toContain('FAIL_SETUP_ONE')
      expect(captured.stdout).toContain('FAIL_SETUP_TWO')
      expect(captured.stdout).not.toContain('SHOULD_NOT_RUN')
      expect(captured.stdout).not.toContain('INITIAL_STARTED')
      const initialCapture = await fixture.runner.run({
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
          initialTerminal.tmuxSessionName
        ]
      })
      expect(initialCapture.stdout).toContain('INITIAL_STARTED')
      expect(
        (await fixture.service.getProject(project.id)).worktrees.some(
          (worktree) => worktree.id === failedWorktree.id
        )
      ).toBe(true)
      expect(
        (await fixture.service.refreshTerminalStatus(setupTerminal.id)).status
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
        await fixture.database.worktree(externallyRemoved.worktree.id)
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
      expect(
        (await fixture.service.getProject(project.id)).worktrees
      ).toHaveLength(1)
      const mainWorktree = (await fixture.service.getProject(project.id))
        .worktrees[0]!
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
      expect(await fixture.service.listRecentProjects()).toEqual([
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
      const reopenedTerminals = reopened.worktrees.flatMap(
        (worktree) => worktree.terminals
      )
      expect(reopenedTerminals).toEqual([
        expect.objectContaining({
          name: 'Shell',
          worktreeId: mainWorktree.id
        })
      ])
      expect(reopenedTerminals.map((terminal) => terminal.id)).not.toContain(
        closingTerminal.id
      )
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
        new URL('../../../dist/node/server/core/launcher.js', import.meta.url)
      )
      const tmux = new TmuxAdapter(runner, runtimeDir, 'tmux', launcherPath)
      const socket = `treeport-initial-size-${process.pid}`
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

    it('scrolls and selects tmux history while forwarding the first resumed input', async (context) => {
      if (!(await executable('tmux', ['-V']))) {
        context.skip()
        return
      }

      const runtimeDir = path.join(root, 'scroll-runtime')
      const inputPath = path.join(root, 'scroll-input')
      const runner = new SpawnCommandRunner()
      const tmux = new TmuxAdapter(runner, runtimeDir)
      const socket = `treeport-scroll-${process.pid}`
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

      const paneValue = (format: string) =>
        runner
          .run({
            executable: 'tmux',
            args: [...base, 'display-message', '-p', '-t', session, format]
          })
          .then((result) => result.stdout.trim())
      const paneMode = () => paneValue('#{pane_in_mode}')
      const input = () => fs.readFile(inputPath, 'utf8').catch(() => '')
      const clipboardSelection = async () => {
        await waitFor(
          () => output.includes('\u001b]52;'),
          'tmux did not emit the selection'
        )
        const clipboardPayload = output.slice(
          output.indexOf('\u001b]52;') + '\u001b]52;'.length
        )
        const encodedSelection = clipboardPayload
          .slice(clipboardPayload.indexOf(';') + 1)
          .split('\u0007', 1)[0]
        expect(encodedSelection).toMatch(/^[A-Za-z0-9+/]+=*$/)
        if (!encodedSelection) {
          throw new Error('tmux emitted an empty clipboard selection')
        }

        return Buffer.from(encodedSelection, 'base64').toString('utf8')
      }

      try {
        await waitFor(
          () => output.includes('READY'),
          'tmux client did not attach'
        )
        await runChecked(runner, {
          executable: 'tmux',
          args: [
            ...base,
            'bind-key',
            '-T',
            'copy-mode',
            'WheelDownPane',
            'send-keys',
            '-X',
            'cancel'
          ]
        })
        await tmux.configureServer(socket)
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

        output = ''
        client.write(
          `${TMUX_SELECTION_START_SEQUENCE}\u001b[<0;10;18M\u001b[<32;10;18M`
        )
        for (let step = 0; step < 15; step += 1) {
          client.write('\u001b[<32;10;1M')
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        client.write(
          `${TMUX_SELECTION_STOP_SEQUENCE}\u001b[<32;10;2M\u001b[<0;10;2m`
        )
        const selectedLines = (await clipboardSelection())
          .split('\n')
          .filter((line) => line.startsWith('history-'))
          .map((line) => Number(line.slice('history-'.length)))
        expect(selectedLines.length).toBeGreaterThan(20)
        expect(Math.min(...selectedLines)).toBeLessThan(80)
        expect(Math.max(...selectedLines)).toBe(98)
        expect(await paneMode()).toBe('1')
        expect(await paneValue('#{selection_present}')).toBe('1')
        const releasedScrollPosition = await paneValue('#{scroll_position}')
        expect(Number(releasedScrollPosition)).toBeGreaterThan(0)
        await new Promise((resolve) => setTimeout(resolve, 300))
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(await paneValue('#{scroll_position}')).toBe(
          releasedScrollPosition
        )
        expect(await input()).toBe('☃z')

        output = ''
        client.write(
          `${TMUX_SELECTION_START_SEQUENCE}\u001b[<0;1;5M\u001b[<32;1;5M\u001b[<32;1;15M${TMUX_SELECTION_STOP_SEQUENCE}\u001b[<32;1;15M\u001b[<0;1;15m`
        )
        const secondSelection = await clipboardSelection()
        const secondSelectedLines = secondSelection
          .split('\n')
          .filter((line) => line.startsWith('history-'))
          .map((line) => Number(line.slice('history-'.length)))
        expect(secondSelectedLines.length).toBeGreaterThanOrEqual(9)
        expect(
          Math.max(...secondSelectedLines) - Math.min(...secondSelectedLines)
        ).toBeLessThanOrEqual(10)
        expect(await paneMode()).toBe('1')
        expect(await paneValue('#{selection_present}')).toBe('1')
        const releasedSelection = await paneValue(
          '#{selection_start_x},#{selection_start_y},#{selection_end_x},#{selection_end_y}'
        )
        expect(
          await paneValue(
            '#{@treeport-selection-start-x},#{@treeport-selection-start-y},#{@treeport-selection-end-x},#{@treeport-selection-end-y}'
          )
        ).toBe(releasedSelection)
        const releasedCursor = await paneValue(
          '#{copy_cursor_x},#{copy_cursor_y}'
        )
        client.write('\u001b[<32;70;20M')
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(await paneValue('#{copy_cursor_x},#{copy_cursor_y}')).toBe(
          releasedCursor
        )

        for (let step = 0; step < 5; step += 1) {
          client.write('\u001b[<64;10;10M')
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(
          await paneValue(
            '#{selection_start_x},#{selection_start_y},#{selection_end_x},#{selection_end_y}'
          )
        ).toBe(releasedSelection)

        for (let step = 0; step < 30; step += 1) {
          client.write('\u001b[<65;10;10M')
        }
        await waitFor(
          async () => (await paneMode()) === '0',
          'scrolling to the bottom did not return to live output'
        )
        expect(
          await paneValue(
            '#{@treeport-selection-start-x},#{@treeport-selection-start-y},#{@treeport-selection-end-x},#{@treeport-selection-end-y}'
          )
        ).toBe(releasedSelection)

        client.write(`${TMUX_SELECTION_RESTORE_SEQUENCE}\u001b[<64;10;10M`)
        await waitFor(
          async () => (await paneValue('#{selection_present}')) === '1',
          'reopening history did not restore the selection'
        )
        expect(
          await paneValue(
            '#{selection_start_x},#{selection_start_y},#{selection_end_x},#{selection_end_y}'
          )
        ).toBe(releasedSelection)
        output = ''
        await runChecked(runner, {
          executable: 'tmux',
          args: [
            ...base,
            'send-keys',
            '-X',
            '-t',
            session,
            'copy-selection-no-clear'
          ]
        })
        expect(await clipboardSelection()).toBe(secondSelection)

        client.write(TMUX_SELECTION_CLEAR_SEQUENCE)
        await waitFor(
          async () => (await paneValue('#{selection_present}')) === '0',
          'clicking after selection did not clear it'
        )
        expect(await paneValue('#{@treeport-selection-width}')).toBe('')
        expect(await paneMode()).toBe('1')

        client.write(`${TMUX_SCROLL_EXIT_SEQUENCE}y`)
        await waitFor(
          async () => (await input()) === '☃zy',
          'the first key after selecting was not forwarded'
        )
        expect(await paneMode()).toBe('0')
      } finally {
        client.kill()
        await tmux.killServer(socket).catch(() => undefined)
      }
    })
  }
)
