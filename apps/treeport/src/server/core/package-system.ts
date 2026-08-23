import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import {
  createTerminalPresetSchema,
  type PackageListing,
  type PackageOperationResult,
  type PackageResourceDiagnostic,
  type PackageScope,
  type PackageSource,
  type ProjectRecord,
  type TerminalPresetDefinition,
  type WebPanelDefinition,
  type WebPanelPermission
} from '@treeport/shared'
import type { AppConfig } from './config'
import { runChecked, type CommandRunner } from './command'
import { DomainError } from './domain'

interface TreeportSettings {
  raw: object
  packages: PackageSource[]
  npmCommand?: string[]
}

interface ParsedSettingsResult {
  settings?: TreeportSettings
  diagnostic?: PackageResourceDiagnostic
}

interface SettingsFileReadResult {
  fingerprint: string
  content: string | null
  error?: Error
}

interface ProjectPackageContext {
  id: string
  name: string
  rootPath: string
}

interface ParsedNpmSource {
  type: 'npm'
  source: string
  spec: string
  name: string
  version?: string
  exact: boolean
  identity: string
  packageId: string
}

interface ParsedLocalSource {
  type: 'local'
  source: string
  path: string
  identity: string
  packageId: string
}

type ParsedPackageSource = ParsedNpmSource | ParsedLocalSource

type PackageSourceObject = Exclude<PackageSource, string>

export interface ResolvedWebPanel {
  definition: WebPanelDefinition
  root: string
  entry: string
  packageRoot: string
  development: boolean
  packageLockPath?: string
  relativePath: string
  enabled: boolean
}

interface ResolvedTerminalPreset {
  definition: TerminalPresetDefinition
  relativePath: string
  enabled: boolean
}

interface ResolvedPackage {
  source: string
  identity: string
  packageId: string
  scope: PackageScope
  projectId: string | null
  root: string
  installedPath: string
  webPanels: ResolvedWebPanel[]
  terminalPresets: ResolvedTerminalPreset[]
  diagnostics: PackageResourceDiagnostic[]
}

interface GlobalPackageState {
  settings: TreeportSettings
  packages: Map<string, ResolvedPackage>
  diagnostics: PackageResourceDiagnostic[]
}

interface ProjectPackageState {
  context: ProjectPackageContext
  settings: TreeportSettings
  ownPackages: Map<string, ResolvedPackage>
  effectivePackages: Map<string, ResolvedPackage>
  diagnostics: PackageResourceDiagnostic[]
}

interface ResourceCandidates {
  webPanels: Array<{ root: string; relativePath: string }>
  terminalPresets: Array<{ path: string; relativePath: string }>
  diagnostics: PackageResourceDiagnostic[]
}

interface WebPanelManifestEntry {
  source: string
  permissions: WebPanelPermission[]
}

interface PackageManifest {
  webPanels: WebPanelManifestEntry[]
  terminalPresets: string[]
}

const packageManifestInputSchema = z.unknown()
type PackageManifestInput = z.input<typeof packageManifestInputSchema>
const manifestPatternsSchema = z.array(z.string())
const webPanelManifestEntrySchema = z.union([
  z.string(),
  z.strictObject({
    source: z.string(),
    permissions: z.array(z.enum(['same-origin', 'host-browser'])).optional()
  })
])

const EMPTY_SETTINGS: TreeportSettings = { raw: {}, packages: [] }
const PACKAGE_OPERATION_TIMEOUT_MS = 5 * 60_000

function sourceString(source: PackageSource): string {
  const parsed = z.string().safeParse(source)
  if (parsed.success) {
    return parsed.data
  }

  return z.object({ source: z.string() }).parse(source).source
}

