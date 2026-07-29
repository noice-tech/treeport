#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { integrateShellLaunch } from './shell-integration'
import type { LaunchSpec } from './tmux'

const FORWARDED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown
  off(signal: NodeJS.Signals, listener: () => void): unknown
}
type Writable = Pick<NodeJS.WritableStream, 'write'>

export interface LauncherDependencies {
  spawnProcess?: typeof spawn
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
    spawnProcess: typeof spawn
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
    let child: ChildProcess
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
  spec: LaunchSpec,
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
    spec.tmuxExecutable
  )
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
    const fallback = integrateShellLaunch(
      spec.fallbackArgv,
      commandEnvironment,
      spec.shellIntegrationDir,
      spec.tmuxExecutable
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

  let spec: LaunchSpec
  try {
    spec = JSON.parse(await fs.readFile(specPath, 'utf8')) as LaunchSpec
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
