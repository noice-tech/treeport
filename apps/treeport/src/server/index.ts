import { inspect } from 'node:util'
import { installDaemonDiagnostics } from './daemon-diagnostics.ts'

const diagnostics = installDaemonDiagnostics(new URL(import.meta.url))

try {
  const { main } = await import('./main.ts')
  await main(diagnostics, new URL(import.meta.url))
} catch (error) {
  diagnostics.failed(inspect(error, { depth: 8, colors: false }), 'startup')
  throw error
}
