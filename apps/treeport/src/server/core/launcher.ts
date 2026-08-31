#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { TERMINAL_NAME_MAX_LENGTH } from '@treeport/shared'
import { integrateShellLaunch } from './shell-integration'
import type { TerminalLaunchSpec } from './terminal'

const FORWARDED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

const launchSpecSchema = z
  .object({
    argv: z.array(z.string()),
    initialTitle: z
      .string()
      .trim()
      .min(1)
      .max(TERMINAL_NAME_MAX_LENGTH)
      .optional(),
    fallbackArgv: z.array(z.string()).optional(),
    cwd: z.string(),
    env: z.record(z.string(), z.string()),
    shellIntegrationDir: z.string().optional(),
    setupTasks: z
      .array(
        z
          .object({
            label: z.string(),
            argv: z.array(z.string()),
            cwd: z.string(),
            env: z.record(z.string(), z.string()),
            timeoutMs: z.number()
          })
          .strict()
      )
      .optional(),
    setupError: z.string().optional()
  })
  .strict() satisfies z.ZodType<TerminalLaunchSpec>

interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): void
  off(signal: NodeJS.Signals, listener: () => void): void
}
type Writable = Pick<NodeJS.WritableStream, 'write'>

interface LauncherChild {
  kill(signal: NodeJS.Signals): boolean
  once(event: 'error', listener: (error: Error) => void): this
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this
}

type SpawnProcess = (
  executable: string,
  args: readonly string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    stdio: 'inherit'
    shell: false
  }
) => LauncherChild

export interface LauncherDependencies {
  spawnProcess?: SpawnProcess
  stdout?: Writable
  stderr?: Writable
  signalSource?: SignalSource
}

interface ChildResult {
  code: number | null
  signal: NodeJS.Signals | null
  forwardedSignal: NodeJS.Signals | null
  timedOut: boolean
  spawnError: Error | null
}

function safeDiagnostic(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)
        ? ' '
        : character
    })
    .join('')
    .trim()
}

function safeLabel(label: string): string {
  return safeDiagnostic(label) || 'setup task'
}

function runChild(
  argv: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    timeoutMs?: number
    spawnProcess: SpawnProcess
    signalSource: SignalSource
  }
): Promise<ChildResult> {
  const [executable, ...args] = argv
  if (!executable) {
    return Promise.resolve({
      code: 127,
      signal: null,
      forwardedSignal: null,
      timedOut: false,
      spawnError: new Error('argv is empty')
    })
  }

  return new Promise((resolve) => {
    let child: LauncherChild
    try {
      child = options.spawnProcess(executable, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: 'inherit',
        shell: false
      })
    } catch (error) {
      resolve({
        code: 127,
        signal: null,
        forwardedSignal: null,
        timedOut: false,
        spawnError: error instanceof Error ? error : new Error(String(error))
      })
      return
    }

    let settled = false
    let timedOut = false
    let forwardedSignal: NodeJS.Signals | null = null
    let timer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    const forwarders = FORWARDED_SIGNALS.map(
      (signal) =>
        [
          signal,
          () => {
            forwardedSignal ??= signal
            child.kill(signal)
          }
        ] as const
    )
    const finish = (result: ChildResult) => {
      if (settled) {
        return
      }

      settled = true
      if (timer) {
        clearTimeout(timer)
      }

      if (killTimer) {
        clearTimeout(killTimer)
      }

      for (const [signal, forward] of forwarders) {
        options.signalSource.off(signal, forward)
      }
      resolve(result)
    }
    for (const [signal, forward] of forwarders) {
      options.signalSource.on(signal, forward)
    }
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
        killTimer.unref?.()
      }, options.timeoutMs)
      timer.unref?.()
    }

    child.once('error', (error) =>
      finish({
        code: 127,
        signal: null,
        forwardedSignal,
        timedOut,
        spawnError: error
      })
    )
    child.once('exit', (code, signal) =>
      finish({ code, signal, forwardedSignal, timedOut, spawnError: null })
    )
  })
}

