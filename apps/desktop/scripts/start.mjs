import '../../../scripts/development-tracing.mjs'
import { api } from '@electron-forge/core'
import net from 'node:net'
import { z } from 'zod'
import { prepareDevelopmentApp } from './prepare-dev-app.mjs'

if (process.platform === 'darwin') {
  await prepareDevelopmentApp()
}

if (!process.env.TREEPORT_DESKTOP_RENDERER_PORT?.trim()) {
  process.env.TREEPORT_DESKTOP_RENDERER_PORT = String(
    await new Promise((resolve, reject) => {
      const server = net.createServer()
      server.unref()
      server.once('error', reject)
      server.listen({ host: 'localhost', port: 0 }, () => {
        const address = z
          .object({ port: z.number().int().positive() })
          .safeParse(server.address())
        if (!address.success) {
          server.close()
          reject(new Error('Could not allocate the desktop renderer port.'))
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
  )
}

// Opt-in local CDP access for profiling the development desktop with agent-browser.
const debugPort = process.env.TREEPORT_DESKTOP_DEBUG_PORT?.trim()
const args = debugPort
  ? [
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${z.coerce.number().int().min(1).max(65535).parse(debugPort)}`
    ]
  : []

await api.start({ dir: process.cwd(), interactive: process.stdout.isTTY, args })
