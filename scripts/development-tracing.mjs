import { fileURLToPath } from 'node:url'

if (process.env.TREEPORT_DAEMON_RECORD) {
  delete process.env.TREEPORT_TRACE_DIR
  delete process.env.TREEPORT_TRACE_FILE
}

process.env.TREEPORT_TRACE ??= 'jsonl'

process.env.TREEPORT_TRACE_DIR ??= fileURLToPath(
  new URL('../apps/treeport/.treeport-dev/traces/', import.meta.url)
)

if (process.env.TREEPORT_TRACE === 'jsonl') {
  console.log(
    `Traces: ${process.env.TREEPORT_TRACE_FILE || process.env.TREEPORT_TRACE_DIR}`
  )
}