export async function runLaunchSpec(
  spec: TerminalLaunchSpec,
  dependencies: LauncherDependencies = {}
): Promise<number> {
  const spawnProcess = dependencies.spawnProcess ?? spawn
  const stdout = dependencies.stdout ?? process.stdout
  const stderr = dependencies.stderr ?? process.stderr
  const signalSource = dependencies.signalSource ?? process
  if (spec.setupError) {
    stderr.write(
      `[Treeport setup] ${safeDiagnostic(spec.setupError) || 'setup preparation failed'}\n`
    )
    return 1
  }

  for (const task of spec.setupTasks ?? []) {
    const label = safeLabel(task.label)
    stdout.write(`[Treeport setup] ${label}\n`)
    const result = await runChild(task.argv, {
      cwd: task.cwd,
      env: { ...process.env, ...spec.env, ...task.env },
      timeoutMs: task.timeoutMs,
      spawnProcess,
      signalSource
    })
    if (result.spawnError) {
      stderr.write(
        `[Treeport setup] ${label} failed: ${safeDiagnostic(result.spawnError.message) || 'spawn error'}\n`
      )
      return 127
    }

    if (result.timedOut) {
      stderr.write(
        `[Treeport setup] ${label} failed: timed out after ${task.timeoutMs}ms\n`
      )
      return 124
    }

    const terminationSignal = result.forwardedSignal ?? result.signal
    if (terminationSignal) {
      stderr.write(
        `[Treeport setup] ${label} failed: terminated by ${terminationSignal}\n`
      )
      return 1
    }

    if (result.code !== 0) {
      stderr.write(
        `[Treeport setup] ${label} failed: exit ${result.code ?? 1}\n`
      )
      return result.code ?? 1
    }

    stdout.write(`[Treeport setup] ${label} complete\n`)
  }

  if (!spec.argv[0]) {
    stderr.write('Treeport launcher: argv is empty\n')
    return 127
  }

  const commandEnvironment = { ...process.env, ...spec.env }
  const command = integrateShellLaunch(
    spec.argv,
    commandEnvironment,
    spec.shellIntegrationDir,
    Boolean(spec.shellIntegrationDir)
  )
  const initialTitle = spec.initialTitle
    ? safeDiagnostic(spec.initialTitle)
    : ''
  if (initialTitle && spec.shellIntegrationDir) {
    stdout.write(`\u001b]777;command;${initialTitle}\u001b\\`)
  }

  const result = await runChild(command.argv, {
    cwd: spec.cwd,
    env: command.env,
    spawnProcess,
    signalSource
  })
  if (result.spawnError) {
    stderr.write(
      `Treeport launcher: ${safeDiagnostic(result.spawnError.message) || 'spawn error'}\n`
    )
  }

  if (
    result.forwardedSignal &&
    (!spec.fallbackArgv || result.forwardedSignal !== 'SIGINT')
  ) {
    return 1
  }

  if (spec.fallbackArgv) {
    if (spec.shellIntegrationDir) {
      stdout.write('\u001b]777;command;\u001b\\')
    }

    const fallback = integrateShellLaunch(
      spec.fallbackArgv,
      commandEnvironment,
      spec.shellIntegrationDir,
      Boolean(spec.shellIntegrationDir)
    )
    const fallbackResult = await runChild(fallback.argv, {
      cwd: spec.cwd,
      env: fallback.env,
      spawnProcess,
      signalSource
    })
    if (fallbackResult.spawnError) {
      stderr.write(
        `Treeport launcher: ${safeDiagnostic(fallbackResult.spawnError.message) || 'spawn error'}\n`
      )
      return 127
    }

    if (fallbackResult.forwardedSignal || fallbackResult.signal) {
      return 1
    }

    return fallbackResult.code ?? 1
  }

  if (result.spawnError) {
    return 127
  }

  if (result.signal) {
    return 1
  }

  return result.code ?? 1
}

async function main(): Promise<void> {
  const specPath = process.argv[2]
  if (!specPath) {
    process.stderr.write('Treeport launcher: missing launch spec\n')
    process.exit(127)
  }

  let spec: TerminalLaunchSpec
  try {
    spec = launchSpecSchema.parse(
      JSON.parse(await fs.readFile(specPath, 'utf8'))
    )
  } catch (error) {
    process.stderr.write(
      `Treeport launcher: cannot read launch spec: ${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exit(127)
  }
  process.exit(await runLaunchSpec(spec))
}

const invokedPath = process.argv[1]
if (
  invokedPath &&
  path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url))
) {
  void main()
}
