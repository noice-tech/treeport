import { spawnSync } from 'node:child_process'

// EXTERNAL: The desktop app sets TREEPORT_PROGRESS=1 and reads these lines from stdout
// to show update progress. People running the script directly never see them.
export function report(event) {
  if (process.env.TREEPORT_PROGRESS === '1') {
    process.stdout.write(`::treeport ${JSON.stringify(event)}\n`)
  }
}

export function runSteps(cwd, steps) {
  for (const [label, command, args] of steps) {
    const startedAt = Date.now()
    report({ type: 'step', label })
    process.stdout.write(`${label}…`)

    const step = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024
    })

    const seconds = Math.round((Date.now() - startedAt) / 1000)

    if (step.status !== 0) {
      process.stdout.write(' failed\n\n')
      process.stderr.write(step.error ? `${step.error.message}\n` : '')
      process.stderr.write(step.stdout ?? '')
      process.stderr.write(step.stderr ?? '')
      report({ type: 'failed', label, seconds })

      return step.status ?? 1
    }

    process.stdout.write(` done (${seconds}s)\n`)
    report({ type: 'done', label, seconds })
  }

  return 0
}
