#!/usr/bin/env node

// Use this tracked entrypoint as the target of a machine-local development CLI link.
import { spawnSync } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'

const daemonRecordSchema = z.strictObject({
  pid: z.number().int().positive(),
  instanceId: z.string().min(1),
  version: z.string(),
  apiUrl: z.url(),
  dataDir: z.string().min(1),
  startedAt: z.string(),
  installationMethod: z.literal('development'),
  daemonLifecycle: z.literal('external')
})
const healthSchema = z.looseObject({
  pid: z.number().int().positive(),
  instanceId: z.string().min(1),
  installationMethod: z.literal('development'),
  daemonLifecycle: z.literal('external')
})

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const applicationRoot = path.join(repositoryRoot, 'apps/treeport')
const runtimeDirectory = path.join(applicationRoot, '.treeport-dev/runtime')
const recordPath = path.join(runtimeDirectory, 'daemon.json')
const cliEntrypoint = path.join(
  applicationRoot,
  '.treeport-dev-dist/node/cli/index.js'
)

const recordSource = await readFile(recordPath, 'utf8').catch(() => null)
if (recordSource === null) {
  console.error(`Treeport development daemon record is missing: ${recordPath}`)
  console.error('Start the development instance with: pnpm dev')
  process.exit(1)
}

const record = await Promise.resolve(recordSource)
  .then((source) => daemonRecordSchema.parse(JSON.parse(source)))
  .catch(() => null)
const recordStat = await lstat(recordPath).catch(() => null)
const expectedDataDirectory = path.join(applicationRoot, '.treeport-dev/data')
const apiUrl = record ? new URL(record.apiUrl) : null
const recordIsPrivate =
  recordStat?.isFile() === true &&
  (process.getuid === undefined || recordStat.uid === process.getuid()) &&
  (recordStat.mode & 0o077) === 0
const [canonicalRecordDataDirectory, canonicalExpectedDataDirectory] =
  await Promise.all([
    record ? realpath(record.dataDir).catch(() => null) : null,
    realpath(expectedDataDirectory).catch(() => null)
  ])
const recordIsValid =
  recordIsPrivate &&
  record !== null &&
  canonicalRecordDataDirectory !== null &&
  canonicalRecordDataDirectory === canonicalExpectedDataDirectory &&
  apiUrl !== null &&
  apiUrl.protocol === 'http:' &&
  (apiUrl.hostname === '127.0.0.1' || apiUrl.hostname === '[::1]') &&
  apiUrl.username === '' &&
  apiUrl.password === '' &&
  apiUrl.pathname === '/' &&
  apiUrl.search === '' &&
  apiUrl.hash === ''

let health = null
if (recordIsValid) {
  health = await fetch(new URL('/api/health', apiUrl), {
    redirect: 'error',
    signal: AbortSignal.timeout(1_500)
  })
    .then(async (response) => {
      if (!response.ok) {
        return null
      }

      const parsed = healthSchema.safeParse(await response.json())
      return parsed.success ? parsed.data : null
    })
    .catch(() => null)
}

const processCommand = recordIsValid
  ? spawnSync('ps', ['-p', String(record.pid), '-o', 'command='], {
      encoding: 'utf8'
    })
  : null
const expectedServerEntrypoint = path.join(
  applicationRoot,
  '.treeport-dev-dist/node/server/index.js'
)
const processMatches =
  processCommand?.status === 0 &&
  (processCommand.stdout.trim() === 'treeport-server-dev' ||
    processCommand.stdout.includes(expectedServerEntrypoint))
const healthMatches =
  health !== null &&
  health.pid === record?.pid &&
  health.instanceId === record?.instanceId &&
  health.installationMethod === 'development' &&
  health.daemonLifecycle === 'external'

if (!processMatches || !healthMatches) {
  console.error(
    'The Treeport development daemon record is stale or belongs to another process.'
  )
  if (record) {
    console.error(`Recorded PID: ${record.pid}`)
  }

  process.exit(1)
}

const cliIsExecutable = await access(cliEntrypoint, fsConstants.X_OK).then(
  () => true,
  () => false
)
if (!cliIsExecutable) {
  console.error(`Treeport development CLI is not available: ${cliEntrypoint}`)
  console.error('Start the development instance with: pnpm dev')
  process.exit(1)
}

const inheritedApiUrl = process.env.TREEPORT_API_URL?.replace(/\/$/, '')
const verifiedApiUrl = apiUrl.href.replace(/\/$/, '')
if (inheritedApiUrl !== verifiedApiUrl) {
  delete process.env.TREEPORT_MANAGED_API_URL
  delete process.env.TREEPORT_PROJECT_ID
  delete process.env.TREEPORT_WORKTREE_ID
  delete process.env.TREEPORT_TERMINAL_ID
}

delete process.env.TREEPORT_WEB_DEVELOPMENT
delete process.env.TREEPORT_WEB_DIST

process.env.TREEPORT_API_URL = verifiedApiUrl
process.env.TREEPORT_DATA_DIR = canonicalExpectedDataDirectory
process.env.TREEPORT_RUNTIME_DIR = runtimeDirectory
process.env.TREEPORT_DAEMON_RECORD = recordPath
process.env.TREEPORT_DAEMON_LIFECYCLE = 'external'
process.env.TREEPORT_CLI_ENTRYPOINT = process.argv[1]

await import(pathToFileURL(cliEntrypoint).href)
