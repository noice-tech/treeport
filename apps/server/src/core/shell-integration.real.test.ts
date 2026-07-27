import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { prepareShellIntegration } from './shell-integration'

const execute = promisify(execFile)
const temporary: string[] = []
const sockets: string[] = []

async function available(executable: string): Promise<string | null> {
  return execute('sh', ['-c', `command -v "$1"`, 'sh', executable])
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null)
}

async function waitForTitleState(
  tmux: string,
  socket: string,
  expected: (state: string) => boolean
): Promise<string> {
  const deadline = Date.now() + 10_000
  let state = ''
  while (Date.now() < deadline) {
    state = (
      await execute(tmux, [
        '-L',
        socket,
        'display-message',
        '-p',
        '-t',
        'title',
        '#{@treeport-command}|#{pane_current_command}|#{pane_title}'
      ])
    ).stdout.trim()
    if (expected(state)) {
      return state
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  return state
}

async function verifyCommandLifecycle(
  tmux: string,
  executable: string,
  home: string,
  environment: Record<string, string>
): Promise<void> {
  const shell = path.basename(executable)
  const socket = `treeport-title-${crypto.randomBytes(8).toString('hex')}`
  sockets.push(socket)
  await execute(tmux, [
    '-L',
    socket,
    '-f',
    '/dev/null',
    'new-session',
    '-d',
    '-s',
    'title',
    '--',
    'env',
    `HOME=${home}`,
    ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    executable,
    '-l'
  ])

  await waitForTitleState(tmux, socket, (state) => state.includes(`|${shell}|`))
  await execute(tmux, [
    '-L',
    socket,
    'send-keys',
    '-t',
    'title',
    'sleep 30',
    'Enter'
  ])
  await expect(
    waitForTitleState(tmux, socket, (state) =>
      state.startsWith('sleep 30|sleep|sleep 30')
    )
  ).resolves.toBe('sleep 30|sleep|sleep 30')

  await execute(tmux, ['-L', socket, 'send-keys', '-t', 'title', 'C-c'])
  await expect(
    waitForTitleState(tmux, socket, (state) => state.startsWith(`|${shell}|`))
  ).resolves.toMatch(new RegExp(`^\\|${shell}\\|`))
}

afterEach(async () => {
  const tmux = await available('tmux')
  if (tmux) {
    await Promise.all(
      sockets
        .splice(0)
        .map((socket) =>
          execute(tmux, ['-L', socket, 'kill-server']).catch(() => undefined)
        )
    )
  }

  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

it('captures complete zsh and Bash commands and clears them at the prompt', async () => {
  const tmux = await available('tmux')
  const zsh = await available('zsh')
  const bash = await available('bash')
  if (!tmux || !zsh || !bash) {
    return
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-shell-title-'))
  temporary.push(root)
  const integration = path.join(root, 'integration')
  await prepareShellIntegration(integration)

  const zshHome = path.join(root, 'zsh-home')
  await fs.mkdir(zshHome)
  await verifyCommandLifecycle(tmux, zsh, zshHome, {
    ZDOTDIR: path.join(integration, 'zsh'),
    TREEPORT_USER_ZDOTDIR: zshHome,
    TREEPORT_TMUX_EXECUTABLE: tmux
  })

  const bashHome = path.join(root, 'bash-home')
  await fs.mkdir(bashHome)
  await verifyCommandLifecycle(tmux, bash, bashHome, {
    PROMPT_COMMAND: 'source "${TREEPORT_BASH_INTEGRATION_FILE}"',
    TREEPORT_BASH_INTEGRATION_FILE: path.join(
      integration,
      'bash',
      'treeport.bash'
    ),
    TREEPORT_TMUX_EXECUTABLE: tmux
  })
})
