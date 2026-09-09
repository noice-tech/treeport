import { fileURLToPath } from 'node:url'

// Only dev entrypoints load this module. TREEPORT_TRACE=off disables tracing;
// an explicit file keeps its existing append-only behavior and takes priority.
process.env.TREEPORT_TRACE ??= 'jsonl'
process.env.TREEPORT_TRACE_DIR ??= fileURLToPath(
  new URL('../apps/treeport/.treeport-dev/traces/', import.meta.url)
)
if (process.env.TREEPORT_TRACE === 'jsonl') {
  console.log(
    `Traces: ${process.env.TREEPORT_TRACE_FILE || process.env.TREEPORT_TRACE_DIR}`
  )
}
