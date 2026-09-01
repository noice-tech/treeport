import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { spawn, type IPty } from 'node-pty'
import { afterEach, expect, it } from 'vitest'
import {
  integrateShellLaunch,
  prepareShellIntegration
} from './shell-integration'

const execute = promisify(execFile)
const temporary: string[] = []
const children: IPty[] = []

async function available(executable: string): Promise<string | null> {
  return execute('sh', ['-c', `command -v "$1"`, 'sh', executable])
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null)
}

async function waitForOutput(
  read: () => string,
  expected: (output: string) => boolean
): Promise<string> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const output = read()
    if (expected(output)) {
      return output
    }

    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error(
    `Timed out waiting for shell output: ${JSON.stringify(read())}`
  )
}

async function verifyCommandLifecycle(
  executable: string,
  home: string,
  integration: string,
  startupMarker: string
): Promise<void> {
  const launch = integrateShellLaunch(
    [executable, '-l'],
    {
      ...process.env,
      HOME: home,
      TERM: 'xterm-256color'
    },
    integration,
    true
  )
  const environment = Object.fromEntries(
    Object.entries(launch.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  )
  const child = spawn(launch.argv[0]!, launch.argv.slice(1), {
    cwd: home,
    cols: 100,
    rows: 30,
    env: environment
  })
  children.push(child)
  let output = ''
  child.onData((data) => {
    output += data
  })

  await expect(
    waitForOutput(
      () => output,
      (value) =>
        value.includes(startupMarker) &&
        value.includes('\u001b]777;command;\u001b\\')
    )
  ).resolves.toContain(startupMarker)

  const command = `printf 'treeport-shell-result\\n'`
  child.write(`${command}\r`)
  const commandSequence = `\u001b]777;command;${command}\u001b\\`
  const completed = await waitForOutput(
    () => output,
    (value) => {
      const commandIndex = value.indexOf(commandSequence)
      return (
        commandIndex >= 0 &&
        value.indexOf(
          'treeport-shell-result',
          commandIndex + commandSequence.length
        ) >= 0 &&
        value.indexOf(
          '\u001b]777;command;\u001b\\',
          commandIndex + commandSequence.length
        ) >= 0
      )
    }
  )
  expect(completed).toContain(commandSequence)
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
  }
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

it('preserves user startup and reports complete zsh and Bash command lifecycles', async () => {
  const zsh = await available('zsh')
  const bash = await available('bash')
  const fish = await available('fish')
  if (!zsh || !bash) {
    return
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-shell-title-'))
  temporary.push(root)
  const integration = path.join(root, 'integration')
  await prepareShellIntegration(integration)

  const zshHome = path.join(root, 'zsh-home')
  await fs.mkdir(zshHome)
  await fs.writeFile(
    path.join(zshHome, '.zshrc'),
    "printf 'treeport-user-zsh-startup\\n'\n"
  )
  await verifyCommandLifecycle(
    zsh,
    zshHome,
    integration,
    'treeport-user-zsh-startup'
  )

  const bashHome = path.join(root, 'bash-home')
  await fs.mkdir(bashHome)
  await fs.writeFile(
    path.join(bashHome, '.bash_profile'),
    "printf 'treeport-user-bash-startup\\n'\n"
  )
  await verifyCommandLifecycle(
    bash,
    bashHome,
    integration,
    'treeport-user-bash-startup'
  )

  if (fish) {
    const fishHome = path.join(root, 'fish-home')
    await fs.mkdir(path.join(fishHome, '.config', 'fish'), { recursive: true })
    await fs.writeFile(
      path.join(fishHome, '.config', 'fish', 'config.fish'),
      "printf 'treeport-user-fish-startup\\n'\n"
    )
    await verifyCommandLifecycle(
      fish,
      fishHome,
      integration,
      'treeport-user-fish-startup'
    )
  }
})
