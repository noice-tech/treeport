import { createWriteStream } from 'node:fs'
import { stripVTControlCharacters } from 'node:util'
import * as Effect from 'effect/Effect'
import { checkHealth } from './backend-connection'
import type { LocalServerUpdate } from './desktop-contract'
import { applyUpdateEvent, type UpdateResult } from './local-server'

const RESTART_TIMEOUT_MS = 90_000

export async function runRemoteUpdate(
  origin: string,
  logPath: string,
  changed: (update: LocalServerUpdate) => void
): Promise<UpdateResult> {
  const result: UpdateResult = {
    outcome: 'updated',
    head: null,
    local: 0,
    remote: 0
  }

  let update: LocalServerUpdate = {
    status: 'running',
    startedAt: Date.now(),
    steps: [],
    commits: null,
    error: null,
    output: []
  }

  const setUpdate = (next: Partial<LocalServerUpdate>) => {
    update = { ...update, ...next }
    changed(update)
  }

  const fail = (error: string, output: string[] = []) => {
    result.outcome = 'failed'
    setUpdate({ status: 'failed', error, output })

    return result
  }

  setUpdate({})

  const before = await Effect.runPromise(checkHealth(origin))

  if (!before) {
    return fail('This computer couldn’t be reached.')
  }

  const response = await fetch(new URL('/api/update', origin), {
    method: 'POST',
    redirect: 'error'
  }).catch(() => null)

  if (!response?.ok || !response.body) {
    const body = await response?.json().catch(() => null)

    return fail(
      body?.error?.message ??
        'This computer couldn’t start the update. Update its Treeport from that computer once.'
    )
  }

  const log = createWriteStream(logPath)
  const decoder = new TextDecoder()
  const output: string[] = []
  let pending = ''
  let exitCode: number | null = null

  const handle = (line: string) => {
    if (!line.startsWith('::treeport ')) {
      log.write(`${line}\n`)
      output.push(line)

      return
    }

    const event = JSON.parse(line.slice('::treeport '.length))

    if (event.type === 'exit') {
      exitCode = event.code
    } else {
      setUpdate(applyUpdateEvent(update, result, event))
    }
  }

  // EXTERNAL: The server restarts itself at the end of the update, which drops the
  // stream without an error we can tell apart from a lost connection.
  await response.body
    .pipeTo(
      new WritableStream({
        write(chunk) {
          const lines = (
            pending + decoder.decode(chunk, { stream: true })
          ).split('\n')

          pending = lines.pop() ?? ''
          lines.forEach(handle)
        }
      })
    )
    .catch(() => undefined)

  if (pending) {
    handle(pending)
  }

  log.end()

  const errors = stripVTControlCharacters(output.join('\n'))
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== '' && !line.startsWith('Update stopped.'))
    .slice(-4)

  if (result.outcome === 'diverged') {
    setUpdate({ status: 'failed' })

    return result
  }

  if (result.outcome === 'up-to-date') {
    return result
  }

  if (result.head === null) {
    const failed = update.steps.find((step) => step.status === 'failed')

    return fail(
      failed
        ? `${failed.label} failed. Its running Treeport wasn’t changed.`
        : exitCode === null
          ? 'Lost the connection while updating.'
          : 'The update stopped. Its running Treeport wasn’t changed.',
      errors
    )
  }

  const restarting = (
    status: 'running' | 'done' | 'failed',
    seconds: number | null
  ) =>
    setUpdate({
      steps: update.steps.map((step) =>
        step.label === 'Restarting' ? { ...step, status, seconds } : step
      )
    })

  restarting('running', null)
  const startedAt = Date.now()
  let restarted = false

  while (Date.now() - startedAt < RESTART_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const health = await Effect.runPromise(checkHealth(origin))

    if (health && health.pid !== before.pid) {
      restarted = true
      break
    }

    const finishedWithoutRestart = health !== null && exitCode !== null

    if (finishedWithoutRestart) {
      break
    }
  }

  restarting(
    restarted ? 'done' : 'failed',
    Math.round((Date.now() - startedAt) / 1000)
  )

  if (!restarted) {
    return fail(
      'Treeport updated but didn’t restart. Restart it on that computer.',
      errors
    )
  }

  setUpdate({
    status: 'updated',
    steps: update.steps.filter((step) => step.status !== 'pending')
  })

  return result
}
