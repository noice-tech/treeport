import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ExecOptions, ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type, type Static, type TSchema } from 'typebox'
import { Value } from 'typebox/value'

const TreeportCliErrorBodySchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String(),
        message: Type.String()
      },
      { additionalProperties: true }
    )
  },
  { additionalProperties: true }
)

type TreeportCliErrorBody = Static<typeof TreeportCliErrorBodySchema>

class TreeportCliError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(`[${code}] ${message}`)
    this.name = 'TreeportCliError'
  }
}

function parseJson<T extends TSchema>(
  value: string,
  schema: T
): Static<T> | null {
  try {
    return Value.Parse(schema, JSON.parse(value))
  } catch {
    return null
  }
}

function conciseError(value: string): string {
  return (value.split(/\n\n(?:AI agents:|Usage:)/, 1)[0] ?? value).trim()
}

async function treeportExecutable(): Promise<string> {
  const configured = process.env.TREEPORT_CLI_ENTRYPOINT?.trim()
  if (
    configured &&
    (await access(configured, fsConstants.X_OK).then(
      () => true,
      () => false
    ))
  ) {
    return configured
  }

  const daemonRecord = process.env.TREEPORT_DAEMON_RECORD?.trim()
  if (daemonRecord) {
    const developmentRuntime = dirname(dirname(daemonRecord))
    if (basename(developmentRuntime) === '.treeport-dev') {
      const developmentCli = join(
        dirname(developmentRuntime),
        '.treeport-dev-dist/node/cli/index.js'
      )
      if (
        await access(developmentCli, fsConstants.X_OK).then(
          () => true,
          () => false
        )
      ) {
        return developmentCli
      }
    }
  }

  return 'treeport'
}

export async function runTreeportJson<T extends TSchema>(
  pi: Pick<ExtensionAPI, 'exec'>,
  args: readonly string[],
  schema: T,
  options: {
    cwd: string
    signal: AbortSignal | undefined
    timeout: number
  }
): Promise<Static<T>> {
  const jsonArgs = [...args]
  const separator = jsonArgs.indexOf('--')
  jsonArgs.splice(separator === -1 ? jsonArgs.length : separator, 0, '--json')

  const execOptions: ExecOptions = {
    cwd: options.cwd,
    timeout: options.timeout
  }
  if (options.signal) {
    execOptions.signal = options.signal
  }

  const result = await pi.exec(
    await treeportExecutable(),
    jsonArgs,
    execOptions
  )

  if (result.code !== 0) {
    const parsed: TreeportCliErrorBody | null = parseJson(
      result.stderr.trim(),
      TreeportCliErrorBodySchema
    )
    const code = parsed
      ? parsed.error.code
      : result.killed
        ? options.signal?.aborted
          ? 'TREEPORT_CANCELLED'
          : 'TREEPORT_EXECUTION_TIMEOUT'
        : 'TREEPORT_EXECUTION_FAILED'
    const message = parsed
      ? conciseError(parsed.error.message)
      : result.killed
        ? options.signal?.aborted
          ? 'The Treeport command was cancelled.'
          : 'The Treeport command reached its execution time limit.'
        : result.stderr.trim()
          ? `${conciseError(result.stderr)} (Treeport exit code ${result.code}).`
          : `Treeport exited with code ${result.code}.`
    throw new TreeportCliError(code, message)
  }

  const output = result.stdout.trim()
  const parsed: Static<T> | null = parseJson(output, schema)
  if (parsed === null) {
    throw new TreeportCliError(
      'TREEPORT_INVALID_JSON',
      output
        ? 'Treeport returned invalid JSON.'
        : 'Treeport returned no JSON output.'
    )
  }

  return parsed
}
