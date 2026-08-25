import { api } from '@electron-forge/core'
import net from 'node:net'
import { z } from 'zod'

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

await api.start({ dir: process.cwd(), interactive: process.stdout.isTTY })
