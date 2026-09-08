import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserContainer, BROWSER_CONTAINER_IMAGE } from './browser-container'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

it('creates only a non-root, sandboxed, loopback-debugged container with one profile mount', async () => {
  vi.stubEnv('DOCKER_HOST', 'unix:///var/run/docker.sock')
  vi.spyOn(process, 'getuid').mockReturnValue(1000)
  vi.spyOn(process, 'getgid').mockReturnValue(1000)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-container-'))
  roots.push(root)
  const profile = path.join(root, 'profile')
  const id = 'a'.repeat(64)
  const commands: string[][] = []
  const run = async (args: string[]) => {
    commands.push(args)
    if (args.includes('info')) {
      return 'linux'
    }

    if (args.includes('image')) {
      return 'image-id'
    }

    if (args.includes('container')) {
      return ''
    }

    if (args.includes('run')) {
      await fs.writeFile(
        path.join(profile, 'DevToolsActivePort'),
        '43210\n/devtools/browser/unique-browser-id\n'
      )
      return id
    }

    return ''
  }
  const container = new BrowserContainer(profile, path.join(root, 'cache'), run)
  await expect(container.start()).resolves.toBe(
    'ws://127.0.0.1:43210/devtools/browser/unique-browser-id'
  )
  const start = commands.find((args) => args.includes('run'))!
  expect(start).toContain('--init')
  expect(start).toContain('1000:1000')
  expect(start).toContain('host')
  expect(start).toContain(BROWSER_CONTAINER_IMAGE)
  expect(start.filter((arg) => arg === '--mount')).toHaveLength(1)
  expect(start.join(' ')).not.toMatch(
    /--privileged|--no-sandbox|unconfined|source=[^,]*docker\.sock|--publish/
  )
  expect((await fs.stat(profile)).mode & 0o777).toBe(0o700)
  await fs.writeFile(path.join(profile, 'login-fixture'), 'retained')
  await container.stop()
  expect(commands.at(-2)).toEqual([
    '--host',
    'unix:///var/run/docker.sock',
    'stop',
    '--time',
    '20',
    id
  ])
  expect(commands.at(-1)).toEqual([
    '--host',
    'unix:///var/run/docker.sock',
    'rm',
    id
  ])
  expect(await fs.readFile(path.join(profile, 'login-fixture'), 'utf8')).toBe(
    'retained'
  )
})

it('does not start or stop a foreign container with the same name', async () => {
  vi.stubEnv('DOCKER_HOST', 'unix:///var/run/docker.sock')
  vi.spyOn(process, 'getuid').mockReturnValue(1000)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-container-'))
  roots.push(root)
  const commands: string[][] = []
  const container = new BrowserContainer(
    path.join(root, 'profile'),
    path.join(root, 'cache'),
    async (args) => {
      commands.push(args)
      if (args.includes('info')) {
        return 'linux'
      }

      if (args.includes('image')) {
        return 'image-id'
      }

      if (args.includes('container')) {
        return 'abc123'
      }

      return `someone-else|true|${'a'.repeat(64)}`
    }
  )
  await expect(container.start()).rejects.toThrow('not owned by this profile')
  await container.stop()
  expect(
    commands.some(
      (args) =>
        args.includes('start') ||
        args.includes('stop') ||
        args.includes('run') ||
        args.includes('rm')
    )
  ).toBe(false)
})

it('rejects remote Docker before any image download or container mutation', async () => {
  vi.stubEnv('DOCKER_HOST', 'tcp://remote.example:2375')
  const run = vi.fn()
  await expect(
    new BrowserContainer('/unused', '/unused', run).installed()
  ).rejects.toThrow('local Docker Unix socket')
  expect(run).not.toHaveBeenCalled()
})

it('requires explicit setup before downloading an image and sends no host build context', async () => {
  vi.stubEnv('DOCKER_HOST', 'unix:///var/run/docker.sock')
  vi.spyOn(process, 'getuid').mockReturnValue(1000)
  const run = vi.fn(async (args: string[], _input?: string) =>
    args.includes('info') ? 'linux' : ''
  )
  const container = new BrowserContainer('/unused', '/unused', run)
  await expect(container.start()).rejects.toThrow('not set up')
  expect(run.mock.calls.some(([args]) => args.includes('build'))).toBe(false)
  await container.install()
  const [args, input] = run.mock.calls.at(-1)!
  expect(args.at(-1)).toBe('-')
  expect(input).toContain('--remote-debugging-address=127.0.0.1')
  expect(input).not.toMatch(/--no-sandbox|COPY|ADD/)
})