function packageFilter(source: PackageSource): PackageSourceObject | undefined {
  const parsed = z.string().safeParse(source)
  if (parsed.success) {
    return undefined
  }

  const data = z
    .object({
      source: z.string(),
      autoload: z.boolean().optional(),
      webPanels: z.array(z.string()).optional(),
      terminalPresets: z.array(z.string()).optional()
    })
    .parse(source)
  const result: PackageSourceObject = { source: data.source }
  if (data.autoload !== undefined) {
    result.autoload = data.autoload
  }

  if (data.webPanels !== undefined) {
    result.webPanels = data.webPanels
  }

  if (data.terminalPresets !== undefined) {
    result.terminalPresets = data.terminalPresets
  }

  return result
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

function titleFromPath(value: string): string {
  const name = path.posix.basename(value)
  const words = name
    .split(/[-_.]+/)
    .filter(Boolean)
    .join(' ')
  return words ? `${words[0]!.toLocaleUpperCase()}${words.slice(1)}` : name
}

function isExactNpmVersion(value: string | undefined): boolean {
  return Boolean(
    value &&
    /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)
  )
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

function diagnostic(
  scope: PackageScope,
  message: string,
  options: {
    severity?: 'warning' | 'error' | undefined
    source?: string | undefined
    projectId?: string | undefined
    resourceType?: 'web-panel' | 'terminal-preset' | undefined
    path?: string | undefined
  } = {}
): PackageResourceDiagnostic {
  const result: PackageResourceDiagnostic = {
    severity: options.severity ?? 'error',
    scope,
    message
  }
  if (options.source !== undefined) {
    result.source = options.source
  }

  if (options.projectId !== undefined) {
    result.projectId = options.projectId
  }

  if (options.resourceType !== undefined) {
    result.resourceType = options.resourceType
  }

  if (options.path !== undefined) {
    result.path = options.path
  }

  return result
}

function normalizePattern(value: string): string {
  return toPosix(value.trim().replace(/^\.\//u, '').replace(/\/$/u, ''))
}

function patternMatches(relativePath: string, pattern: string): boolean {
  const normalized = normalizePattern(pattern)
  if (!normalized) {
    return false
  }

  return (
    relativePath === normalized ||
    relativePath.startsWith(`${normalized}/`) ||
    path.matchesGlob(relativePath, normalized) ||
    path.matchesGlob(path.posix.basename(relativePath), normalized)
  )
}

function exactPatternMatches(relativePath: string, pattern: string): boolean {
  return relativePath === normalizePattern(pattern)
}

function applyNormalFilter<
  T extends { relativePath: string; enabled: boolean }
>(resources: T[], patterns: string[] | undefined, autoload: boolean): T[] {
  if (patterns === undefined) {
    return resources.map((resource) => ({
      ...resource,
      enabled: autoload ? resource.enabled : false
    }))
  }

  if (patterns.length === 0) {
    return resources.map((resource) => ({ ...resource, enabled: false }))
  }

  if (!autoload) {
    const result = resources.map((resource) => ({
      ...resource,
      enabled: false
    }))
    for (const pattern of patterns) {
      const marker = pattern[0] ?? ''
      const target = ['+', '-', '!'].includes(marker)
        ? pattern.slice(1)
        : pattern
      for (const resource of result) {
        const matches =
          marker === '+' || marker === '-'
            ? exactPatternMatches(resource.relativePath, target)
            : patternMatches(resource.relativePath, target)
        if (matches) {
          resource.enabled = marker !== '-' && marker !== '!'
        }
      }
    }
    return result
  }

  const includes = patterns.filter(
    (pattern) => !['!', '+', '-'].includes(pattern[0] ?? '')
  )
  const result = resources.map((resource) => ({
    ...resource,
    enabled:
      resource.enabled &&
      (includes.length === 0 ||
        includes.some((pattern) =>
          patternMatches(resource.relativePath, pattern)
        ))
  }))
  for (const pattern of patterns.filter((value) => value.startsWith('!'))) {
    for (const resource of result) {
      if (patternMatches(resource.relativePath, pattern.slice(1))) {
        resource.enabled = false
      }
    }
  }
  for (const pattern of patterns.filter((value) => value.startsWith('+'))) {
    for (const resource of result) {
      if (exactPatternMatches(resource.relativePath, pattern.slice(1))) {
        resource.enabled = true
      }
    }
  }
  for (const pattern of patterns.filter((value) => value.startsWith('-'))) {
    for (const resource of result) {
      if (exactPatternMatches(resource.relativePath, pattern.slice(1))) {
        resource.enabled = false
      }
    }
  }
  return result
}

function applyDelta<T extends { relativePath: string; enabled: boolean }>(
  resources: T[],
  patterns: string[] | undefined
): T[] {
  if (patterns === undefined) {
    return resources.map((resource) => ({ ...resource }))
  }

  const result = resources.map((resource) => ({ ...resource }))
  for (const pattern of patterns) {
    const marker = pattern[0] ?? ''
    const target = ['+', '-', '!'].includes(marker) ? pattern.slice(1) : pattern
    for (const resource of result) {
      const matches =
        marker === '+' || marker === '-'
          ? exactPatternMatches(resource.relativePath, target)
          : patternMatches(resource.relativePath, target)
      if (matches) {
        resource.enabled = marker !== '-' && marker !== '!'
      }
    }
  }
  return result
}

export class PackageSystem {
  private globalState: GlobalPackageState = {
    settings: EMPTY_SETTINGS,
    packages: new Map(),
    diagnostics: []
  }
  private readonly projectContexts = new Map<string, ProjectPackageContext>()
  private readonly projectStates = new Map<string, ProjectPackageState>()
  private globalFingerprint: string | null = null
  private readonly projectFingerprints = new Map<string, string>()
  private readonly operationTails = new Map<string, Promise<void>>()

  constructor(
    private readonly config: AppConfig,
    private readonly runner: CommandRunner
  ) {}

  private settingsPath(scope: PackageScope, projectId?: string): string {
    if (scope === 'global') {
      return path.join(this.config.dataDir, 'settings.json')
    }

    const project = projectId ? this.projectContexts.get(projectId) : undefined
    if (!project) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'Project not found for package operation',
        404
      )
    }

    return path.join(project.rootPath, '.treeport', 'settings.json')
  }

  private async serialize<T>(
    key: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.operationTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>((resolve) => {
      release = resolve
    })
    this.operationTails.set(key, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.operationTails.get(key) === tail) {
        this.operationTails.delete(key)
      }
    }
  }

  private async readSettingsFile(
    settingsPath: string
  ): Promise<SettingsFileReadResult> {
    let readError: Error | undefined
    const content = await fs.readFile(settingsPath, 'utf8').catch((error) => {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return null
      }

      readError = error instanceof Error ? error : new Error(String(error))
      return null
    })
    const result: SettingsFileReadResult = {
      fingerprint: readError
        ? `error:${readError.message}`
        : content === null
          ? 'missing'
          : crypto.createHash('sha256').update(content).digest('hex'),
      content
    }
    if (readError) {
      result.error = readError
    }

    return result
  }

  private parseSettings(
    content: string | null,
    settingsPath: string,
    scope: PackageScope,
    projectId?: string
  ): ParsedSettingsResult {
    if (content === null || content.trim() === '') {
      return { settings: { raw: {}, packages: [] } }
    }

    let input
    try {
      input = JSON.parse(content)
    } catch (error) {
      return {
        diagnostic: diagnostic(
          scope,
          `Could not parse ${settingsPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { projectId, path: settingsPath }
        )
      }
    }

    const parsedRaw = z
      .looseObject({
        npmCommand: z.unknown().optional(),
        packages: z.unknown().optional()
      })
      .safeParse(input)
    if (!parsedRaw.success) {
      return {
        diagnostic: diagnostic(
          scope,
          `${settingsPath} must contain a JSON object`,
          { projectId, path: settingsPath }
        )
      }
    }

    const parsedNpmCommand = z
      .array(z.string().min(1))
      .min(1)
      .safeParse(parsedRaw.data.npmCommand)
    if (parsedRaw.data.npmCommand !== undefined && !parsedNpmCommand.success) {
      return {
        diagnostic: diagnostic(
          scope,
          `${settingsPath} npmCommand must be a non-empty argv string array`,
          { projectId, path: settingsPath }
        )
      }
    }

    const parsedPackageEntries = z
      .array(z.unknown())
      .safeParse(parsedRaw.data.packages ?? [])
    if (!parsedPackageEntries.success) {
      return {
        diagnostic: diagnostic(
          scope,
          `${settingsPath} packages must be an array`,
          { projectId, path: settingsPath }
        )
      }
    }

    const packageObjectSchema = z.looseObject({
      source: z.unknown().optional(),
      autoload: z.unknown().optional(),
      webPanels: z.unknown().optional(),
      terminalPresets: z.unknown().optional()
    })
    const packages: PackageSource[] = []
    for (const [index, entry] of parsedPackageEntries.data.entries()) {
      const parsedSourceString = z.string().safeParse(entry)
      if (parsedSourceString.success && parsedSourceString.data.trim()) {
        packages.push(parsedSourceString.data)
        continue
      }

      const parsedEntry = packageObjectSchema.safeParse(entry)
      if (!parsedEntry.success) {
        return {
          diagnostic: diagnostic(
            scope,
            `${settingsPath} packages[${index}] must be a source string or package object`,
            { projectId, path: settingsPath }
          )
        }
      }

      const parsedSource = z.string().safeParse(parsedEntry.data.source)
      if (!parsedSource.success || !parsedSource.data.trim()) {
        return {
          diagnostic: diagnostic(
            scope,
            `${settingsPath} packages[${index}].source must be a non-empty string`,
            { projectId, path: settingsPath }
          )
        }
      }

      const parsedAutoload = z.boolean().safeParse(parsedEntry.data.autoload)
      if (parsedEntry.data.autoload !== undefined && !parsedAutoload.success) {
        return {
          diagnostic: diagnostic(
            scope,
            `${settingsPath} packages[${index}].autoload must be a boolean`,
            { projectId, path: settingsPath }
          )
        }
      }

      const parsedWebPanels = z
        .array(z.string())
        .safeParse(parsedEntry.data.webPanels)
      const parsedTerminalPresets = z
        .array(z.string())
        .safeParse(parsedEntry.data.terminalPresets)
      for (const [key, original, parsed] of [
        ['webPanels', parsedEntry.data.webPanels, parsedWebPanels],
        [
          'terminalPresets',
          parsedEntry.data.terminalPresets,
          parsedTerminalPresets
        ]
      ] as const) {
        if (original !== undefined && !parsed.success) {
          return {
            diagnostic: diagnostic(
              scope,
              `${settingsPath} packages[${index}].${key} must be a string array`,
              { projectId, path: settingsPath }
            )
          }
        }
      }

      const configured: PackageSourceObject = { source: parsedSource.data }
      if (parsedAutoload.success) {
        configured.autoload = parsedAutoload.data
      }

      if (parsedWebPanels.success) {
        configured.webPanels = parsedWebPanels.data
      }

      if (parsedTerminalPresets.success) {
        configured.terminalPresets = parsedTerminalPresets.data
      }

      packages.push(configured)
    }

    const settings: TreeportSettings = { raw: parsedRaw.data, packages }
    if (parsedNpmCommand.success) {
      settings.npmCommand = parsedNpmCommand.data
    }

    return { settings }
  }

  private async parseSource(
    source: string,
    settingsPath: string
  ): Promise<ParsedPackageSource> {
    const trimmed = source.trim()
    if (trimmed.startsWith('npm:')) {
      const spec = trimmed.slice(4).trim()
      let split = -1
      if (spec.startsWith('@')) {
        const slash = spec.indexOf('/')
        split = slash === -1 ? -1 : spec.lastIndexOf('@')
        if (split <= slash) {
          split = -1
        }
      } else {
        split = spec.lastIndexOf('@')
      }

      const name = split > 0 ? spec.slice(0, split) : spec
      const version = split > 0 ? spec.slice(split + 1) : undefined
      if (
        !name ||
        name.includes('..') ||
        name.includes('\\') ||
        !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu.test(name) ||
        (version !== undefined && !version)
      ) {
        throw new DomainError(
          'INVALID_PACKAGE_SOURCE',
          `Invalid npm package source: ${source}`,
          400
        )
      }

      const identity = `npm:${name}`
      const parsed: ParsedNpmSource = {
        type: 'npm',
        source: trimmed,
        spec,
        name,
        exact: isExactNpmVersion(version),
        identity,
        packageId: identity
      }
      if (version !== undefined) {
        parsed.version = version
      }

      return parsed
    }

    if (
      !path.isAbsolute(trimmed) &&
      trimmed !== '.' &&
      trimmed !== '..' &&
      !trimmed.startsWith('./') &&
      !trimmed.startsWith('../') &&
      trimmed !== '~' &&
      !trimmed.startsWith('~/')
    ) {
      throw new DomainError(
        'INVALID_PACKAGE_SOURCE',
        'Package sources must use npm: syntax or an explicit local path',
        400
      )
    }

    const expanded =
      trimmed === '~' || trimmed.startsWith('~/')
        ? path.join(os.homedir(), trimmed.slice(2))
        : trimmed
    const resolved = path.resolve(path.dirname(settingsPath), expanded)
    const canonical = await fs.realpath(resolved).catch(() => resolved)
    const identity = `local:${canonical}`
    return {
      type: 'local',
      source: trimmed,
      path: canonical,
      identity,
      packageId: `local:${crypto
        .createHash('sha256')
        .update(canonical)
        .digest('hex')
        .slice(0, 16)}`
    }
  }

  private npmRoot(scope: PackageScope, projectId: string | null): string {
    return scope === 'global'
      ? path.join(this.config.dataDir, 'npm')
      : path.join(
          this.projectContexts.get(projectId!)!.rootPath,
          '.treeport',
          'npm'
        )
  }

  private npmPackagePath(
    source: ParsedNpmSource,
    scope: PackageScope,
    projectId: string | null
  ): string {
    return path.join(
      this.npmRoot(scope, projectId),
      'node_modules',
      source.name
    )
  }

  private npmCommand(settings: TreeportSettings): string[] {
    return (
      settings.npmCommand ?? this.globalState.settings.npmCommand ?? ['npm']
    )
  }

  private async ensureNpmProject(root: string): Promise<void> {
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    const packageJsonPath = path.join(root, 'package.json')
    const packageJsonExists = await fs
      .stat(packageJsonPath)
      .then((value) => value.isFile())
      .catch(() => false)
    if (!packageJsonExists) {
      await fs.writeFile(
        packageJsonPath,
        `${JSON.stringify(
          { name: 'treeport-packages', private: true },
          null,
          2
        )}\n`,
        { mode: 0o600 }
      )
    }

    const ignorePath = path.join(root, '.gitignore')
    const ignoreExists = await fs
      .stat(ignorePath)
      .then((value) => value.isFile())
      .catch(() => false)
    if (!ignoreExists) {
      await fs.writeFile(ignorePath, '*\n!.gitignore\n', { mode: 0o600 })
    }
  }

  private async runNpm(
    action: 'install' | 'remove',
    source: ParsedNpmSource,
    scope: PackageScope,
    projectId: string | null,
    settings: TreeportSettings,
    update = false
  ): Promise<void> {
    const root = this.npmRoot(scope, projectId)
    await this.ensureNpmProject(root)
    const command = this.npmCommand(settings)
    const executable = command[0]
    if (!executable) {
      throw new DomainError(
        'INVALID_NPM_COMMAND',
        'npmCommand must start with an executable',
        400
      )
    }

    const prefix = command.slice(1)
    const separator = command.lastIndexOf('--')
    const manager = path
      .basename(separator >= 0 ? (command[separator + 1] ?? '') : executable)
      .replace(/\.(?:cmd|exe)$/iu, '')
    const requestedSpec =
      update && !source.version ? `${source.name}@latest` : source.spec
    let args: string[]
    if (manager === 'pnpm') {
      args =
        action === 'install'
          ? ['add', requestedSpec, '--dir', root, '--ignore-scripts']
          : ['remove', source.name, '--dir', root, '--ignore-scripts']
    } else if (manager === 'bun') {
      args =
        action === 'install'
          ? ['add', requestedSpec, '--cwd', root, '--ignore-scripts']
          : ['remove', source.name, '--cwd', root, '--ignore-scripts']
    } else {
      args =
        action === 'install'
          ? [
              'install',
              requestedSpec,
              '--prefix',
              root,
              '--ignore-scripts',
              '--no-audit',
              '--no-fund'
            ]
          : [
              'uninstall',
              source.name,
              '--prefix',
              root,
              '--ignore-scripts',
              '--no-audit',
              '--no-fund'
            ]
    }

    await runChecked(this.runner, {
      executable,
      args: [...prefix, ...args],
      timeoutMs: PACKAGE_OPERATION_TIMEOUT_MS
    })
  }

  private async ensureInstalled(
    source: ParsedPackageSource,
    scope: PackageScope,
    projectId: string | null,
    settings: TreeportSettings,
    forceInstall: boolean
  ): Promise<string> {
    if (source.type === 'local') {
      const stat = await fs.stat(source.path).catch(() => null)
      if (!stat?.isDirectory()) {
        throw new DomainError(
          'PACKAGE_PATH_NOT_FOUND',
          `Package directory does not exist: ${source.path}`,
          400
        )
      }

      return source.path
    }

    const installedPath = this.npmPackagePath(source, scope, projectId)
    let shouldInstall = forceInstall
    const installed = await fs
      .stat(installedPath)
      .then((value) => value.isDirectory())
      .catch(() => false)
    if (!installed) {
      shouldInstall = true
    } else if (source.exact) {
      const installedVersion = await fs
        .readFile(path.join(installedPath, 'package.json'), 'utf8')
        .then((content) => {
          const parsed = z
            .object({ version: z.string().optional() })
            .safeParse(JSON.parse(content))
          return parsed.success ? parsed.data.version : undefined
        })
        .catch(() => undefined)
      shouldInstall = installedVersion !== source.version
    }

    if (shouldInstall) {
      await this.runNpm('install', source, scope, projectId, settings)
    }

    const exists = await fs
      .stat(installedPath)
      .then((value) => value.isDirectory())
      .catch(() => false)
    if (!exists) {
      throw new DomainError(
        'PACKAGE_INSTALL_FAILED',
        `Package manager completed without installing ${source.name}`,
        500
      )
    }

    return installedPath
  }

  private validateManifestPatterns(
    patterns: PackageManifestInput,
    field: string,
    packageJsonPath: string
  ): string[] {
    const parsed = manifestPatternsSchema.safeParse(patterns)
    if (!parsed.success) {
      throw new Error(
        `${packageJsonPath} treeport.${field} must be a string array`
      )
    }

    for (const pattern of parsed.data) {
      const target = pattern.startsWith('!') ? pattern.slice(1) : pattern
      const normalized = normalizePattern(target)
      if (
        !normalized ||
        path.posix.isAbsolute(normalized) ||
        normalized === '..' ||
        normalized.startsWith('../') ||
        normalized.includes('/../') ||
        pattern.startsWith('+') ||
        pattern.startsWith('-')
      ) {
        throw new Error(
          `${packageJsonPath} treeport.${field} contains an invalid package-relative pattern: ${pattern}`
        )
      }
    }
    return [...parsed.data]
  }

  private validateWebPanelManifest(
    entries: PackageManifestInput,
    packageJsonPath: string
  ): WebPanelManifestEntry[] {
    const parsedEntries = z.array(z.unknown()).safeParse(entries)
    if (!parsedEntries.success) {
      throw new Error(`${packageJsonPath} treeport.webPanels must be an array`)
    }

    return parsedEntries.data.map((entry): WebPanelManifestEntry => {
      const parsed = webPanelManifestEntrySchema.safeParse(entry)
      if (!parsed.success) {
        throw new Error(
          `${packageJsonPath} contains an invalid web panel definition`
        )
      }

      const parsedSource = z.string().safeParse(parsed.data)
      if (parsedSource.success) {
        this.validateManifestPatterns(
          [parsedSource.data],
          'webPanels',
          packageJsonPath
        )
        return { source: parsedSource.data, permissions: [] }
      }

      const parsedDefinition = z
        .strictObject({
          source: z.string(),
          permissions: z
            .array(z.enum(['same-origin', 'host-browser']))
            .optional()
        })
        .parse(parsed.data)
      const { source, permissions = [] } = parsedDefinition
      if (source.startsWith('!')) {
        throw new Error(
          `${packageJsonPath} contains an invalid web panel definition`
        )
      }

      this.validateManifestPatterns([source], 'webPanels', packageJsonPath)
      const uniquePermissions = new Set(permissions)
      if (uniquePermissions.size !== permissions.length) {
        throw new Error(
          `${packageJsonPath} contains an invalid web panel permission`
        )
      }

      return { source, permissions: [...uniquePermissions] }
    })
  }

  private async resourceCandidates(
    root: string,
    scope: PackageScope,
    source: string,
    projectId: string | null
  ): Promise<ResourceCandidates> {
    const canonicalRoot = await fs.realpath(root)
    const webPanels: ResourceCandidates['webPanels'] = []
    const terminalPresets: ResourceCandidates['terminalPresets'] = []
    const diagnostics: PackageResourceDiagnostic[] = []
    const visited = new Set<string>()

    const walk = async (directory: string): Promise<void> => {
      const realDirectory = await fs.realpath(directory).catch(() => null)
      if (!realDirectory || !isWithin(realDirectory, canonicalRoot)) {
        diagnostics.push(
          diagnostic(
            scope,
            'Package resource directory escapes the package root',
            {
              source,
              projectId: projectId ?? undefined,
              path: directory
            }
          )
        )
        return
      }

      if (visited.has(realDirectory)) {
        return
      }

      visited.add(realDirectory)

      const entries = await fs
        .readdir(directory, { withFileTypes: true })
        .then((values) =>
          values.sort((left, right) => left.name.localeCompare(right.name))
        )
        .catch((error) => {
          diagnostics.push(
            diagnostic(
              scope,
              `Could not read package directory: ${
                error instanceof Error ? error.message : String(error)
              }`,
              {
                source,
                projectId: projectId ?? undefined,
                path: directory
              }
            )
          )
          return []
        })
      const index = entries.find((entry) => entry.name === 'index.html')
      if (index) {
        const indexPath = path.join(directory, index.name)
        const realIndex = await fs.realpath(indexPath).catch(() => null)
        const indexIsFile = realIndex
          ? await fs
              .stat(realIndex)
              .then((value) => value.isFile())
              .catch(() => false)
          : false
        if (realIndex && indexIsFile && isWithin(realIndex, canonicalRoot)) {
          webPanels.push({
            root: directory,
            relativePath: toPosix(path.relative(root, directory)) || '.'
          })
        } else {
          diagnostics.push(
            diagnostic(scope, 'Web panel entry escapes the package root', {
              source,
              projectId: projectId ?? undefined,
              resourceType: 'web-panel',
              path: indexPath
            })
          )
        }
      }

      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
          continue
        }

        const candidate = path.join(directory, entry.name)
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          const stat = await fs.stat(candidate).catch(() => null)
          if (stat?.isDirectory()) {
            await walk(candidate)
            continue
          }
        }

        if (!entry.name.endsWith('.json')) {
          continue
        }

        const realFile = await fs.realpath(candidate).catch(() => null)
        if (!realFile || !isWithin(realFile, canonicalRoot)) {
          diagnostics.push(
            diagnostic(
              scope,
              'Terminal preset resource escapes the package root',
              {
                source,
                projectId: projectId ?? undefined,
                resourceType: 'terminal-preset',
                path: candidate
              }
            )
          )
          continue
        }

        terminalPresets.push({
          path: candidate,
          relativePath: toPosix(path.relative(root, candidate))
        })
      }
    }

    await walk(root)
    return { webPanels, terminalPresets, diagnostics }
  }

  private manifestAllows(
    relativePath: string,
    patterns: string[],
    resourceType: 'web-panel' | 'terminal-preset'
  ): boolean {
    const positives = patterns.filter((pattern) => !pattern.startsWith('!'))
    const exclusions = patterns
      .filter((pattern) => pattern.startsWith('!'))
      .map((pattern) => pattern.slice(1))
    const comparable =
      resourceType === 'web-panel'
        ? [relativePath, `${relativePath}/index.html`]
        : [relativePath]
    const matches = (pattern: string) =>
      comparable.some((candidate) => patternMatches(candidate, pattern))
    return positives.some(matches) && !exclusions.some(matches)
  }

  private async loadPackage(
    configured: PackageSource,
    parsed: ParsedPackageSource,
    root: string,
    scope: PackageScope,
    projectId: string | null
  ): Promise<ResolvedPackage> {
    const source = sourceString(configured)
    const packageJsonPath = path.join(root, 'package.json')
    const packageJsonContent = await fs
      .readFile(packageJsonPath, 'utf8')
      .catch((error) => {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          return null
        }

        throw error
      })
    let manifest: PackageManifest | undefined
    if (packageJsonContent !== null) {
      let packageJson: unknown
      try {
        packageJson = JSON.parse(packageJsonContent)
      } catch (error) {
        throw new Error(
          `Could not parse ${packageJsonPath}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
      const parsedPackageJson = z
        .looseObject({ treeport: z.unknown().optional() })
        .safeParse(packageJson)
      if (!parsedPackageJson.success) {
        throw new Error(`${packageJsonPath} must contain a JSON object`)
      }

      if (parsedPackageJson.data.treeport !== undefined) {
        const parsedTreeport = z
          .looseObject({
            webPanels: z.unknown().optional(),
            terminalPresets: z.unknown().optional()
          })
          .safeParse(parsedPackageJson.data.treeport)
        if (!parsedTreeport.success) {
          throw new Error(
            `${packageJsonPath} treeport manifest must be an object`
          )
        }

        manifest = {
          webPanels: this.validateWebPanelManifest(
            parsedTreeport.data.webPanels ?? [],
            packageJsonPath
          ),
          terminalPresets: this.validateManifestPatterns(
            parsedTreeport.data.terminalPresets ?? [],
            'terminalPresets',
            packageJsonPath
          )
        }
      }
    }

    const candidates = await this.resourceCandidates(
      root,
      scope,
      source,
      projectId
    )
    const panelCandidates = candidates.webPanels.filter((candidate) =>
      manifest
        ? this.manifestAllows(
            candidate.relativePath,
            manifest.webPanels.map((entry) => entry.source),
            'web-panel'
          )
        : candidate.relativePath.startsWith('web-panels/') &&
          candidate.relativePath.split('/').length === 2
    )
    const presetCandidates = candidates.terminalPresets.filter((candidate) =>
      manifest
        ? this.manifestAllows(
            candidate.relativePath,
            manifest.terminalPresets,
            'terminal-preset'
          )
        : candidate.relativePath.startsWith('terminal-presets/') &&
          candidate.relativePath.split('/').length === 2
    )
    const filter = packageFilter(configured)
    const autoload = filter?.autoload !== false
    const metadata = {
      type: 'package' as const,
      packageId: parsed.packageId,
      source,
      scope
    }
    const packageLockPath =
      parsed.type === 'npm'
        ? await Promise.all(
            [
              'package-lock.json',
              'pnpm-lock.yaml',
              'yarn.lock',
              'bun.lock',
              'bun.lockb'
            ].map(async (name) => {
              const candidate = path.join(this.npmRoot(scope, projectId), name)
              return fs
                .stat(candidate)
                .then((stat) => (stat.isFile() ? candidate : undefined))
                .catch(() => undefined)
            })
          ).then((values) => values.find(Boolean))
        : undefined
    const webPanels = applyNormalFilter(
      panelCandidates.map((candidate): ResolvedWebPanel => {
        const resourceId = encodeURIComponent(
          path.posix.basename(candidate.relativePath)
        )
        const permissions = [
          ...new Set(
            (manifest?.webPanels ?? [])
              .filter((entry) =>
                this.manifestAllows(
                  candidate.relativePath,
                  [entry.source],
                  'web-panel'
                )
              )
              .flatMap((entry) => entry.permissions)
          )
        ]
        const resolved: ResolvedWebPanel = {
          definition: {
            id: `package:${parsed.packageId}:web-panel:${resourceId}`,
            title: titleFromPath(candidate.relativePath),
            source: metadata,
            permissions,
            permissionsGranted: permissions.length === 0,
            sandbox: { allowSameOrigin: permissions.includes('same-origin') }
          },
          root: candidate.root,
          entry: 'index.html',
          packageRoot: root,
          development: parsed.type === 'local',
          relativePath: candidate.relativePath,
          enabled: true
        }
        if (packageLockPath) {
          resolved.packageLockPath = packageLockPath
        }

        return resolved
      }),
      filter?.webPanels,
      autoload
    )
    const terminalPresets: ResolvedTerminalPreset[] = []
    for (const candidate of presetCandidates) {
      let value: unknown
      try {
        value = JSON.parse(await fs.readFile(candidate.path, 'utf8'))
      } catch (error) {
        candidates.diagnostics.push(
          diagnostic(
            scope,
            `Could not parse terminal preset: ${
              error instanceof Error ? error.message : String(error)
            }`,
            {
              source,
              projectId: projectId ?? undefined,
              resourceType: 'terminal-preset',
              path: candidate.path
            }
          )
        )
        continue
      }
      const result = createTerminalPresetSchema.safeParse(value)
      if (!result.success) {
        candidates.diagnostics.push(
          diagnostic(
            scope,
            `Invalid terminal preset: ${result.error.issues
              .map(
                (issue) => `${issue.path.join('.') || 'value'} ${issue.message}`
              )
              .join('; ')}`,
            {
              source,
              projectId: projectId ?? undefined,
              resourceType: 'terminal-preset',
              path: candidate.path
            }
          )
        )
        continue
      }

      const resourceName = path.posix.basename(candidate.relativePath, '.json')
      terminalPresets.push({
        definition: {
          id: `package:${parsed.packageId}:terminal-preset:${encodeURIComponent(
            resourceName
          )}`,
          name: result.data.name,
          executable: result.data.executable,
          args: [...result.data.args],
          shellCommand: null,
          cwd: null,
          env: {},
          closeOnSuccess: result.data.closeOnSuccess,
          source: metadata
        },
        relativePath: candidate.relativePath,
        enabled: true
      })
    }

    const filteredPresets = applyNormalFilter(
      terminalPresets,
      filter?.terminalPresets,
      autoload
    )
    const duplicateIds = new Set<string>()
    for (const resource of [...webPanels, ...filteredPresets]) {
      const resourceId = resource.definition.id
      if (duplicateIds.has(resourceId)) {
        candidates.diagnostics.push(
          diagnostic(
            scope,
            `Duplicate package resource identity: ${resourceId}`,
            {
              source,
              projectId: projectId ?? undefined,
              path: resource.relativePath
            }
          )
        )
        resource.enabled = false
      }

      duplicateIds.add(resourceId)
    }

    return {
      source,
      identity: parsed.identity,
      packageId: parsed.packageId,
      scope,
      projectId,
      root,
      installedPath: root,
      webPanels,
      terminalPresets: filteredPresets,
      diagnostics: candidates.diagnostics
    }
  }

  private clonePackage(pkg: ResolvedPackage): ResolvedPackage {
    return {
      ...pkg,
      webPanels: pkg.webPanels.map((resource) => ({
        ...resource,
        definition: {
          ...resource.definition,
          source: { ...resource.definition.source }
        }
      })),
      terminalPresets: pkg.terminalPresets.map((resource) => ({
        ...resource,
        definition: {
          ...resource.definition,
          args: [...resource.definition.args],
          source: { ...resource.definition.source }
        }
      })),
      diagnostics: [...pkg.diagnostics]
    }
  }

  private applyProjectDelta(
    base: ResolvedPackage,
    configured: PackageSourceObject,
    projectId: string
  ): ResolvedPackage {
    const result = this.clonePackage(base)
    result.source = configured.source
    result.scope = 'project'
    result.projectId = projectId
    result.webPanels = applyDelta(result.webPanels, configured.webPanels)
    result.terminalPresets = applyDelta(
      result.terminalPresets,
      configured.terminalPresets
    )
    for (const resource of [...result.webPanels, ...result.terminalPresets]) {
      resource.definition.source = {
        type: 'package',
        packageId: result.packageId,
        source: configured.source,
        scope: 'project'
      }
    }
    return result
  }

  private async resolvePackage(
    configured: PackageSource,
    scope: PackageScope,
    projectId: string | null,
    settings: TreeportSettings,
    previous?: ResolvedPackage
  ): Promise<ResolvedPackage> {
    const settingsPath = this.settingsPath(scope, projectId ?? undefined)
    const parsed = await this.parseSource(
      sourceString(configured),
      settingsPath
    )
    try {
      const root = await this.ensureInstalled(
        parsed,
        scope,
        projectId,
        settings,
        false
      )
      return await this.loadPackage(configured, parsed, root, scope, projectId)
    } catch (error) {
      if (previous && previous.scope === scope) {
        const preserved = this.clonePackage(previous)
        preserved.diagnostics.push(
          diagnostic(
            scope,
            `Reload failed; preserving the previous package resources: ${
              error instanceof Error ? error.message : String(error)
            }`,
            {
              source: sourceString(configured),
              projectId: projectId ?? undefined
            }
          )
        )
        return preserved
      }

      return {
        source: sourceString(configured),
        identity: parsed.identity,
        packageId: parsed.packageId,
        scope,
        projectId,
        root:
          parsed.type === 'local'
            ? parsed.path
            : this.npmPackagePath(parsed, scope, projectId),
        installedPath:
          parsed.type === 'local'
            ? parsed.path
            : this.npmPackagePath(parsed, scope, projectId),
        webPanels: [],
        terminalPresets: [],
        diagnostics: [
          diagnostic(
            scope,
            error instanceof Error ? error.message : String(error),
            {
              source: sourceString(configured),
              projectId: projectId ?? undefined
            }
          )
        ]
      }
    }
  }

  private async reconcileGlobal(force = false): Promise<void> {
    const settingsPath = this.settingsPath('global')
    const changed = await this.serialize('global', async () => {
      const file = await this.readSettingsFile(settingsPath)
      if (!force && file.fingerprint === this.globalFingerprint) {
        return false
      }

      this.globalFingerprint = file.fingerprint
      if (file.error) {
        this.globalState = {
          ...this.globalState,
          diagnostics: [
            diagnostic(
              'global',
              `Could not read ${settingsPath}: ${file.error.message}`,
              { path: settingsPath }
            )
          ]
        }
        return false
      }

      const parsedSettings = this.parseSettings(
        file.content,
        settingsPath,
        'global'
      )
      if (!parsedSettings.settings) {
        this.globalState = {
          ...this.globalState,
          diagnostics: [parsedSettings.diagnostic!]
        }
        return false
      }

      const packages = new Map<string, ResolvedPackage>()
      const diagnostics: PackageResourceDiagnostic[] = []
      for (const configured of parsedSettings.settings.packages) {
        let parsed: ParsedPackageSource
        try {
          parsed = await this.parseSource(
            sourceString(configured),
            settingsPath
          )
        } catch (error) {
          diagnostics.push(
            diagnostic(
              'global',
              error instanceof Error ? error.message : String(error),
              {
                source: sourceString(configured)
              }
            )
          )
          continue
        }
        if (packages.has(parsed.identity)) {
          diagnostics.push(
            diagnostic(
              'global',
              `Duplicate package identity ${parsed.identity}; the first entry wins`,
              {
                source: sourceString(configured)
              }
            )
          )
          continue
        }

        const resolved = await this.resolvePackage(
          configured,
          'global',
          null,
          parsedSettings.settings,
          this.globalState.packages.get(parsed.identity)
        )
        packages.set(parsed.identity, resolved)
        diagnostics.push(...resolved.diagnostics)
      }
      this.globalState = {
        settings: parsedSettings.settings,
        packages,
        diagnostics
      }
      return true
    })

    if (changed) {
      await Promise.all(
        [...this.projectContexts.keys()].map((projectId) =>
          this.reconcileProject(projectId, true)
        )
      )
    }
  }

  private async reconcileProject(
    projectId: string,
    force = false
  ): Promise<void> {
    const context = this.projectContexts.get(projectId)
    if (!context) {
      return
    }

    const settingsPath = this.settingsPath('project', projectId)
    await this.serialize(`project:${projectId}`, async () => {
      const file = await this.readSettingsFile(settingsPath)
      if (
        !force &&
        file.fingerprint === this.projectFingerprints.get(projectId)
      ) {
        return
      }

      this.projectFingerprints.set(projectId, file.fingerprint)
      const previous = this.projectStates.get(projectId)
      if (file.error) {
        const readDiagnostic = diagnostic(
          'project',
          `Could not read ${settingsPath}: ${file.error.message}`,
          { projectId, path: settingsPath }
        )
        if (previous) {
          this.projectStates.set(projectId, {
            ...previous,
            diagnostics: [readDiagnostic]
          })
        } else {
          this.projectStates.set(projectId, {
            context,
            settings: EMPTY_SETTINGS,
            ownPackages: new Map(),
            effectivePackages: new Map(this.globalState.packages),
            diagnostics: [readDiagnostic]
          })
        }

        return
      }

      const parsedSettings = this.parseSettings(
        file.content,
        settingsPath,
        'project',
        projectId
      )
      if (!parsedSettings.settings) {
        if (previous) {
          this.projectStates.set(projectId, {
            ...previous,
            diagnostics: [parsedSettings.diagnostic!]
          })
        } else {
          this.projectStates.set(projectId, {
            context,
            settings: EMPTY_SETTINGS,
            ownPackages: new Map(),
            effectivePackages: new Map(this.globalState.packages),
            diagnostics: [parsedSettings.diagnostic!]
          })
        }

        return
      }

      const ownPackages = new Map<string, ResolvedPackage>()
      const effectivePackages = new Map(
        [...this.globalState.packages.entries()].map(([identity, pkg]) => [
          identity,
          this.clonePackage(pkg)
        ])
      )
      const diagnostics: PackageResourceDiagnostic[] = []
      for (const configured of parsedSettings.settings.packages) {
        let parsed: ParsedPackageSource
        try {
          parsed = await this.parseSource(
            sourceString(configured),
            settingsPath
          )
        } catch (error) {
          diagnostics.push(
            diagnostic(
              'project',
              error instanceof Error ? error.message : String(error),
              {
                source: sourceString(configured),
                projectId
              }
            )
          )
          continue
        }
        if (ownPackages.has(parsed.identity)) {
          diagnostics.push(
            diagnostic(
              'project',
              `Duplicate package identity ${parsed.identity}; the first entry wins`,
              { source: sourceString(configured), projectId }
            )
          )
          continue
        }

        const filter = packageFilter(configured)
        if (
          filter?.autoload === false &&
          effectivePackages.has(parsed.identity)
        ) {
          const delta = this.applyProjectDelta(
            effectivePackages.get(parsed.identity)!,
            filter,
            projectId
          )
          ownPackages.set(parsed.identity, delta)
          effectivePackages.set(parsed.identity, delta)
          continue
        }

        const resolved = await this.resolvePackage(
          configured,
          'project',
          projectId,
          parsedSettings.settings,
          previous?.ownPackages.get(parsed.identity)
        )
        const projectPackage =
          filter?.autoload === false
            ? this.applyProjectDelta(
                {
                  ...resolved,
                  webPanels: resolved.webPanels.map((resource) => ({
                    ...resource,
                    enabled: false
                  })),
                  terminalPresets: resolved.terminalPresets.map((resource) => ({
                    ...resource,
                    enabled: false
                  }))
                },
                filter,
                projectId
              )
            : resolved
        ownPackages.set(parsed.identity, projectPackage)
        effectivePackages.set(parsed.identity, projectPackage)
        diagnostics.push(...projectPackage.diagnostics)
      }

      this.projectStates.set(projectId, {
        context,
        settings: parsedSettings.settings,
        ownPackages,
        effectivePackages,
        diagnostics
      })
    })
  }

  private context(
    project: Pick<ProjectRecord, 'id' | 'name' | 'rootPath'>
  ): ProjectPackageContext {
    return {
      id: project.id,
      name: project.name,
      rootPath: project.rootPath
    }
  }

  syncProjects(
    projects: Array<Pick<ProjectRecord, 'id' | 'name' | 'rootPath'>>
  ): void {
    for (const project of projects) {
      const next = this.context(project)
      const previous = this.projectContexts.get(project.id)
      this.projectContexts.set(project.id, next)
      if (
        previous &&
        (previous.rootPath !== next.rootPath || previous.name !== next.name)
      ) {
        this.projectFingerprints.delete(project.id)
      }
    }
  }

  async initialize(
    projects: Array<Pick<ProjectRecord, 'id' | 'name' | 'rootPath'>>
  ): Promise<void> {
    this.syncProjects(projects)
    await this.reconcileGlobal(true)
    await Promise.all(
      projects.map((project) => this.reconcileProject(project.id, true))
    )
  }

  async registerProject(
    project: Pick<ProjectRecord, 'id' | 'name' | 'rootPath'>
  ): Promise<void> {
    this.syncProjects([project])
    await this.reconcileGlobal()
    await this.reconcileProject(project.id, true)
  }

  forgetProject(projectId: string): void {
    this.projectContexts.delete(projectId)
    this.projectStates.delete(projectId)
    this.projectFingerprints.delete(projectId)
  }

  private async ensureProject(projectId: string): Promise<ProjectPackageState> {
    await this.reconcileGlobal()
    await this.reconcileProject(projectId)
    const state = this.projectStates.get(projectId)
    if (!state) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Project not found', 404)
    }

    return state
  }

  async webPanelDefinitions(projectId: string): Promise<ResolvedWebPanel[]> {
    const state = await this.ensureProject(projectId)
    return [...state.effectivePackages.values()].flatMap((pkg) =>
      pkg.webPanels.filter((resource) => resource.enabled)
    )
  }

  async terminalPresetDefinitions(
    projectId?: string
  ): Promise<TerminalPresetDefinition[]> {
    await this.reconcileGlobal()
    const packages = projectId
      ? (await this.ensureProject(projectId)).effectivePackages
      : this.globalState.packages
    return [...packages.values()].flatMap((pkg) =>
      pkg.terminalPresets
        .filter((resource) => resource.enabled)
        .map((resource) => resource.definition)
    )
  }

  async list(): Promise<{
    packages: PackageListing[]
    diagnostics: PackageResourceDiagnostic[]
  }> {
    await this.reconcileGlobal()
    await Promise.all(
      [...this.projectContexts.keys()].map((projectId) =>
        this.reconcileProject(projectId)
      )
    )
    const packages: PackageListing[] = []
    for (const pkg of this.globalState.packages.values()) {
      packages.push({
        source: pkg.source,
        identity: pkg.identity,
        scope: 'global',
        projectId: null,
        projectName: null,
        installedPath: pkg.installedPath,
        resources: {
          webPanels: pkg.webPanels.filter((resource) => resource.enabled)
            .length,
          terminalPresets: pkg.terminalPresets.filter(
            (resource) => resource.enabled
          ).length
        },
        diagnostics: [...pkg.diagnostics]
      })
    }
    for (const state of this.projectStates.values()) {
      for (const pkg of state.ownPackages.values()) {
        packages.push({
          source: pkg.source,
          identity: pkg.identity,
          scope: 'project',
          projectId: state.context.id,
          projectName: state.context.name,
          installedPath: pkg.installedPath,
          resources: {
            webPanels: pkg.webPanels.filter((resource) => resource.enabled)
              .length,
            terminalPresets: pkg.terminalPresets.filter(
              (resource) => resource.enabled
            ).length
          },
          diagnostics: [...pkg.diagnostics]
        })
      }
    }
    return {
      packages,
      diagnostics: [
        ...this.globalState.diagnostics,
        ...[...this.projectStates.values()].flatMap(
          (state) => state.diagnostics
        )
      ]
    }
  }

  private async currentSettings(
    scope: PackageScope,
    projectId?: string
  ): Promise<{ settings: TreeportSettings; settingsPath: string }> {
    const settingsPath = this.settingsPath(scope, projectId)
    const file = await this.readSettingsFile(settingsPath)
    if (file.error) {
      throw new DomainError(
        'INVALID_PACKAGE_SETTINGS',
        `Could not read ${settingsPath}: ${file.error.message}`,
        400,
        { path: settingsPath }
      )
    }

    const parsed = this.parseSettings(
      file.content,
      settingsPath,
      scope,
      projectId
    )
    if (!parsed.settings) {
      throw new DomainError(
        'INVALID_PACKAGE_SETTINGS',
        parsed.diagnostic!.message,
        400,
        parsed.diagnostic
      )
    }

    return { settings: parsed.settings, settingsPath }
  }

  private async writeSettings(
    settingsPath: string,
    settings: TreeportSettings,
    packages: PackageSource[]
  ): Promise<void> {
    await fs.mkdir(path.dirname(settingsPath), {
      recursive: true,
      mode: 0o700
    })
    const raw = { ...settings.raw, packages }
    const temporary = `${settingsPath}.${process.pid}.${crypto
      .randomBytes(6)
      .toString('hex')}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, {
      mode: 0o600
    })
    await fs.rename(temporary, settingsPath)
  }

  private persistedSource(
    parsed: ParsedPackageSource,
    settingsPath: string
  ): string {
    if (parsed.type === 'npm') {
      return parsed.source
    }

    const relative = toPosix(
      path.relative(path.dirname(settingsPath), parsed.path)
    )
    if (!relative) {
      return './'
    }

    return relative.startsWith('.') ? relative : `./${relative}`
  }

  async install(
    source: string,
    projectId?: string
  ): Promise<PackageOperationResult> {
    const scope: PackageScope = projectId ? 'project' : 'global'
    if (projectId && !this.projectContexts.has(projectId)) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Project not found', 404)
    }

    const result = await this.serialize(
      projectId ? `project:${projectId}` : 'global',
      async () => {
        const { settings, settingsPath } = await this.currentSettings(
          scope,
          projectId
        )
        const parsed = await this.parseSource(source, settingsPath)
        const root = await this.ensureInstalled(
          parsed,
          scope,
          projectId ?? null,
          settings,
          true
        )
        await this.loadPackage(
          this.persistedSource(parsed, settingsPath),
          parsed,
          root,
          scope,
          projectId ?? null
        )
        const persisted = this.persistedSource(parsed, settingsPath)
        let replaced = false
        const next: PackageSource[] = []
        for (const configured of settings.packages) {
          const existing = await this.parseSource(
            sourceString(configured),
            settingsPath
          )
          if (existing.identity !== parsed.identity) {
            next.push(configured)
          } else if (!replaced) {
            const filter = packageFilter(configured)
            next.push(filter ? { ...filter, source: persisted } : persisted)
            replaced = true
          }
        }
        if (!replaced) {
          next.push(persisted)
        }

        await this.writeSettings(settingsPath, settings, next)
        return {
          action: 'install' as const,
          source: persisted,
          scope,
          projectId: projectId ?? null,
          status: 'installed' as const
        }
      }
    )
    if (scope === 'global') {
      await this.reconcileGlobal(true)
    } else {
      await this.reconcileProject(projectId!, true)
    }

    return result
  }

  async remove(
    source: string,
    projectId?: string
  ): Promise<PackageOperationResult> {
    const scope: PackageScope = projectId ? 'project' : 'global'
    const result = await this.serialize(
      projectId ? `project:${projectId}` : 'global',
      async () => {
        const { settings, settingsPath } = await this.currentSettings(
          scope,
          projectId
        )
        const parsed = await this.parseSource(source, settingsPath)
        const matching: PackageSource[] = []
        const remaining: PackageSource[] = []
        for (const configured of settings.packages) {
          const existing = await this.parseSource(
            sourceString(configured),
            settingsPath
          )
          ;(existing.identity === parsed.identity ? matching : remaining).push(
            configured
          )
        }
        if (matching.length === 0) {
          throw new DomainError(
            'PACKAGE_NOT_CONFIGURED',
            `No configured package matches ${source}`,
            404
          )
        }

        if (parsed.type === 'npm') {
          await this.runNpm(
            'remove',
            parsed,
            scope,
            projectId ?? null,
            settings
          )
        }

        await this.writeSettings(settingsPath, settings, remaining)
        return {
          action: 'remove' as const,
          source: sourceString(matching[0]!),
          scope,
          projectId: projectId ?? null,
          status: 'removed' as const
        }
      }
    )
    if (scope === 'global') {
      await this.reconcileGlobal(true)
    } else {
      await this.reconcileProject(projectId!, true)
    }

    return result
  }

  async update(source?: string): Promise<PackageOperationResult[]> {
    await this.reconcileGlobal()
    await Promise.all(
      [...this.projectContexts.keys()].map((projectId) =>
        this.reconcileProject(projectId)
      )
    )
    let requestedIdentity: string | undefined
    if (source) {
      requestedIdentity = (
        await this.parseSource(source, this.settingsPath('global'))
      ).identity
    }

    const targets: Array<{
      configured: PackageSource
      scope: PackageScope
      projectId?: string
      settings: TreeportSettings
      settingsPath: string
    }> = []
    for (const configured of this.globalState.settings.packages) {
      targets.push({
        configured,
        scope: 'global',
        settings: this.globalState.settings,
        settingsPath: this.settingsPath('global')
      })
    }
    for (const state of this.projectStates.values()) {
      for (const configured of state.settings.packages) {
        targets.push({
          configured,
          scope: 'project',
          projectId: state.context.id,
          settings: state.settings,
          settingsPath: this.settingsPath('project', state.context.id)
        })
      }
    }

    const matching: typeof targets = []
    for (const target of targets) {
      const parsed = await this.parseSource(
        sourceString(target.configured),
        target.settingsPath
      )
      if (!requestedIdentity || parsed.identity === requestedIdentity) {
        matching.push(target)
      }
    }
    if (source && matching.length === 0) {
      throw new DomainError(
        'PACKAGE_NOT_CONFIGURED',
        `No configured package matches ${source}`,
        404
      )
    }

    const results: PackageOperationResult[] = []
    for (const target of matching) {
      const parsed = await this.parseSource(
        sourceString(target.configured),
        target.settingsPath
      )
      if (parsed.type === 'local') {
        results.push({
          action: 'update',
          source: sourceString(target.configured),
          scope: target.scope,
          projectId: target.projectId ?? null,
          status: 'skipped',
          reason: 'Local packages are refreshed with treeport reload'
        })
        continue
      }

      if (parsed.exact) {
        results.push({
          action: 'update',
          source: sourceString(target.configured),
          scope: target.scope,
          projectId: target.projectId ?? null,
          status: 'skipped',
          reason: 'Exact npm versions are pinned'
        })
        continue
      }

      if (
        target.scope === 'project' &&
        packageFilter(target.configured)?.autoload === false &&
        this.globalState.packages.has(parsed.identity)
      ) {
        results.push({
          action: 'update',
          source: sourceString(target.configured),
          scope: target.scope,
          projectId: target.projectId ?? null,
          status: 'skipped',
          reason: 'Project delta inherits the global installation'
        })
        continue
      }

      await this.serialize(
        target.projectId ? `project:${target.projectId}` : 'global',
        () =>
          this.runNpm(
            'install',
            parsed,
            target.scope,
            target.projectId ?? null,
            target.settings,
            true
          )
      )
      results.push({
        action: 'update',
        source: sourceString(target.configured),
        scope: target.scope,
        projectId: target.projectId ?? null,
        status: 'updated'
      })
    }
    await this.reload()
    return results
  }

  async reload(projectId?: string): Promise<{
    results: PackageOperationResult[]
    diagnostics: PackageResourceDiagnostic[]
  }> {
    if (projectId) {
      await this.reconcileGlobal()
      await this.reconcileProject(projectId, true)
      const state = this.projectStates.get(projectId)
      return {
        results: [
          {
            action: 'reload',
            source: null,
            scope: 'project',
            projectId,
            status: 'reloaded'
          }
        ],
        diagnostics: state?.diagnostics ?? []
      }
    }

    await this.reconcileGlobal(true)
    await Promise.all(
      [...this.projectContexts.keys()].map((id) =>
        this.reconcileProject(id, true)
      )
    )
    const listed = await this.list()
    return {
      results: [
        {
          action: 'reload',
          source: null,
          scope: 'global',
          projectId: null,
          status: 'reloaded'
        },
        ...[...this.projectContexts.keys()].map((id) => ({
          action: 'reload' as const,
          source: null,
          scope: 'project' as const,
          projectId: id,
          status: 'reloaded' as const
        }))
      ],
      diagnostics: listed.diagnostics
    }
  }
}
