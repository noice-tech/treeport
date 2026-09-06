// Controlled staged CLI/daemon boundary, executed through the real update launcher.
import fs from 'node:fs/promises'
import path from 'node:path'

const root = process.env.UPDATE_CONTRACT_ROOT
const config = JSON.parse(
  await fs.readFile(path.join(root, 'config.json'), 'utf8')
)
const { version } = JSON.parse(
  await fs.readFile(new URL('../../../package.json', import.meta.url), 'utf8')
)
const args = process.argv.slice(2)
const current = await fs
  .realpath(path.join(root, 'prefix/lib/treeport/current'))
  .catch(() => null)
const operation = JSON.parse(
  await fs.readFile(path.join(root, 'data/updates/operation.json'), 'utf8')
)
await fs.appendFile(
  path.join(root, 'events.jsonl'),
  `${JSON.stringify({
    command: args[0],
    args,
    version,
    current,
    phase: operation.phase,
    entrypoint: process.env.TREEPORT_CLI_ENTRYPOINT,
    dataDir: process.env.TREEPORT_DATA_DIR,
    runtimeDir: process.env.TREEPORT_RUNTIME_DIR,
    apiUrl: process.env.TREEPORT_API_URL
  })}\n`
)
if (args[0] === 'version') {
  if (config.verification === 'exit') {
    process.exit(1)
  }

  console.log(
    config.verification === 'invalid-json'
      ? 'invalid'
      : JSON.stringify({
          cli: config.verification === 'wrong-version' ? '9.9.9' : version,
          daemon: null
        })
  )
} else if (args[0] === 'start') {
  const pendingPath = path.join(root, 'data/updates/pending-startup.json')
  const pending = await fs
    .readFile(pendingPath, 'utf8')
    .then(JSON.parse)
    .catch(() => null)
  if (pending) {
    const reportPath = path.join(root, 'data/updates/startup-report.json')
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'))
    if (config.evidence === 'missing') {
      await fs.rm(reportPath)
    } else if (config.evidence === 'malformed') {
      await fs.writeFile(reportPath, '{broken')
    } else {
      await fs.writeFile(
        reportPath,
        JSON.stringify({
          ...report,
          operationId:
            config.evidence === 'wrong-operation'
              ? '00000000-0000-4000-8000-000000000000'
              : pending.operationId,
          targetVersion:
            config.evidence === 'wrong-target'
              ? '9.9.9'
              : pending.targetVersion,
          migrationState: config.evidence?.startsWith('wrong-')
            ? 'unchanged'
            : config.evidence,
          ready: !config.startFailure,
          error: config.startFailure ? 'controlled startup failure' : null
        })
      )
    }

    if (config.startFailure) {
      process.exit(1)
    }
  }

  await fs.writeFile(path.join(root, 'started'), version)
  console.log('{}')
} else {
  throw new Error(`Unexpected CLI command: ${args.join(' ')}`)
}
