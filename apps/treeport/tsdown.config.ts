import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { defineConfig } from 'tsdown'

let serverStopped = Promise.resolve()

export default defineConfig({
  entry: {
    'node/cli/index': 'src/cli/index.ts',
    'node/server/index': 'src/server/index.ts',
    'node/server/core/launcher': 'src/server/core/launcher.ts'
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  fixedExtension: false,
  outDir: 'dist',
  clean: false,
  sourcemap: false,
  dts: false,
  onSuccess(resolvedConfig, signal) {
    if (!resolvedConfig.watch) {
      return
    }

    serverStopped = serverStopped.then(async () => {
      if (signal.aborted) {
        return
      }

      const server = spawn(
        process.execPath,
        [
          '--enable-source-maps',
          path.join(
            resolvedConfig.outDir ?? 'dist',
            'node',
            'server',
            'index.js'
          )
        ],
        { cwd: resolvedConfig.cwd, stdio: 'inherit' }
      )
      const stop = () => server.kill('SIGTERM')
      signal.addEventListener('abort', stop, { once: true })

      await once(server, 'exit').catch((error: Error) => {
        console.error(`Could not start Treeport server: ${error.message}`)
      })
      signal.removeEventListener('abort', stop)
    })
  },
  deps: {
    neverBundle: true,
    alwaysBundle: ['@treeport/shared']
  }
})
