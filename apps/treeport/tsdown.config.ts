import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { defineConfig } from 'tsdown'
import { appendDaemonLog } from './src/server/daemon-log.ts'

// EXTERNAL: tsdown reimports this module when its config changes. Keep the shutdown queue
// across those imports so the replacement cannot race the previous listener.
// SAFETY: This optional process-local slot is initialized below and owned only here.
const developmentGlobal = globalThis as typeof globalThis & {
  treeportDevelopmentServer?: { stopped: Promise<void> }
}

const developmentServer = (developmentGlobal.treeportDevelopmentServer ??= {
  stopped: Promise.resolve()
})

export default defineConfig({
  entry: {
    'node/cli/index': 'src/cli/index.ts',
    'node/server/index': 'src/server/index.ts',
    'node/server/main': 'src/server/main.ts',
    'node/server/daemon-log-worker': 'src/server/daemon-log-worker.ts',
    'node/server/browser-relay': 'src/server/browser-relay.ts',
    'node/server/terminal-engine-worker':
      'src/terminal-runtime/engine-worker.ts',
    'node/server/terminal-host-preflight': 'src/terminal-runtime/preflight.ts',
    'node/server/core/launcher': 'src/terminal-runtime/launcher.ts',
    'session-journal': 'src/terminal-runtime/session-journal.ts',
    'session-protocol': 'src/terminal-runtime/session-protocol.ts'
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  fixedExtension: false,
  outDir: 'dist',
  clean: false,
  sourcemap: false,
  dts: false,
  copy: 'src/ghostty-vt/ghostty-vt.wasm',
  onSuccess(resolvedConfig, signal) {
    if (!resolvedConfig.watch) {
      return
    }

    developmentServer.stopped = developmentServer.stopped.then(async () => {
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

      let stopRequested = false

      const stop = () => {
        stopRequested = true
        server.kill('SIGTERM')
      }

      signal.addEventListener('abort', stop, { once: true })

      const result = await once(server, 'exit').then(
        ([code, exitSignal]) => ({ code, signal: exitSignal, error: null }),
        (error: Error) => ({
          code: null,
          signal: null,
          error: error.stack ?? error.message
        })
      )

      const event = `${JSON.stringify({ timestamp: new Date().toISOString(), event: 'development_child_exit', childPid: server.pid ?? null, stopRequested, ...result })}\n`
      appendDaemonLog(
        path.resolve(
          process.env.TREEPORT_DATA_DIR || '.treeport-dev/data',
          'logs',
          'daemon-launcher.log'
        ),
        event
      )

      if (result.error) {
        console.error(result.error)
      }

      signal.removeEventListener('abort', stop)
    })
  },
  deps: {
    neverBundle: true,
    alwaysBundle: [/^@treeport\/shared(?:\/|$)/]
  }
})
