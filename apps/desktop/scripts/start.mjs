import '../../../scripts/development-tracing.mjs'
import { api } from '@electron-forge/core'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { prepareDevelopmentApp } from './prepare-dev-app.mjs'

if (process.platform === 'darwin') {
  await prepareDevelopmentApp()
}

async function allocatePort(host, excludedPorts = new Set()) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer()
      server.unref()
      server.once('error', reject)
      server.listen({ host, port: 0 }, () => {
        const address = z
          .object({ port: z.number().int().positive() })
          .safeParse(server.address())
        if (!address.success) {
          server.close()
          reject(new Error(`Could not allocate a port on ${host}.`))
          return
        }

        server.close((error) => {
          if (error) {
            reject(error)
          } else {
            resolve(address.data.port)
          }
        })
      })
    })
    if (!excludedPorts.has(port)) {
      return port
    }
  }

  throw new Error(`Could not allocate a unique port on ${host}.`)
}

if (!process.env.TREEPORT_DESKTOP_RENDERER_PORT?.trim()) {
  process.env.TREEPORT_DESKTOP_RENDERER_PORT = String(
    await allocatePort('localhost')
  )
}

if (!process.env.TREEPORT_DESKTOP_DEBUG_PORT?.trim()) {
  process.env.TREEPORT_DESKTOP_DEBUG_PORT = String(
    await allocatePort(
      '127.0.0.1',
      new Set([
        z.coerce
          .number()
          .int()
          .min(1)
          .max(65535)
          .parse(process.env.TREEPORT_DESKTOP_RENDERER_PORT)
      ])
    )
  )
}

const debugPort = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.TREEPORT_DESKTOP_DEBUG_PORT)
// Electron permission checks share the development daemon's diagnostic file,
// without flooding Forge's inherited console output.
process.env.TREEPORT_BROWSER_PERMISSION_LOG = path.resolve(
  fileURLToPath(new URL('../../treeport/', import.meta.url)),
  process.env.TREEPORT_DATA_DIR || '.treeport-dev/data',
  'logs/daemon.log'
)
await api.start({
  dir: process.cwd(),
  interactive: process.stdout.isTTY,
  args: [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debugPort}`
  ]
})
