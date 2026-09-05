import { spawn } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'

const children = []
const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve()
            return
          }

          child.once('exit', resolve)
          child.kill('SIGTERM')
        })
    )
  )
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function execute(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

it('uses a title-only development daemon only when its health identity matches', async () => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), 'treeport-development-cli-')
  )
  temporaryDirectories.push(repositoryRoot)
  const scriptsDirectory = path.join(repositoryRoot, 'scripts')
  const applicationRoot = path.join(repositoryRoot, 'apps/treeport')
  const runtimeDirectory = path.join(applicationRoot, '.treeport-dev/runtime')
  const dataDirectory = path.join(applicationRoot, '.treeport-dev/data')
  const cliEntrypoint = path.join(
    applicationRoot,
    '.treeport-dev-dist/node/cli/index.js'
  )
  const wrapperEntrypoint = path.join(scriptsDirectory, 'development-cli.mjs')
  const localEntrypoint = path.join(repositoryRoot, 'home/.local/bin/treeport')
  const invocationLog = path.join(repositoryRoot, 'cli-invocations.jsonl')
  await Promise.all([
    mkdir(scriptsDirectory, { recursive: true }),
    mkdir(path.dirname(localEntrypoint), { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true, mode: 0o700 }),
    mkdir(dataDirectory, { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(cliEntrypoint), { recursive: true }),
    symlink(
      path.resolve('node_modules'),
      path.join(repositoryRoot, 'node_modules')
    )
  ])
  await writeFile(
    wrapperEntrypoint,
    await readFile(path.resolve('scripts/development-cli.mjs')),
    { mode: 0o700 }
  )
  await symlink(wrapperEntrypoint, localEntrypoint)
  await writeFile(
    cliEntrypoint,
    `import fs from 'node:fs'
fs.appendFileSync(process.env.CLI_INVOCATION_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdout.write(JSON.stringify({
  apiUrl: process.env.TREEPORT_API_URL,
  dataDir: process.env.TREEPORT_DATA_DIR,
  runtimeDir: process.env.TREEPORT_RUNTIME_DIR,
  daemonRecord: process.env.TREEPORT_DAEMON_RECORD,
  daemonLifecycle: process.env.TREEPORT_DAEMON_LIFECYCLE,
  inheritedProjectId: process.env.TREEPORT_PROJECT_ID,
  arguments: process.argv.slice(2)
}) + '\\n')
`,
    { mode: 0o700 }
  )
  await chmod(cliEntrypoint, 0o700)

  const instanceId = 'matching-development-instance'
  const server = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import http from 'node:http'
process.title = 'treeport-server-dev'
const instanceId = process.env.TEST_INSTANCE_ID
const server = http.createServer((request, response) => {
  if (request.url !== '/api/health') {
    response.writeHead(404).end()
    return
  }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({
    ok: true,
    version: 'development',
    protocolVersion: 3,
    hostname: 'test.local',
    pid: process.pid,
    instanceId,
    installationMethod: 'development',
    daemonLifecycle: 'external',
    url: 'http://127.0.0.1:' + server.address().port
  }))
})
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({
    pid: process.pid,
    apiUrl: 'http://127.0.0.1:' + server.address().port
  }) + '\\n')
})
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`
    ],
    {
      env: { ...process.env, TEST_INSTANCE_ID: instanceId },
      stdio: ['ignore', 'pipe', 'inherit']
    }
  )
  children.push(server)
  server.stdout.setEncoding('utf8')
  const serverRecord = await new Promise((resolve, reject) => {
    let output = ''
    server.stdout.on('data', (chunk) => {
      output += chunk
      const newline = output.indexOf('\n')
      if (newline !== -1) {
        resolve(JSON.parse(output.slice(0, newline)))
      }
    })
    server.once('error', reject)
    server.once('exit', (code) =>
      reject(new Error(`Development server exited with code ${code}`))
    )
  })

  const daemonRecordPath = path.join(runtimeDirectory, 'daemon.json')
  const daemonRecord = {
    pid: serverRecord.pid,
    instanceId,
    version: 'development',
    apiUrl: serverRecord.apiUrl,
    dataDir: dataDirectory,
    startedAt: new Date().toISOString(),
    installationMethod: 'development',
    daemonLifecycle: 'external'
  }
  await writeFile(daemonRecordPath, JSON.stringify(daemonRecord), {
    mode: 0o600
  })

  const environment = {
    ...process.env,
    CLI_INVOCATION_LOG: invocationLog,
    TREEPORT_API_URL: 'http://127.0.0.1:1',
    TREEPORT_MANAGED_API_URL: 'http://127.0.0.1:1',
    TREEPORT_PROJECT_ID: 'outer-project',
    TREEPORT_WORKTREE_ID: 'outer-worktree',
    TREEPORT_TERMINAL_ID: 'outer-terminal'
  }
  const healthy = await execute(
    localEntrypoint,
    ['context', '--json'],
    environment
  )
  expect(healthy).toMatchObject({ code: 0, stderr: '' })
  expect(JSON.parse(healthy.stdout)).toEqual({
    apiUrl: serverRecord.apiUrl,
    dataDir: await realpath(dataDirectory),
    runtimeDir: await realpath(runtimeDirectory),
    daemonRecord: await realpath(daemonRecordPath),
    daemonLifecycle: 'external',
    arguments: ['context', '--json']
  })

  await writeFile(
    daemonRecordPath,
    JSON.stringify({ ...daemonRecord, instanceId: 'stale-instance' }),
    { mode: 0o600 }
  )
  const stale = await execute(
    localEntrypoint,
    ['context', '--json'],
    environment
  )
  expect(stale.code).toBe(1)
  expect(stale.stdout).toBe('')
  expect(stale.stderr).toContain(
    'The Treeport development daemon record is stale or belongs to another process.'
  )
  expect(stale.stderr).toContain(`Recorded PID: ${serverRecord.pid}`)
  expect((await readFile(invocationLog, 'utf8')).trim().split('\n')).toEqual([
    '["context","--json"]'
  ])
})
