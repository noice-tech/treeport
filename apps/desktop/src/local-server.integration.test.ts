import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import net, { type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import * as Effect from 'effect/Effect'
import { afterEach, expect, it, vi } from 'vitest'
import { checkHealth } from './backend-connection'
import { LocalServer } from './local-server'

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..')
const directories: string[] = []
const servers: LocalServer[] = []

const serverReportingCommit = `
import http from 'node:http'
import { execFileSync } from 'node:child_process'

const version = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

http
  .createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      version,
      hostname: null,
      pid: process.pid,
      installationMethod: process.env.TREEPORT_INSTALLATION_METHOD
    }))
  })
  .listen(Number(process.env.TREEPORT_PORT), '127.0.0.1')
`

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
  vi.unstubAllGlobals()
})

async function freePort(): Promise<number> {
  const server = net.createServer().listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  // SAFETY: A server listening on a TCP port reports an AddressInfo, not a pipe path.
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))

  return port
}

it('restarts the server it started after updating the clone', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-update-'))
  directories.push(directory)
  const upstream = path.join(directory, 'upstream')
  const clone = path.join(directory, 'clone')

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  await fs.mkdir(path.join(upstream, 'scripts'), { recursive: true })

  for (const script of ['update.mjs', 'steps.mjs']) {
    await fs.copyFile(
      path.join(repositoryRoot, 'scripts', script),
      path.join(upstream, 'scripts', script)
    )
  }

  await fs.writeFile(path.join(upstream, 'scripts', 'start.mjs'), serverReportingCommit)
  await fs.writeFile(
    path.join(upstream, 'package.json'),
    JSON.stringify({
      name: 'treeport-update-fixture',
      private: true,
      scripts: { 'build:server': 'node -e 0' }
    })
  )
  await fs.writeFile(
    path.join(upstream, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n"
  )
  await fs.writeFile(path.join(upstream, '.gitignore'), 'node_modules\n')
  git(upstream, 'init', '--quiet', '--initial-branch=main')
  git(upstream, 'add', '.')
  git(
    upstream,
    '-c',
    'user.name=Treeport',
    '-c',
    'user.email=treeport@example.com',
    'commit',
    '--quiet',
    '-m',
    'Initial'
  )
  git(directory, 'clone', '--quiet', upstream, clone)
  git(
    upstream,
    '-c',
    'user.name=Treeport',
    '-c',
    'user.email=treeport@example.com',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'Update'
  )

  vi.stubGlobal('__TREEPORT_SOURCE_ROOT__', clone)
  const origin = `http://127.0.0.1:${await freePort()}`

  const server = new LocalServer(
    origin,
    path.join(directory, 'server-output.log'),
    path.join(directory, 'local-server-chosen'),
    () => undefined
  )

  servers.push(server)

  await server.start()
  const before = await Effect.runPromise(checkHealth(origin))
  expect(before?.version).toBe(git(clone, 'rev-parse', 'HEAD'))

  const result = await server.runUpdate()
  expect(result.ok, result.output).toBe(true)

  const after = await Effect.runPromise(checkHealth(origin))
  expect(after?.version).toBe(git(upstream, 'rev-parse', 'HEAD'))
  expect(after?.pid).not.toBe(before?.pid)
  expect(server.state.canStop).toBe(true)
}, 60_000)
