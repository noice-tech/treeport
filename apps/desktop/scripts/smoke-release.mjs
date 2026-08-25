#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

const [appPath, ...extra] = process.argv.slice(2)
if (!appPath || extra.length > 0) {
  throw new Error('Usage: node scripts/smoke-release.mjs <Treeport.app>')
}

const absoluteAppPath = path.resolve(appPath)
const executable = path.join(absoluteAppPath, 'Contents', 'MacOS', 'Treeport')
const userData = await fs.mkdtemp(
  path.join(os.tmpdir(), 'treeport-desktop-release-smoke-')
)
let loadedBackendApi = false
const server = http.createServer((request, response) => {
  if (request.url === '/api/health') {
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        ok: true,
        version: 'release-smoke',
        protocolVersion: 2,
        hostname: 'release-smoke'
      })
    )
    return
  }

  if (request.url === '/api/projects') {
    loadedBackendApi = true
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ projects: [] }))
    return
  }

  response.statusCode = 404
  response.end('Not found')
})
let child
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = z
    .object({ port: z.number().int() })
    .safeParse(server.address())
  if (!address.success) {
    throw new Error('Could not allocate a desktop release smoke-test port')
  }

  child = spawn(executable, [], {
    env: {
      ...process.env,
      TREEPORT_DESKTOP_E2E: '1',
      TREEPORT_DESKTOP_USER_DATA: userData,
      TREEPORT_DESKTOP_URL: `http://127.0.0.1:${address.data.port}`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const output = []
  child.stdout.on('data', (chunk) => output.push(chunk.toString()))
  child.stderr.on('data', (chunk) => output.push(chunk.toString()))

  const deadline = Date.now() + 15_000
  while (
    !loadedBackendApi &&
    child.exitCode === null &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!loadedBackendApi) {
    throw new Error(
      `Packaged desktop did not request its selected backend API${output.length ? `:\n${output.join('')}` : ''}`
    )
  }

  console.log('Packaged desktop connected to a backend successfully')
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 3_000))
    ])
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await exited
    }
  }

  await new Promise((resolve) => server.close(resolve))
  await fs.rm(userData, { recursive: true, force: true })
}
