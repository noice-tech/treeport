import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverEntry = path.join(appRoot, 'dist/node/server/index.js')
const webDist = path.join(appRoot, 'dist/web')
const warmRuns = Number.parseInt(
  process.env.TREEPORT_BENCHMARK_RUNS || '20',
  10
)
const timeoutMs = 15_000

const percentile = (samples, value) => {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)
  ]
}

const availablePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address?.port ?? 0
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })

const waitForHealth = async (url, child) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Treeport exited with code ${child.exitCode}`)
    }

    const response = await fetch(`${url}/api/health`).catch(() => null)
    if (response?.ok) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error('Treeport did not become ready')
}

const encodedPrintCommand = (sentinel) => {
  const octal = [...Buffer.from(`${sentinel}\n`)]
    .map((byte) => `\\${byte.toString(8).padStart(3, '0')}`)
    .join('')
  return `printf '${octal}'`
}

async function measureCreation(page, worktreeName, serial) {
  const sentinel = `TREEPORT_READY_${serial}_${crypto.randomUUID().replaceAll('-', '')}`
  await page
    .getByRole('button', { name: `New panel in ${worktreeName}` })
    .click()
  const shell = page
    .getByRole('dialog', { name: 'New panel' })
    .getByRole('button', { name: 'Shell', exact: true })
  const originUrl = page.url()
  const createRequestStarted = page
    .waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname.endsWith('/terminals'),
      { timeout: timeoutMs }
    )
    .then(() => performance.now())
  const createResponseReceived = page
    .waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/terminals'),
      { timeout: timeoutMs }
    )
    .then((response) => ({ at: performance.now(), status: response.status() }))
  const startedAt = performance.now()
  await shell.click()
  await page.waitForURL(
    (url) => url.href !== originUrl && url.pathname.includes('/terminals/'),
    { timeout: timeoutMs }
  )
  const routeSelectedAt = performance.now()
  const input = page.locator('.xterm-helper-textarea')
  await input.waitFor({ state: 'attached', timeout: timeoutMs })
  await page
    .getByText('Controlling terminal', { exact: true })
    .waitFor({ state: 'attached', timeout: timeoutMs })
  const browserReadyAt = performance.now()
  await input.focus()
  await page.keyboard.insertText(encodedPrintCommand(sentinel))
  await page.keyboard.press('Enter')
  const inputSentAt = performance.now()
  try {
    await page
      .locator('.xterm-rows')
      .filter({ hasText: sentinel })
      .waitFor({ state: 'visible', timeout: timeoutMs })
  } catch (error) {
    const screen = await page.locator('.xterm-rows').textContent()
    throw new Error(
      `Sentinel output did not render. Screen: ${JSON.stringify(screen)}`,
      { cause: error }
    )
  }
  const outputRenderedAt = performance.now()
  const createResponse = await createResponseReceived
  return {
    status: createResponse.status,
    terminalId: new URL(page.url()).pathname.split('/').at(-1),
    totalMs: outputRenderedAt - startedAt,
    stagesMs: {
      createRequestStarted: (await createRequestStarted) - startedAt,
      createResponseReceived: createResponse.at - startedAt,
      terminalRouteSelected: routeSelectedAt - startedAt,
      browserReady: browserReadyAt - startedAt,
      sentinelInputSent: inputSentAt - startedAt,
      sentinelOutputRendered: outputRenderedAt - startedAt
    }
  }
}

async function measureDeletionChurn(page, worktree, worktreeName) {
  const createBurst = async (count) =>
    page.evaluate(
      async ({ worktreeId, count }) => {
        const startedAt = performance.now()
        return Promise.all(
          Array.from({ length: count }, async () => {
            const response = await fetch(
              `/api/worktrees/${worktreeId}/terminals`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'Shell' })
              }
            )
            const completedAt = performance.now()
            const body = await response.json()
            return {
              status: response.status,
              terminalId: body.terminal?.id ?? null,
              responseMs: completedAt - startedAt
            }
          })
        )
      },
      { worktreeId: worktree.id, count }
    )

  const oldTerminals = await createBurst(10)
  const oldIds = oldTerminals.map((result) => result.terminalId)
  if (
    oldTerminals.some((result) => result.status !== 201) ||
    oldIds.some((terminalId) => !terminalId)
  ) {
    throw new Error(`Churn setup failed: ${JSON.stringify(oldTerminals)}`)
  }

  let deletionsSettled = false
  const deletions = page
    .evaluate(async (terminalIds) => {
      const statuses = []
      for (const terminalId of terminalIds) {
        const response = await fetch(`/api/terminals/${terminalId}`, {
          method: 'DELETE'
        })
        statuses.push(response.status)
      }
      return statuses
    }, oldIds)
    .finally(() => {
      deletionsSettled = true
    })
  await page.waitForTimeout(25)

  const replacementStartedAt = performance.now()
  const directReplacements = await createBurst(9)
  const uiReplacement = await measureCreation(
    page,
    worktreeName,
    `churn_${crypto.randomUUID()}`
  )
  const replacementBurstMs = performance.now() - replacementStartedAt
  const replacementIds = [
    ...directReplacements.map((result) => result.terminalId),
    uiReplacement.terminalId
  ]
  const completedWhileCleanupPending = !deletionsSettled
  if (
    directReplacements.some((result) => result.status !== 201) ||
    uiReplacement.status !== 201 ||
    replacementIds.some((terminalId) => !terminalId)
  ) {
    throw new Error(
      `Replacement burst failed: ${JSON.stringify({ directReplacements, uiReplacement })}`
    )
  }

  const deletionStatuses = await deletions
  const responseTimes = [
    ...directReplacements.map((result) => result.responseMs),
    Math.max(...directReplacements.map((result) => result.responseMs)) +
      uiReplacement.stagesMs.createResponseReceived
  ]

  return {
    requested: replacementIds.length,
    created: replacementIds.filter(Boolean).length,
    distinctIds: new Set(replacementIds).size === replacementIds.length,
    statuses: [
      ...directReplacements.map((result) => result.status),
      uiReplacement.status
    ],
    deletionStatuses,
    firstReplacementMs: Number(Math.min(...responseTimes).toFixed(1)),
    responseP50Ms: Number(percentile(responseTimes, 0.5).toFixed(1)),
    responseP95Ms: Number(percentile(responseTimes, 0.95).toFixed(1)),
    replacementBurstMs: Number(replacementBurstMs.toFixed(1)),
    selectedClickToOutputMs: Number(uiReplacement.totalMs.toFixed(1)),
    selectedStagesMs: Object.fromEntries(
      Object.entries(uiReplacement.stagesMs).map(([stage, duration]) => [
        stage,
        Number(duration.toFixed(1))
      ])
    ),
    completedWhileCleanupPending,
    worktreeName
  }
}

async function runProfile(name, shell) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), `treeport-terminal-benchmark-${name}-`)
  )
  const dataDir = path.join(root, 'data')
  const runtimeDir = path.join(root, 'runtime')
  const cacheDir = path.join(root, 'cache')
  const repository = path.join(root, 'repository')
  const home = path.join(root, 'home')
  await Promise.all([
    fs.mkdir(repository, { recursive: true }),
    fs.mkdir(home, { recursive: true })
  ])
  await new Promise((resolve, reject) => {
    const git = spawn('git', ['init', '-q', repository])
    git.once('error', reject)
    git.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`git init exited ${code}`))
    )
  })

  const port = await availablePort()
  const url = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [serverEntry], {
    cwd: appRoot,
    env: {
      ...process.env,
      HOME: name === 'infrastructure' ? home : process.env.HOME,
      TREEPORT_SHELL: shell,
      TREEPORT_HOST: '127.0.0.1',
      TREEPORT_PORT: String(port),
      TREEPORT_API_URL: url,
      TREEPORT_DATA_DIR: dataDir,
      TREEPORT_RUNTIME_DIR: runtimeDir,
      TREEPORT_CACHE_DIR: cacheDir,
      TREEPORT_DATABASE_PATH: path.join(dataDir, 'treeport.db'),
      TREEPORT_DAEMON_LIFECYCLE: 'external',
      TREEPORT_WEB_DIST: webDist
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const browser = await chromium.launch({ headless: true })

  try {
    await waitForHealth(url, child)
    const registration = await fetch(`${url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: repository })
    })
    if (!registration.ok) {
      throw new Error(
        `Project registration failed: ${await registration.text()}`
      )
    }

    const { project } = await registration.json()
    const worktree = project.worktrees[0]
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 }
    })
    await page.goto(url)
    await page
      .getByRole('button', { name: `New panel in ${worktree.name}` })
      .waitFor()

    const cold = await measureCreation(page, worktree.name, `${name}_cold`)
    const warm = []
    const failures = []
    for (let index = 0; index < warmRuns; index += 1) {
      try {
        warm.push(
          await measureCreation(page, worktree.name, `${name}_${index}`)
        )
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }

    const tabsBeforeBurst = await page
      .getByRole('list', { name: `${worktree.name} terminal tabs` })
      .getByRole('listitem')
      .count()
    const burstStatuses = await page.evaluate(async (worktreeId) => {
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          fetch(`/api/worktrees/${worktreeId}/terminals`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Shell' })
          })
        )
      )
      return responses.map((response) => response.status)
    }, worktree.id)
    await page
      .getByRole('list', { name: `${worktree.name} terminal tabs` })
      .getByRole('listitem')
      .nth(tabsBeforeBurst + 4)
      .waitFor({ timeout: timeoutMs })
    const tabsAfterBurst = await page
      .getByRole('list', { name: `${worktree.name} terminal tabs` })
      .getByRole('listitem')
      .count()
    const churn = await measureDeletionChurn(page, worktree, worktree.name)
    const warmP50Ms = percentile(
      warm.map((sample) => sample.totalMs),
      0.5
    )
    const warmP95Ms = percentile(
      warm.map((sample) => sample.totalMs),
      0.95
    )

    return {
      profile: name,
      shell,
      coldMs: Number(cold.totalMs.toFixed(1)),
      coldStagesMs: Object.fromEntries(
        Object.entries(cold.stagesMs).map(([stage, duration]) => [
          stage,
          Number(duration.toFixed(1))
        ])
      ),
      warmRuns: warm.length,
      warmP50Ms: Number(warmP50Ms?.toFixed(1)),
      warmP95Ms: Number(warmP95Ms?.toFixed(1)),
      warmSamplesMs: warm.map((sample) => Number(sample.totalMs.toFixed(1))),
      burstRequested: 5,
      burstCreated: tabsAfterBurst - tabsBeforeBurst,
      burstStatuses,
      churn: {
        ...churn,
        selectedVsWarmP95Ms: Number(
          (churn.selectedClickToOutputMs - warmP95Ms).toFixed(1)
        )
      },
      failures
    }
  } finally {
    await fetch(`${url}/api/admin/terminate-terminals`, {
      method: 'POST'
    }).catch(() => undefined)
    await browser.close()
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
    await fs.rm(root, { recursive: true, force: true })
    if (child.exitCode && child.exitCode !== 143) {
      process.stderr.write(stderr)
    }
  }
}

if (
  !(await fs.stat(serverEntry).catch(() => null)) ||
  !(await fs.stat(webDist).catch(() => null))
) {
  throw new Error(
    'Build Treeport before running this benchmark: pnpm --filter @treeport/treeport build'
  )
}

if (!Number.isInteger(warmRuns) || warmRuns < 1) {
  throw new Error('TREEPORT_BENCHMARK_RUNS must be a positive integer')
}

const configuredShell =
  process.env.TREEPORT_BENCHMARK_SHELL || process.env.SHELL || '/bin/sh'
const results = []
for (const profile of [
  ['infrastructure', '/bin/sh'],
  ['configured-shell', configuredShell]
]) {
  results.push(await runProfile(...profile))
}
console.log(
  JSON.stringify(
    {
      machine: {
        platform: process.platform,
        release: os.release(),
        architecture: process.arch,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        node: process.version
      },
      targetWarmP95Ms: 250,
      results
    },
    null,
    2
  )
)
