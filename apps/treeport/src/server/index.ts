import { inspect } from 'node:util'
import { installDaemonDiagnostics } from './daemon-diagnostics'

const diagnostics = installDaemonDiagnostics(new URL(import.meta.url))
// Load application dependencies only after fatal monitoring is installed.
try {
  const { main } = await import('./main')
  await main(diagnostics, new URL(import.meta.url))
} catch (error) {
  diagnostics.failed(inspect(error, { depth: 8, colors: false }), 'startup')
  throw error
}
