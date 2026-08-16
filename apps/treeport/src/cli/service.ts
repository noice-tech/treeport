import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { assertLoopbackHost } from '../server/core/loopback.js'
import {
  daemonDown,
  daemonHealth,
  daemonStatus,
  daemonUp,
  localPaths,
  resolveLocalApiUrl,
  resolvePackagePath,
  runDoctor,
  treeportVersion,
  type DaemonRecord,
  type DoctorCheck,
  type HealthRecord
} from './lifecycle.js'

export type ServiceManager = 'launchd' | 'systemd'
export type ServiceRequestedState = 'running' | 'stopped'
export type ServiceState =
  | 'disabled'
  | 'action_required'
  | 'starting'
  | 'healthy'
  | 'stopped'
  | 'unhealthy'
  | 'stale'

interface ServiceRecord {
  schemaVersion: 1
  manager: ServiceManager
  platform: string
  uid: number
  gid: number
  username: string
  group: string
  home: string
  dataDir: string
  runtimeDir: string
  logPath: string
  apiUrl: string
  cliEntrypoint: string
  runtimeExecutable: string | null
  runtimeEntrypoint: string | null
  installationMethod: 'curl' | 'npm'
  definitionName: string
  definitionPath: string
  definitionHash: string
  environmentHash: string
  environment: Record<string, string>
  requestedState: ServiceRequestedState
  pendingAdministratorRequestId: string | null
  createdAt: string
  updatedAt: string
}

interface AdministratorRequest {
  schemaVersion: 1
  id: string
  operation: 'enable' | 'start' | 'stop' | 'disable'
  createdAt: string
  expiresAt: string
  uid: number
  gid: number
  username: string
  group: string
  home: string
  serviceRecordPath: string
  runnerPath: string
  definitionName: string
  definitionPath: string
  stagedDefinitionPath: string
  definitionHash: string
  apiUrl: string
  cliEntrypoint: string
  runtimeExecutable: string
  runtimeEntrypoint: string
}

export interface ServiceStatus {
  supported: boolean
  manager: ServiceManager | null
  state: ServiceState
  installed: boolean
  enabledAtBoot: boolean
  active: boolean
  healthy: boolean
  rebootReady: boolean
  definitionMatches: boolean
  environmentMatches: boolean
  entrypointMatches: boolean
  requestedState: ServiceRequestedState | null
  definitionPath: string | null
  entrypoint: string | null
  daemon: {
    running: boolean
    verified: boolean
    state: DaemonRecord | null
    health: HealthRecord | null
  } | null
  issues: string[]
  recoveryCommands: string[]
  administratorCommand: string | null
}

export interface ServiceActionResult {
  status: ServiceStatus
  changed: boolean
  administratorCommand: string | null
}

export interface LaunchdDefinition {
  label: string
  programArguments: string[]
  username: string
  group: string
  environment: Record<string, string>
  workingDirectory: string
  standardOutPath: string
  standardErrorPath: string
  keepAlive: boolean
  processType: 'Background'
  throttleInterval: number
  exitTimeOut: number
  abandonProcessGroup: boolean
  umask: number
}

export interface SystemdDefinition {
  description: string
  execStart: string
  environment: Record<string, string>
  restart: 'always'
  restartSeconds: number
  timeoutStopSeconds: number
  killMode: 'process'
  wantedBy: 'default.target'
}

const serviceRecordSchema: z.ZodType<ServiceRecord> = z.strictObject({
  schemaVersion: z.literal(1),
  manager: z.enum(['launchd', 'systemd']),
  platform: z.string(),
  uid: z.number().int().nonnegative(),
  gid: z.number().int().nonnegative(),
  username: z.string().min(1),
  group: z.string().min(1),
  home: z.string().min(1),
  dataDir: z.string().min(1),
  runtimeDir: z.string().min(1),
  logPath: z.string().min(1),
  apiUrl: z.string().min(1),
  cliEntrypoint: z.string().min(1),
  runtimeExecutable: z.string().min(1).nullable().default(null),
  runtimeEntrypoint: z.string().min(1).nullable().default(null),
  installationMethod: z.enum(['curl', 'npm']),
  definitionName: z.string().min(1),
  definitionPath: z.string().min(1),
  definitionHash: z.string().length(64),
  environmentHash: z.string().length(64),
  environment: z.record(z.string(), z.string()),
  requestedState: z.enum(['running', 'stopped']),
  pendingAdministratorRequestId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
})

const administratorRequestSchema: z.ZodType<AdministratorRequest> =
  z.strictObject({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    operation: z.enum(['enable', 'start', 'stop', 'disable']),
    createdAt: z.string(),
    expiresAt: z.string(),
    uid: z.number().int().nonnegative(),
    gid: z.number().int().nonnegative(),
    username: z.string().min(1),
    group: z.string().min(1),
    home: z.string().min(1),
    serviceRecordPath: z.string().min(1),
    runnerPath: z.string().min(1),
    definitionName: z.string().min(1),
    definitionPath: z.string().min(1),
    stagedDefinitionPath: z.string().min(1),
    definitionHash: z.string().length(64),
    apiUrl: z.string().min(1),
    cliEntrypoint: z.string().min(1),
    runtimeExecutable: z.string().min(1),
    runtimeEntrypoint: z.string().min(1)
  })

function managerForPlatform(
  platform = process.platform
): ServiceManager | null {
  return platform === 'darwin'
    ? 'launchd'
    : platform === 'linux'
      ? 'systemd'
      : null
}

interface ServicePaths {
  directory: string
  recordPath: string
  runnerPath: string
  requestsDirectory: string
  stagedDefinitionPath: string
}

interface ServiceEnvironment {
  [name: string]: string
}

function servicePaths(env: NodeJS.ProcessEnv = process.env): ServicePaths {
  const paths = localPaths(env)
  const directory = path.join(paths.dataDir, 'service')
  return {
    directory,
    recordPath: path.join(directory, 'service.json'),
    runnerPath: path.join(directory, 'run'),
    requestsDirectory: path.join(directory, 'requests'),
    stagedDefinitionPath: path.join(directory, 'treeport.plist')
  }
}

async function readJson<Output>(
  filePath: string,
  schema: z.ZodType<Output>
): Promise<Output | null> {
  return fs
    .readFile(filePath, 'utf8')
    .then((value) => schema.parse(JSON.parse(value)))
    .catch(() => null)
}

async function writeJson<Value>(filePath: string, value: Value): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  })
  await fs.rename(temporaryPath, filePath)
}

