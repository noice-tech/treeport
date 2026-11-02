import { spawnSync } from 'node:child_process'

export function runSteps(cwd, steps) {
  for (const [label, command, args] of steps) {
    const startedAt = Date.now()
    process.stdout.write(`${label}…`)

    const step = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024
    })

    if (step.status !== 0) {
      process.stdout.write(' failed\n\n')
      process.stderr.write(step.error ? `${step.error.message}\n` : '')
      process.stderr.write(step.stdout ?? '')
      process.stderr.write(step.stderr ?? '')

      return step.status ?? 1
    }

    process.stdout.write(
      ` done (${Math.round((Date.now() - startedAt) / 1000)}s)\n`
    )
  }

  return 0
}