function fingerprint(value: string | Record<string, string>): string {
  const parsed = z.string().safeParse(value)
  const source = parsed.success
    ? parsed.data
    : JSON.stringify(
        Object.fromEntries(
          Object.entries(value).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        )
      )
  return crypto.createHash('sha256').update(source).digest('hex')
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function createAdministratorCommand(input: {
  installationMethod: 'curl' | 'npm'
  cliEntrypoint: string
  runtimeExecutable: string
  runtimeEntrypoint: string
  requestPath: string
}): string {
  const command =
    input.installationMethod === 'curl'
      ? shellQuote(input.cliEntrypoint)
      : `${shellQuote(input.runtimeExecutable)} ${shellQuote(input.runtimeEntrypoint)}`
  return `sudo ${command} service apply --request ${shellQuote(input.requestPath)}`
}

function systemdValue(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('\n', '\\n')
}

export function createLaunchdDefinition(input: {
  label: string
  runnerPath: string
  username: string
  group: string
  environment: Record<string, string>
  home: string
  logPath: string
}): LaunchdDefinition {
  return {
    label: input.label,
    programArguments: [input.runnerPath],
    username: input.username,
    group: input.group,
    environment: input.environment,
    workingDirectory: input.home,
    standardOutPath: input.logPath,
    standardErrorPath: input.logPath,
    keepAlive: true,
    processType: 'Background',
    throttleInterval: 10,
    exitTimeOut: 10,
    abandonProcessGroup: true,
    umask: 0o077
  }
}

export function serializeLaunchdDefinition(
  definition: LaunchdDefinition
): string {
  const environment = Object.entries(definition.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([name, value]) =>
        `      <key>${xml(name)}</key>\n      <string>${xml(value)}</string>`
    )
    .join('\n')
  const argumentsXml = definition.programArguments
    .map((argument) => `      <string>${xml(argument)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(definition.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>UserName</key>
    <string>${xml(definition.username)}</string>
    <key>GroupName</key>
    <string>${xml(definition.group)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${environment}
    </dict>
    <key>WorkingDirectory</key>
    <string>${xml(definition.workingDirectory)}</string>
    <key>StandardOutPath</key>
    <string>${xml(definition.standardOutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(definition.standardErrorPath)}</string>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>${definition.processType}</string>
    <key>ThrottleInterval</key>
    <integer>${definition.throttleInterval}</integer>
    <key>ExitTimeOut</key>
    <integer>${definition.exitTimeOut}</integer>
    <key>AbandonProcessGroup</key>
    <true/>
    <key>Umask</key>
    <integer>${definition.umask}</integer>
  </dict>
</plist>
`
}

export function createSystemdDefinition(input: {
  runnerPath: string
  environment: Record<string, string>
}): SystemdDefinition {
  return {
    description: 'Treeport daemon',
    execStart: input.runnerPath,
    environment: input.environment,
    restart: 'always',
    restartSeconds: 5,
    timeoutStopSeconds: 10,
    killMode: 'process',
    wantedBy: 'default.target'
  }
}

export function serializeSystemdDefinition(
  definition: SystemdDefinition
): string {
  const environment = Object.entries(definition.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([name, value]) =>
        `Environment="${systemdValue(name)}=${systemdValue(value)}"`
    )
    .join('\n')
  return `[Unit]
Description=${definition.description}

[Service]
Type=simple
ExecStart="${systemdValue(definition.execStart)}"
${environment}
Restart=${definition.restart}
RestartSec=${definition.restartSeconds}
TimeoutStopSec=${definition.timeoutStopSeconds}
KillMode=${definition.killMode}

[Install]
WantedBy=${definition.wantedBy}
`
}

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

async function runCommand(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (value: string) => {
      stdout += value
    })
    child.stderr.on('data', (value: string) => {
      stderr += value
    })
    child.once('error', (error) => {
      resolve({ code: 127, stdout, stderr: error.message })
    })
    child.once('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

function commandError(command: string, result: CommandResult): Error {
  const detail = [result.stderr.trim(), result.stdout.trim()]
    .filter(Boolean)
    .join('\n')
  return new Error(
    `${command} failed${detail ? `: ${detail}` : ` with status ${result.code}`}`
  )
}

async function executablePath(
  name: 'id' | 'launchctl' | 'systemctl' | 'loginctl' | 'journalctl'
): Promise<string> {
  const candidates =
    name === 'launchctl'
      ? ['/bin/launchctl', '/usr/bin/launchctl']
      : [`/usr/bin/${name}`, `/bin/${name}`]
  for (const candidate of candidates) {
    if (
      await fs
        .access(candidate, fsConstants.X_OK)
        .then(() => true)
        .catch(() => false)
    ) {
      return candidate
    }
  }

  return name
}

async function primaryGroup(username: string): Promise<string> {
  const result = await runCommand(await executablePath('id'), ['-gn', username])
  if (result.code !== 0 || !result.stdout.trim()) {
    throw commandError('id -gn', result)
  }

  return result.stdout.trim()
}

function currentEntrypoint(): string | null {
  const value =
    process.env.TREEPORT_CLI_ENTRYPOINT?.trim() || process.argv[1]?.trim()
  return value ? path.resolve(value) : null
}

async function ensureEntrypoint(
  installationMethod: 'curl' | 'npm'
): Promise<string> {
  const entrypoint = currentEntrypoint()
  if (!entrypoint) {
    throw new Error(
      'Treeport could not identify a stable CLI entrypoint. Install Treeport with npm or the curl installer, then retry.'
    )
  }

  await fs.access(entrypoint, fsConstants.X_OK).catch(() => {
    throw new Error(
      `Treeport cannot execute its stable CLI entrypoint at ${entrypoint}. Reinstall Treeport, then retry.`
    )
  })
  if (installationMethod === 'npm') {
    const [actual, expected] = await Promise.all([
      fs.realpath(entrypoint),
      fs.realpath(await resolvePackagePath('bin', 'treeport.mjs'))
    ])
    if (actual !== expected) {
      throw new Error(
        `The current CLI entrypoint is not the installed Treeport npm bin: ${entrypoint}`
      )
    }
  }

  return entrypoint
}

async function currentAdministratorRuntime(): Promise<{
  runtimeExecutable: string
  runtimeEntrypoint: string
}> {
  const invokedEntrypoint = process.argv[1]?.trim()
  if (!invokedEntrypoint) {
    throw new Error('Treeport could not identify its Node entrypoint.')
  }

  const runtimeEntrypoint = path.resolve(invokedEntrypoint)
  const [
    runtimeExecutable,
    actualEntrypoint,
    packageBinEntrypoint,
    packageCliEntrypoint
  ] = await Promise.all([
    fs.realpath(process.execPath),
    fs.realpath(runtimeEntrypoint),
    fs.realpath(await resolvePackagePath('bin', 'treeport.mjs')),
    fs.realpath(await resolvePackagePath('dist', 'node', 'cli', 'index.js'))
  ])
  if (
    actualEntrypoint !== packageBinEntrypoint &&
    actualEntrypoint !== packageCliEntrypoint
  ) {
    throw new Error(
      `Treeport cannot use an unrecognized package entrypoint for administrator commands: ${runtimeEntrypoint}`
    )
  }

  await Promise.all([
    fs.access(runtimeExecutable, fsConstants.X_OK),
    fs.access(runtimeEntrypoint, fsConstants.R_OK)
  ])
  return { runtimeExecutable, runtimeEntrypoint }
}

function cacheDirectory(home: string, env: NodeJS.ProcessEnv): string {
  const configured = env.TREEPORT_CACHE_DIR?.trim()
  if (configured) {
    return path.resolve(configured.replace(/^~(?=\/|$)/, home))
  }

  if (env.XDG_CACHE_HOME?.trim()) {
    return path.join(
      path.resolve(env.XDG_CACHE_HOME.replace(/^~(?=\/|$)/, home)),
      'treeport'
    )
  }

  return process.platform === 'darwin'
    ? path.join(home, 'Library', 'Caches', 'treeport')
    : path.join(home, '.cache', 'treeport')
}

export function createServiceEnvironment(input: {
  user: os.UserInfo<string>
  paths: ReturnType<typeof localPaths>
  apiUrl: string
  recordPath: string
  installationMethod: 'curl' | 'npm'
  env?: NodeJS.ProcessEnv
}): ServiceEnvironment {
  const env = input.env ?? process.env
  const url = new URL(input.apiUrl)
  assertLoopbackHost(url.hostname)
  const result: ServiceEnvironment = {
    HOME: input.user.homedir,
    USER: input.user.username,
    LOGNAME: input.user.username,
    PATH: env.PATH?.trim() || '/usr/local/bin:/usr/bin:/bin',
    TREEPORT_HOST: url.hostname,
    TREEPORT_PORT: url.port || '80',
    TREEPORT_API_URL: input.apiUrl,
    TREEPORT_DATA_DIR: input.paths.dataDir,
    TREEPORT_RUNTIME_DIR: input.paths.runtimeDir,
    TREEPORT_CACHE_DIR: cacheDirectory(input.user.homedir, env),
    TREEPORT_DATABASE_PATH:
      env.TREEPORT_DATABASE_PATH?.trim() ||
      path.join(input.paths.dataDir, 'treeport.db'),
    TREEPORT_SHELL:
      env.TREEPORT_SHELL?.trim() || env.SHELL?.trim() || '/bin/sh',
    TREEPORT_TMUX_PATH: env.TREEPORT_TMUX_PATH?.trim() || 'tmux',
    TREEPORT_GIT_PATH: env.TREEPORT_GIT_PATH?.trim() || 'git',
    TREEPORT_GH_PATH: env.TREEPORT_GH_PATH?.trim() || 'gh',
    TREEPORT_DAEMON_LIFECYCLE: 'service',
    TREEPORT_INSTALLATION_METHOD: input.installationMethod,
    TREEPORT_SERVICE_RECORD: input.recordPath
  }
  for (const [name, value] of Object.entries(env)) {
    if (
      value !== undefined &&
      (name === 'LANG' || name === 'LC_ALL' || name.startsWith('LC_'))
    ) {
      result[name] = value
    }
  }
  return result
}

function definitionForRecord(record: ServiceRecord): string {
  if (record.manager === 'launchd') {
    return serializeLaunchdDefinition(
      createLaunchdDefinition({
        label: record.definitionName,
        runnerPath: servicePaths({ TREEPORT_DATA_DIR: record.dataDir })
          .runnerPath,
        username: record.username,
        group: record.group,
        environment: record.environment,
        home: record.home,
        logPath: record.logPath
      })
    )
  }

  return serializeSystemdDefinition(
    createSystemdDefinition({
      runnerPath: servicePaths({ TREEPORT_DATA_DIR: record.dataDir })
        .runnerPath,
      environment: record.environment
    })
  )
}

function runnerSource(record: ServiceRecord): string {
  return `#!/bin/sh
set -u
entrypoint=${shellQuote(record.cliEntrypoint)}
record=${shellQuote(servicePaths({ TREEPORT_DATA_DIR: record.dataDir }).recordPath)}
log=${shellQuote(record.logPath)}
reported=0
while [ ! -x "$entrypoint" ]; do
  if [ "$reported" -eq 0 ]; then
    mkdir -p "$(dirname "$log")"
    printf '%s Treeport service cannot start because %s is missing. Reinstall Treeport, then run treeport service enable or treeport service disable.\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$entrypoint" >> "$log"
    reported=1
  fi
  sleep 60
done
export TREEPORT_SERVICE_RECORD="$record"
exec "$entrypoint" service run
`
}

async function currentRecord(): Promise<ServiceRecord | null> {
  return readJson(servicePaths().recordPath, serviceRecordSchema)
}

async function saveRecord(record: ServiceRecord): Promise<void> {
  await writeJson(
    servicePaths({ TREEPORT_DATA_DIR: record.dataDir }).recordPath,
    record
  )
}

async function managerState(record: ServiceRecord): Promise<{
  active: boolean
  enabled: boolean
  lingering: boolean
  managerIssue: string | null
}> {
  if (record.manager === 'launchd') {
    const launchctl = await executablePath('launchctl')
    const [active, disabled, definitionExists] = await Promise.all([
      runCommand(launchctl, ['print', `system/${record.definitionName}`]),
      runCommand(launchctl, ['print-disabled', 'system']),
      fs
        .access(record.definitionPath)
        .then(() => true)
        .catch(() => false)
    ])
    return {
      active: active.code === 0,
      enabled:
        definitionExists &&
        !disabled.stdout.includes(`"${record.definitionName}" => true`),
      lingering: true,
      managerIssue: null
    }
  }

  const systemctl = await executablePath('systemctl')
  const [active, enabled, linger] = await Promise.all([
    runCommand(systemctl, ['--user', 'is-active', record.definitionName]),
    runCommand(systemctl, ['--user', 'is-enabled', record.definitionName]),
    runCommand(await executablePath('loginctl'), [
      'show-user',
      record.username,
      '-p',
      'Linger',
      '--value'
    ])
  ])
  return {
    active: active.code === 0 && active.stdout.trim() === 'active',
    enabled: enabled.code === 0 && enabled.stdout.trim() === 'enabled',
    lingering: linger.code === 0 && linger.stdout.trim() === 'yes',
    managerIssue:
      active.code === 127 ||
      active.stderr.includes('Failed to connect to bus') ||
      active.stderr.includes('No medium found')
        ? 'The systemd user manager is not available.'
        : linger.code === 127
          ? 'loginctl is not available.'
          : null
  }
}

function administratorCommand(record: ServiceRecord): string | null {
  const requestId = record.pendingAdministratorRequestId
  if (!requestId || !record.runtimeExecutable || !record.runtimeEntrypoint) {
    return null
  }

  const requestPath = path.join(
    servicePaths({ TREEPORT_DATA_DIR: record.dataDir }).requestsDirectory,
    `${requestId}.json`
  )
  return createAdministratorCommand({
    installationMethod: record.installationMethod,
    cliEntrypoint: record.cliEntrypoint,
    runtimeExecutable: record.runtimeExecutable,
    runtimeEntrypoint: record.runtimeEntrypoint,
    requestPath
  })
}

async function untrackedDefinition(): Promise<{
  manager: ServiceManager
  name: string
  path: string
} | null> {
  const manager = managerForPlatform()
  if (!manager) {
    return null
  }

  const user = os.userInfo()
  const name =
    manager === 'launchd'
      ? `app.treeport.daemon.${user.uid}`
      : 'treeport.service'
  const definitionPath =
    manager === 'launchd'
      ? `/Library/LaunchDaemons/${name}.plist`
      : path.join(
          process.env.XDG_CONFIG_HOME?.trim() ||
            path.join(user.homedir, '.config'),
          'systemd',
          'user',
          name
        )
  const exists = await fs
    .access(definitionPath)
    .then(() => true)
    .catch(() => false)
  return exists ? { manager, name, path: definitionPath } : null
}

export async function serviceInstalled(): Promise<boolean> {
  return (
    (await currentRecord()) !== null || (await untrackedDefinition()) !== null
  )
}

export async function serviceStatus(): Promise<ServiceStatus> {
  const manager = managerForPlatform()
  const record = await currentRecord()
  if (!manager) {
    return {
      supported: false,
      manager: null,
      state: 'disabled',
      installed: false,
      enabledAtBoot: false,
      active: false,
      healthy: false,
      rebootReady: false,
      definitionMatches: false,
      environmentMatches: false,
      entrypointMatches: false,
      requestedState: null,
      definitionPath: null,
      entrypoint: null,
      daemon: null,
      issues: [`Treeport service mode does not support ${process.platform}.`],
      recoveryCommands: [],
      administratorCommand: null
    }
  }

  if (!record) {
    const untracked = await untrackedDefinition()
    if (!untracked) {
      return {
        supported: true,
        manager,
        state: 'disabled',
        installed: false,
        enabledAtBoot: false,
        active: false,
        healthy: false,
        rebootReady: false,
        definitionMatches: false,
        environmentMatches: false,
        entrypointMatches: false,
        requestedState: null,
        definitionPath: null,
        entrypoint: null,
        daemon: null,
        issues: [],
        recoveryCommands: ['treeport service enable'],
        administratorCommand: null
      }
    }

    const active =
      untracked.manager === 'launchd'
        ? await runCommand(await executablePath('launchctl'), [
            'print',
            `system/${untracked.name}`
          ])
        : await runCommand(await executablePath('systemctl'), [
            '--user',
            'is-active',
            untracked.name
          ])
    return {
      supported: true,
      manager,
      state: 'stale',
      installed: true,
      enabledAtBoot: true,
      active: active.code === 0,
      healthy: false,
      rebootReady: false,
      definitionMatches: false,
      environmentMatches: false,
      entrypointMatches: false,
      requestedState: null,
      definitionPath: untracked.path,
      entrypoint: null,
      daemon: null,
      issues: [
        `A Treeport service definition exists at ${untracked.path}, but its service record is missing. Restore the original Treeport data directory or ask an administrator to inspect and remove the definition.`
      ],
      recoveryCommands: [],
      administratorCommand: null
    }
  }

  const paths = servicePaths({ TREEPORT_DATA_DIR: record.dataDir })
  const [
    managerStatus,
    definitionContent,
    entrypointExists,
    runtimeExecutableExists,
    runtimeEntrypointExists,
    currentRuntime,
    daemon
  ] = await Promise.all([
    managerState(record),
    fs.readFile(record.definitionPath, 'utf8').catch(() => ''),
    fs
      .access(record.cliEntrypoint, fsConstants.X_OK)
      .then(() => true)
      .catch(() => false),
    record.runtimeExecutable
      ? fs
          .access(record.runtimeExecutable, fsConstants.X_OK)
          .then(() => true)
          .catch(() => false)
      : Promise.resolve(false),
    record.runtimeEntrypoint
      ? fs
          .access(record.runtimeEntrypoint, fsConstants.R_OK)
          .then(() => true)
          .catch(() => false)
      : Promise.resolve(false),
    currentAdministratorRuntime().catch(() => null),
    daemonStatus()
  ])
  const definitionPresent = definitionContent !== ''
  const definitionMatches =
    definitionPresent &&
    fingerprint(definitionContent) === record.definitionHash
  const invokedEntrypoint = currentEntrypoint()
  const entrypointMatches = Boolean(
    entrypointExists &&
    runtimeExecutableExists &&
    runtimeEntrypointExists &&
    currentRuntime &&
    record.runtimeExecutable === currentRuntime.runtimeExecutable &&
    record.runtimeEntrypoint === currentRuntime.runtimeEntrypoint &&
    (invokedEntrypoint === null ||
      path.resolve(invokedEntrypoint) === path.resolve(record.cliEntrypoint))
  )
  const currentEnvironment = createServiceEnvironment({
    user: {
      uid: record.uid,
      gid: record.gid,
      username: record.username,
      homedir: record.home,
      shell: record.environment.TREEPORT_SHELL ?? null
    },
    paths: localPaths({
      TREEPORT_DATA_DIR: record.dataDir,
      TREEPORT_RUNTIME_DIR: record.runtimeDir
    }),
    apiUrl: record.apiUrl,
    recordPath: paths.recordPath,
    installationMethod: record.installationMethod
  })
  const environmentMatches =
    fingerprint(currentEnvironment) === record.environmentHash
  const healthy = Boolean(
    daemon.verified &&
    daemon.health?.daemonLifecycle === 'service' &&
    daemon.state?.daemonLifecycle === 'service' &&
    path.resolve(daemon.state.dataDir) === path.resolve(record.dataDir)
  )
  const installed = managerStatus.enabled
  const rebootReady =
    installed && (record.manager === 'launchd' || managerStatus.lingering)
  const pendingCommand =
    administratorCommand(record) ??
    (record.manager === 'systemd' &&
    managerStatus.enabled &&
    !managerStatus.lingering
      ? `sudo loginctl enable-linger ${record.username}`
      : null)
  const issues: string[] = []
  const recoveryCommands: string[] = []
  if (record.manager !== manager) {
    issues.push(
      `The service record uses ${record.manager}, but this host requires ${manager}.`
    )
  }

  if (!definitionMatches && !record.pendingAdministratorRequestId) {
    issues.push(
      definitionPresent
        ? `The service definition at ${record.definitionPath} was changed.`
        : `The service definition is missing at ${record.definitionPath}.`
    )
    recoveryCommands.push('treeport service enable')
  }

  if (
    definitionMatches &&
    !installed &&
    !record.pendingAdministratorRequestId
  ) {
    issues.push(
      'The service definition is not enabled for startup after reboot.'
    )
    recoveryCommands.push('treeport service enable')
  }

  if (!entrypointMatches) {
    issues.push(
      `The service CLI entrypoint or Node runtime is unavailable or moved: ${record.cliEntrypoint}`
    )
    recoveryCommands.push('treeport service enable')
  }

  if (!environmentMatches) {
    issues.push(
      'The service environment differs from the current Treeport environment.'
    )
    recoveryCommands.push('treeport service enable')
  }

  if (record.manager === 'systemd' && installed && !managerStatus.lingering) {
    issues.push(`User lingering is disabled for ${record.username}.`)
    recoveryCommands.push(`sudo loginctl enable-linger ${record.username}`)
  }

  if (managerStatus.managerIssue) {
    issues.push(managerStatus.managerIssue)
  }

  if (
    installed &&
    record.requestedState === 'running' &&
    !healthy &&
    !record.pendingAdministratorRequestId
  ) {
    issues.push('The supervised Treeport daemon is not healthy.')
    recoveryCommands.push('treeport start')
  }

  const stale =
    record.manager !== manager ||
    !definitionMatches ||
    !environmentMatches ||
    !entrypointMatches ||
    (definitionPresent && !installed) ||
    managerStatus.managerIssue !== null
  const state: ServiceState =
    record.pendingAdministratorRequestId ||
    (record.manager === 'systemd' && installed && !managerStatus.lingering)
      ? 'action_required'
      : stale
        ? 'stale'
        : healthy
          ? 'healthy'
          : installed && record.requestedState === 'stopped'
            ? 'stopped'
            : installed && managerStatus.active
              ? 'starting'
              : installed
                ? 'unhealthy'
                : 'disabled'

  return {
    supported: true,
    manager,
    state,
    installed,
    enabledAtBoot: installed,
    active: managerStatus.active,
    healthy,
    rebootReady,
    definitionMatches,
    environmentMatches,
    entrypointMatches,
    requestedState: record.requestedState,
    definitionPath: record.definitionPath,
    entrypoint: record.cliEntrypoint,
    daemon,
    issues,
    recoveryCommands: [...new Set(recoveryCommands)],
    administratorCommand: pendingCommand
  }
}

async function prepareRecord(): Promise<{
  record: ServiceRecord
  definition: string
}> {
  if (process.getuid?.() === 0) {
    throw new Error(
      'Run `treeport service enable` as the user who will run Treeport, not as root.'
    )
  }

  const manager = managerForPlatform()
  if (!manager) {
    throw new Error(
      `Treeport service mode supports macOS launchd and Linux systemd; found ${process.platform}.`
    )
  }

  const explicitApiUrl = process.env.TREEPORT_API_URL?.trim()
  if (explicitApiUrl) {
    const explicit = new URL(explicitApiUrl)
    assertLoopbackHost(explicit.hostname)
  }

  const user = os.userInfo()
  const paths = localPaths()
  const locations = servicePaths()
  const apiUrl = await resolveLocalApiUrl()
  const listener = new URL(apiUrl)
  if (listener.protocol !== 'http:') {
    throw new Error('Treeport service mode requires a local HTTP loopback URL.')
  }

  assertLoopbackHost(listener.hostname)
  const installationMethod =
    process.env.TREEPORT_INSTALLATION_METHOD?.trim() === 'curl' ? 'curl' : 'npm'
  const [cliEntrypoint, administratorRuntime] = await Promise.all([
    ensureEntrypoint(installationMethod),
    currentAdministratorRuntime()
  ])
  const group = await primaryGroup(user.username)
  const definitionName =
    manager === 'launchd'
      ? `app.treeport.daemon.${user.uid}`
      : 'treeport.service'
  const definitionPath =
    manager === 'launchd'
      ? `/Library/LaunchDaemons/${definitionName}.plist`
      : path.join(
          process.env.XDG_CONFIG_HOME?.trim() ||
            path.join(user.homedir, '.config'),
          'systemd',
          'user',
          definitionName
        )
  const environment = createServiceEnvironment({
    user,
    paths,
    apiUrl,
    recordPath: locations.recordPath,
    installationMethod
  })
  const now = new Date().toISOString()
  const previous = await currentRecord()
  const definitionExists = await fs
    .access(definitionPath)
    .then(() => true)
    .catch(() => false)
  if (definitionExists && !previous) {
    throw new Error(
      `A Treeport service definition already exists at ${definitionPath}. Disable it from its original data directory before enabling another service.`
    )
  }

  if (previous && path.resolve(previous.dataDir) !== paths.dataDir) {
    throw new Error(
      `Treeport service mode already uses ${previous.dataDir}. Disable it before enabling ${paths.dataDir}.`
    )
  }

  const base: ServiceRecord = {
    schemaVersion: 1,
    manager,
    platform: process.platform,
    uid: user.uid,
    gid: user.gid,
    username: user.username,
    group,
    home: user.homedir,
    dataDir: paths.dataDir,
    runtimeDir: paths.runtimeDir,
    logPath: paths.logPath,
    apiUrl,
    cliEntrypoint,
    runtimeExecutable: administratorRuntime.runtimeExecutable,
    runtimeEntrypoint: administratorRuntime.runtimeEntrypoint,
    installationMethod,
    definitionName,
    definitionPath,
    definitionHash: '0'.repeat(64),
    environmentHash: fingerprint(environment),
    environment,
    requestedState: 'running',
    pendingAdministratorRequestId: null,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  }
  const definition = definitionForRecord(base)
  return {
    record: { ...base, definitionHash: fingerprint(definition) },
    definition
  }
}

async function writeServiceFiles(
  record: ServiceRecord,
  definition: string
): Promise<void> {
  const locations = servicePaths({ TREEPORT_DATA_DIR: record.dataDir })
  await Promise.all([
    fs.mkdir(path.dirname(record.logPath), { recursive: true, mode: 0o700 }),
    fs.mkdir(locations.requestsDirectory, { recursive: true, mode: 0o700 })
  ])
  await fs.writeFile(locations.runnerPath, runnerSource(record), {
    mode: 0o700
  })
  await fs.chmod(locations.runnerPath, 0o700)
  if (record.manager === 'launchd') {
    await fs.writeFile(locations.stagedDefinitionPath, definition, {
      mode: 0o600
    })
  } else {
    await fs.mkdir(path.dirname(record.definitionPath), {
      recursive: true,
      mode: 0o700
    })
    const temporaryPath = `${record.definitionPath}.${process.pid}.tmp`
    await fs.writeFile(temporaryPath, definition, { mode: 0o600 })
    await fs.rename(temporaryPath, record.definitionPath)
  }

  await saveRecord(record)
}

async function prepareAdministratorRequest(
  record: ServiceRecord,
  operation: AdministratorRequest['operation']
): Promise<{ record: ServiceRecord; command: string }> {
  const runtime =
    record.runtimeExecutable && record.runtimeEntrypoint
      ? {
          runtimeExecutable: record.runtimeExecutable,
          runtimeEntrypoint: record.runtimeEntrypoint
        }
      : await currentAdministratorRuntime()
  const requestRecord = { ...record, ...runtime }
  const locations = servicePaths({ TREEPORT_DATA_DIR: record.dataDir })
  const id = crypto.randomUUID()
  const now = new Date()
  const request: AdministratorRequest = {
    schemaVersion: 1,
    id,
    operation,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
    uid: record.uid,
    gid: record.gid,
    username: record.username,
    group: record.group,
    home: record.home,
    serviceRecordPath: locations.recordPath,
    runnerPath: locations.runnerPath,
    definitionName: record.definitionName,
    definitionPath: record.definitionPath,
    stagedDefinitionPath: locations.stagedDefinitionPath,
    definitionHash: record.definitionHash,
    apiUrl: record.apiUrl,
    cliEntrypoint: record.cliEntrypoint,
    runtimeExecutable: requestRecord.runtimeExecutable,
    runtimeEntrypoint: requestRecord.runtimeEntrypoint
  }
  const requestPath = path.join(locations.requestsDirectory, `${id}.json`)
  await writeJson(requestPath, request)
  const next = {
    ...requestRecord,
    pendingAdministratorRequestId: id,
    updatedAt: now.toISOString()
  }
  await saveRecord(next)
  return { record: next, command: administratorCommand(next)! }
}

async function waitForService(record: ServiceRecord): Promise<void> {
  const deadline = Date.now() + 15_000
  const version = await treeportVersion()
  while (Date.now() < deadline) {
    const observed = await daemonHealth(record.apiUrl, 500)
    if (
      observed?.daemonLifecycle === 'service' &&
      observed.instanceId &&
      observed.version === version
    ) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(
    `Treeport service did not become ready at ${record.apiUrl}. See ${record.logPath}.`
  )
}

export async function serviceEnable(): Promise<ServiceActionResult> {
  const existing = await serviceStatus()
  if (
    existing.state === 'healthy' &&
    existing.definitionMatches &&
    existing.environmentMatches &&
    existing.entrypointMatches
  ) {
    return { status: existing, changed: false, administratorCommand: null }
  }

  const { record, definition } = await prepareRecord()
  const failedChecks = (await runDoctor()).filter((check) => !check.ok)
  if (failedChecks.length) {
    throw new Error(
      failedChecks.map((check) => `${check.name}: ${check.detail}`).join('\n')
    )
  }

  const systemctl =
    record.manager === 'systemd' ? await executablePath('systemctl') : null
  if (systemctl) {
    const managerAvailable = await runCommand(systemctl, [
      '--user',
      'show-environment'
    ])
    if (managerAvailable.code !== 0) {
      throw commandError('systemctl --user', managerAvailable)
    }
  }

  await writeServiceFiles(record, definition)
  if (record.manager === 'launchd') {
    await daemonDown()
    const prepared = await prepareAdministratorRequest(record, 'enable')
    const status = await serviceStatus()
    return {
      status,
      changed: true,
      administratorCommand: prepared.command
    }
  }

  if (!systemctl) {
    throw new Error('Treeport could not resolve the systemd command.')
  }

  await daemonDown()
  const reload = await runCommand(systemctl, ['--user', 'daemon-reload'])
  if (reload.code !== 0) {
    await Promise.all([
      fs.rm(record.definitionPath, { force: true }),
      fs.rm(servicePaths().directory, { recursive: true, force: true })
    ])
    await daemonUp({})
    throw commandError('systemctl --user daemon-reload', reload)
  }

  const enabled = await runCommand(systemctl, [
    '--user',
    'enable',
    '--now',
    record.definitionName
  ])
  if (enabled.code !== 0) {
    await fs.rm(record.definitionPath, { force: true })
    await runCommand(systemctl, ['--user', 'daemon-reload'])
    await fs.rm(servicePaths().directory, { recursive: true, force: true })
    await daemonUp({})
    throw commandError('systemctl --user enable --now', enabled)
  }

  const startupError = await waitForService(record).then(
    () => null,
    (error) => error
  )
  if (startupError) {
    await runCommand(systemctl, [
      '--user',
      'disable',
      '--now',
      record.definitionName
    ])
    await fs.rm(record.definitionPath, { force: true })
    await runCommand(systemctl, ['--user', 'daemon-reload'])
    await fs.rm(servicePaths().directory, { recursive: true, force: true })
    await daemonUp({})
    throw startupError
  }

  const status = await serviceStatus()
  return {
    status,
    changed: true,
    administratorCommand: status.administratorCommand
  }
}

export async function serviceStart(): Promise<ServiceActionResult> {
  const record = await currentRecord()
  if (!record) {
    throw new Error(
      'Treeport service mode is disabled. Run `treeport service enable` first.'
    )
  }

  const current = await serviceStatus()
  if (current.state === 'healthy') {
    return { status: current, changed: false, administratorCommand: null }
  }

  if (current.administratorCommand) {
    return {
      status: current,
      changed: false,
      administratorCommand: current.administratorCommand
    }
  }

  if (!current.definitionMatches || !current.entrypointMatches) {
    throw new Error(
      'The Treeport service definition is stale. Run `treeport service enable` to repair it.'
    )
  }

  const next = {
    ...record,
    requestedState: 'running' as const,
    pendingAdministratorRequestId: null,
    updatedAt: new Date().toISOString()
  }
  await saveRecord(next)
  if (record.manager === 'launchd') {
    const prepared = await prepareAdministratorRequest(next, 'start')
    return {
      status: await serviceStatus(),
      changed: true,
      administratorCommand: prepared.command
    }
  }

  const result = await runCommand(await executablePath('systemctl'), [
    '--user',
    'start',
    record.definitionName
  ])
  if (result.code !== 0) {
    throw commandError('systemctl --user start', result)
  }

  await waitForService(next)
  return {
    status: await serviceStatus(),
    changed: true,
    administratorCommand: null
  }
}

export async function serviceStop(): Promise<ServiceActionResult> {
  const record = await currentRecord()
  if (!record) {
    throw new Error('Treeport service mode is disabled.')
  }

  const current = await serviceStatus()
  if (current.state === 'stopped') {
    return { status: current, changed: false, administratorCommand: null }
  }

  const next = {
    ...record,
    requestedState: 'stopped' as const,
    pendingAdministratorRequestId: null,
    updatedAt: new Date().toISOString()
  }
  await saveRecord(next)
  if (record.manager === 'launchd') {
    const prepared = await prepareAdministratorRequest(next, 'stop')
    return {
      status: await serviceStatus(),
      changed: true,
      administratorCommand: prepared.command
    }
  }

  const result = await runCommand(await executablePath('systemctl'), [
    '--user',
    'stop',
    record.definitionName
  ])
  if (result.code !== 0) {
    await saveRecord(record)
    throw commandError('systemctl --user stop', result)
  }

  return {
    status: await serviceStatus(),
    changed: true,
    administratorCommand: null
  }
}

export async function serviceDisable(): Promise<ServiceActionResult> {
  const record = await currentRecord()
  if (!record) {
    return {
      status: await serviceStatus(),
      changed: false,
      administratorCommand: null
    }
  }

  if (record.manager === 'launchd') {
    const prepared = await prepareAdministratorRequest(
      { ...record, pendingAdministratorRequestId: null },
      'disable'
    )
    return {
      status: await serviceStatus(),
      changed: true,
      administratorCommand: prepared.command
    }
  }

  const systemctl = await executablePath('systemctl')
  const disabled = await runCommand(systemctl, [
    '--user',
    'disable',
    '--now',
    record.definitionName
  ])
  if (disabled.code !== 0 && !disabled.stderr.includes('does not exist')) {
    throw commandError('systemctl --user disable --now', disabled)
  }

  await fs.rm(record.definitionPath, { force: true })
  await runCommand(systemctl, ['--user', 'daemon-reload'])
  await fs.rm(servicePaths().directory, { recursive: true, force: true })
  return {
    status: await serviceStatus(),
    changed: true,
    administratorCommand: null
  }
}

export async function serviceApply(requestPath: string): Promise<{
  operation: AdministratorRequest['operation']
  applied: true
}> {
  if (process.platform !== 'darwin') {
    throw new Error(
      'Treeport service apply is only available for macOS LaunchDaemons.'
    )
  }

  if (process.getuid?.() !== 0) {
    throw new Error(
      'Run the printed service apply command with sudo or as root.'
    )
  }

  if (!path.isAbsolute(requestPath)) {
    throw new Error('The service apply request path must be absolute.')
  }

  const metadata = await fs.lstat(requestPath)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      'The service apply request must be a regular file, not a symlink.'
    )
  }

  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(
      'The service apply request must not be readable or writable by other users.'
    )
  }

  const request = await readJson(requestPath, administratorRequestSchema)
  if (!request) {
    throw new Error('The service apply request is invalid.')
  }

  if (metadata.uid !== request.uid) {
    throw new Error(
      'The service apply request owner does not match its target user.'
    )
  }

  if (Date.parse(request.expiresAt) <= Date.now()) {
    throw new Error(
      'The service apply request expired. Run the original Treeport command again.'
    )
  }

  const currentRuntime = await currentAdministratorRuntime().catch(() => null)
  const invokedRuntimeEntrypoint = process.argv[1]
    ? path.resolve(process.argv[1])
    : null
  if (
    !currentRuntime ||
    currentRuntime.runtimeExecutable !== request.runtimeExecutable ||
    currentRuntime.runtimeEntrypoint !== request.runtimeEntrypoint ||
    invokedRuntimeEntrypoint !== request.runtimeEntrypoint
  ) {
    throw new Error(
      'The service apply command did not use the approved Treeport Node runtime and package entrypoint.'
    )
  }

  const usedPath = `${requestPath}.used`
  if (
    await fs
      .access(usedPath)
      .then(() => true)
      .catch(() => false)
  ) {
    throw new Error('The service apply request was already used.')
  }

  const account = os.userInfo({ encoding: 'utf8' })
  const idResult = await runCommand(await executablePath('id'), [
    '-u',
    request.username
  ])
  if (idResult.code !== 0 || Number(idResult.stdout.trim()) !== request.uid) {
    throw new Error(
      'The service apply target user no longer matches the host account.'
    )
  }

  const record = await readJson(request.serviceRecordPath, serviceRecordSchema)
  if (
    !record ||
    record.uid !== request.uid ||
    record.username !== request.username ||
    record.manager !== 'launchd' ||
    record.definitionName !== request.definitionName ||
    record.definitionPath !== request.definitionPath ||
    record.cliEntrypoint !== request.cliEntrypoint ||
    record.runtimeExecutable !== request.runtimeExecutable ||
    record.runtimeEntrypoint !== request.runtimeEntrypoint ||
    record.definitionHash !== request.definitionHash ||
    record.pendingAdministratorRequestId !== request.id
  ) {
    throw new Error(
      'The service apply request does not match the current Treeport service record.'
    )
  }

  if (account.uid !== 0) {
    throw new Error('Treeport service apply lost root privileges.')
  }

  const launchctl = await executablePath('launchctl')
  const target = `system/${request.definitionName}`
  if (request.operation === 'enable') {
    const staged = await fs.readFile(request.stagedDefinitionPath, 'utf8')
    if (
      fingerprint(staged) !== request.definitionHash ||
      !staged.includes(`<string>${xml(request.username)}</string>`) ||
      !staged.includes(`<string>${xml(request.runnerPath)}</string>`)
    ) {
      throw new Error(
        'The staged LaunchDaemon definition does not match the approved request.'
      )
    }

    const temporaryPath = `${request.definitionPath}.${process.pid}.tmp`
    await fs.copyFile(request.stagedDefinitionPath, temporaryPath)
    await fs.chown(temporaryPath, 0, 0)
    await fs.chmod(temporaryPath, 0o644)
    await fs.rename(temporaryPath, request.definitionPath)
    await runCommand(launchctl, ['bootout', target])
    const enabled = await runCommand(launchctl, ['enable', target])
    if (enabled.code !== 0) {
      throw commandError('launchctl enable', enabled)
    }

    const bootstrapped = await runCommand(launchctl, [
      'bootstrap',
      'system',
      request.definitionPath
    ])
    if (bootstrapped.code !== 0) {
      throw commandError('launchctl bootstrap', bootstrapped)
    }
  } else if (request.operation === 'start') {
    const enabled = await runCommand(launchctl, ['enable', target])
    if (enabled.code !== 0) {
      throw commandError('launchctl enable', enabled)
    }

    const active = await runCommand(launchctl, ['print', target])
    const started =
      active.code === 0
        ? await runCommand(launchctl, ['kickstart', target])
        : await runCommand(launchctl, [
            'bootstrap',
            'system',
            request.definitionPath
          ])
    if (started.code !== 0) {
      throw commandError('launchctl start', started)
    }
  } else if (request.operation === 'stop') {
    const stopped = await runCommand(launchctl, ['bootout', target])
    if (stopped.code !== 0 && !stopped.stderr.includes('No such process')) {
      throw commandError('launchctl bootout', stopped)
    }
  } else {
    const installed = await fs
      .readFile(request.definitionPath, 'utf8')
      .catch(() => '')
    if (installed && fingerprint(installed) !== request.definitionHash) {
      throw new Error(
        'Refusing to remove a LaunchDaemon definition that Treeport did not create.'
      )
    }

    await runCommand(launchctl, ['bootout', target])
    await fs.rm(request.definitionPath, { force: true })
  }

  if (request.operation === 'enable' || request.operation === 'start') {
    await waitForService(record)
  }

  await fs.rename(requestPath, usedPath)
  if (request.operation === 'disable') {
    await fs.rm(path.dirname(request.serviceRecordPath), {
      recursive: true,
      force: true
    })
  } else {
    await writeJson(request.serviceRecordPath, {
      ...record,
      requestedState:
        request.operation === 'stop'
          ? ('stopped' as const)
          : ('running' as const),
      pendingAdministratorRequestId: null,
      updatedAt: new Date().toISOString()
    })
    await fs.chown(request.serviceRecordPath, request.uid, request.gid)
  }

  return { operation: request.operation, applied: true }
}

export async function serviceRun(): Promise<void> {
  const recordPath = process.env.TREEPORT_SERVICE_RECORD?.trim()
  if (!recordPath || !path.isAbsolute(recordPath)) {
    throw new Error('Treeport service run requires a valid service record.')
  }

  const record = await readJson(recordPath, serviceRecordSchema)
  if (!record) {
    throw new Error(`Treeport service record is invalid: ${recordPath}`)
  }

  if (process.getuid?.() === 0 || process.getuid?.() !== record.uid) {
    throw new Error(
      `Treeport service must run as ${record.username} (UID ${record.uid}), never as root.`
    )
  }

  await writeJson(recordPath, {
    ...record,
    requestedState: 'running',
    pendingAdministratorRequestId: null,
    updatedAt: new Date().toISOString()
  })
  const [version, serverEntry, webDist] = await Promise.all([
    treeportVersion(),
    resolvePackagePath('dist', 'node', 'server', 'index.js'),
    resolvePackagePath('dist', 'web')
  ])
  Object.assign(process.env, record.environment, {
    TREEPORT_APP_VERSION: version,
    TREEPORT_INSTANCE_ID: crypto.randomUUID(),
    TREEPORT_WEB_DIST: webDist,
    TREEPORT_DAEMON_LIFECYCLE: 'service'
  })
  await import(pathToFileURL(serverEntry).href)
}

export async function readServiceLogs(lines: number): Promise<string> {
  const record = await currentRecord()
  if (!record || record.manager === 'launchd') {
    const value = await fs
      .readFile(record?.logPath ?? localPaths().logPath, 'utf8')
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return ''
        }

        throw error
      })
    return value
      .split('\n')
      .slice(-lines - 1)
      .join('\n')
  }

  const result = await runCommand(await executablePath('journalctl'), [
    '--user',
    '--unit',
    record.definitionName,
    '--no-pager',
    '--lines',
    String(lines)
  ])
  if (result.code !== 0) {
    throw commandError('journalctl --user', result)
  }

  return result.stdout
}

export async function serviceDoctorCheck(): Promise<DoctorCheck> {
  const status = await serviceStatus()
  if (!status.supported) {
    return {
      name: 'Service supervision',
      ok: false,
      detail: status.issues.join(' ')
    }
  }

  if (status.state === 'disabled') {
    return {
      name: 'Service supervision',
      ok: true,
      detail: 'disabled (opt in with `treeport service enable`)'
    }
  }

  if (status.state === 'healthy') {
    return {
      name: 'Service supervision',
      ok: true,
      detail: `${status.manager}; enabled at boot and healthy`
    }
  }

  if (status.state === 'stopped') {
    return {
      name: 'Service supervision',
      ok: true,
      detail: `${status.manager}; intentionally stopped and enabled for next boot`
    }
  }

  return {
    name: 'Service supervision',
    ok: false,
    detail: status.issues.join(' ') || `state: ${status.state}`
  }
}
