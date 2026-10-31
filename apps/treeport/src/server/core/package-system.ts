import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import * as Effect from 'effect/Effect'
import {
  createLauncherSchema,
  decodeUnknownOrNull,
  isSchemaValue,
  type PackageListing,
  type PackageOperationResult,
  type PackageResourceDiagnostic,
  type PackageScope,
  type PackageSource,
  type ProjectRecord,
  type LauncherDefinition,
  type WebAppDefinition,
  type WebAppPermission,
  webAppPermissionSchema
} from '@treeport/shared'
import type { AppConfig } from './config'
import { DomainError } from './domain'
import { PackageMutations } from './services/package/package-mutations'

type ApplicationServices = PackageMutations

interface TreeportSettings {
  raw: object
  packages: PackageSource[]
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

interface ParsedPackageSource {
  path: string
  identity: string
  packageId: string
}

type PackageSourceObject = Exclude<PackageSource, string>

export interface ResolvedWebApp {
  definition: WebAppDefinition
  root: string
  entry: string
  packageRoot: string
  development: boolean
  relativePath: string
  enabled: boolean
}

interface ResolvedLauncher {
  definition: LauncherDefinition
  relativePath: string
  enabled: boolean
}

type PackageService = z.output<typeof packageServiceSchema> & { name: string }

export interface PackageServiceDeclaration extends PackageService {
  packageId: string
  root: string
  projectIds: string[] | null
}

interface ResolvedPackage {
  source: string
  identity: string
  packageId: string
  scope: PackageScope
  projectId: string | null
  root: string
  installedPath: string
  webApps: ResolvedWebApp[]
  launchers: ResolvedLauncher[]
  services: PackageService[]
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
  webApps: Array<{ root: string; relativePath: string }>
  launchers: Array<{ path: string; relativePath: string }>
  diagnostics: PackageResourceDiagnostic[]
}

interface WebAppManifestEntry {
  title: string | null
  source: string
  permissions: WebAppPermission[]
  sandbox: boolean
}

interface PackageManifest {
  webApps: WebAppManifestEntry[]
  launchers: string[]
  services: PackageService[]
}

const packageManifestInputSchema = z.unknown()

type PackageManifestInput = z.input<typeof packageManifestInputSchema>

const manifestPatternsSchema = z.array(z.string())

const packageServiceSchema = z.strictObject({
  scope: z.literal('instance'),
  start: z.enum(['on-demand', 'always']).default('on-demand'),
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  readinessPath: z
    .string()
    .regex(/^\/(?!\/)/u)
    .nullable()
    .default(null),
  query: z.record(z.string(), z.string()).default({})
})

const webAppManifestEntrySchema = z.union([
  z.string(),
  z.strictObject({
    source: z.string(),
    title: z.string().trim().min(1).optional(),
    sandbox: z.boolean().optional(),
    permissions: z
      .array(
        z.custom<WebAppPermission>((value) =>
          isSchemaValue(webAppPermissionSchema, value)
        )
      )
      .optional()
  })
])

const EMPTY_SETTINGS: TreeportSettings = { raw: {}, packages: [] }

function packagePromise<Result>(
  evaluate: () => Promise<Result>
): Effect.Effect<Result, DomainError<unknown>> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (error) => error
  }).pipe(
    Effect.catchAll((error) =>
      error instanceof DomainError ? Effect.fail(error) : Effect.die(error)
    )
  )
}

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
      webApps: z.array(z.string()).optional(),
      launchers: z.array(z.string()).optional()
    })
    .parse(source)

  const result: PackageSourceObject = { source: data.source }

  if (data.autoload !== undefined) {
    result.autoload = data.autoload
  }

  if (data.webApps !== undefined) {
    result.webApps = data.webApps
  }

  if (data.launchers !== undefined) {
    result.launchers = data.launchers
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
    resourceType?: 'web-app' | 'launcher' | undefined
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

  constructor(private readonly config: AppConfig) {}

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
      webApps: z.unknown().optional(),
      launchers: z.unknown().optional()
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

      const parsedWebApps = z
        .array(z.string())
        .safeParse(parsedEntry.data.webApps)

      const parsedLaunchers = z
        .array(z.string())
        .safeParse(parsedEntry.data.launchers)

      for (const [key, original, parsed] of [
        ['webApps', parsedEntry.data.webApps, parsedWebApps],
        ['launchers', parsedEntry.data.launchers, parsedLaunchers]
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

      if (parsedWebApps.success) {
        configured.webApps = parsedWebApps.data
      }

      if (parsedLaunchers.success) {
        configured.launchers = parsedLaunchers.data
      }

      packages.push(configured)
    }

    const settings: TreeportSettings = { raw: parsedRaw.data, packages }

    return { settings }
  }

  private async parseSource(
    source: string,
    settingsPath: string
  ): Promise<ParsedPackageSource> {
    const trimmed = source.trim()

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
        'Package sources must use an explicit local path',
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
      path: canonical,
      identity,
      packageId: `local:${crypto
        .createHash('sha256')
        .update(canonical)
        .digest('hex')
        .slice(0, 16)}`
    }
  }

  private async packageRoot(source: ParsedPackageSource): Promise<string> {
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

  private validateWebAppManifest(
    entries: PackageManifestInput,
    packageJsonPath: string
  ): WebAppManifestEntry[] {
    const parsedEntries = z.array(z.unknown()).safeParse(entries)

    if (!parsedEntries.success) {
      throw new Error(`${packageJsonPath} treeport.webApps must be an array`)
    }

    return parsedEntries.data.map((entry): WebAppManifestEntry => {
      const parsed = webAppManifestEntrySchema.safeParse(entry)

      if (!parsed.success) {
        throw new Error(
          `${packageJsonPath} contains an invalid web app definition`
        )
      }

      const parsedSource = z.string().safeParse(parsed.data)

      if (parsedSource.success) {
        this.validateManifestPatterns(
          [parsedSource.data],
          'webApps',
          packageJsonPath
        )

        return {
          source: parsedSource.data,
          title: null,
          permissions: [],
          sandbox: true
        }
      }

      const parsedDefinition = z
        .strictObject({
          source: z.string(),
          title: z.string().trim().min(1).optional(),
          sandbox: z.boolean().optional(),
          permissions: z
            .array(
              z.custom<WebAppPermission>((value) =>
                isSchemaValue(webAppPermissionSchema, value)
              )
            )
            .optional()
        })
        .parse(parsed.data)

      const {
        source,
        title = null,
        permissions = [],
        sandbox = true
      } = parsedDefinition

      if (source.startsWith('!')) {
        throw new Error(
          `${packageJsonPath} contains an invalid web app definition`
        )
      }

      this.validateManifestPatterns([source], 'webApps', packageJsonPath)
      const uniquePermissions = new Set(permissions)

      if (uniquePermissions.size !== permissions.length) {
        throw new Error(
          `${packageJsonPath} contains an invalid web app permission`
        )
      }

      return { source, title, permissions: [...uniquePermissions], sandbox }
    })
  }

  private async resourceCandidates(
    root: string,
    scope: PackageScope,
    source: string,
    projectId: string | null
  ): Promise<ResourceCandidates> {
    const canonicalRoot = await fs.realpath(root)
    const webApps: ResourceCandidates['webApps'] = []
    const launchers: ResourceCandidates['launchers'] = []
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
          webApps.push({
            root: directory,
            relativePath: toPosix(path.relative(root, directory)) || '.'
          })
        } else {
          diagnostics.push(
            diagnostic(scope, 'Web app entry escapes the package root', {
              source,
              projectId: projectId ?? undefined,
              resourceType: 'web-app',
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
            diagnostic(scope, 'Launcher resource escapes the package root', {
              source,
              projectId: projectId ?? undefined,
              resourceType: 'launcher',
              path: candidate
            })
          )
          continue
        }

        launchers.push({
          path: candidate,
          relativePath: toPosix(path.relative(root, candidate))
        })
      }
    }

    await walk(root)

    return { webApps, launchers, diagnostics }
  }

  private manifestAllows(
    relativePath: string,
    patterns: string[],
    resourceType: 'web-app' | 'launcher'
  ): boolean {
    const positives = patterns.filter((pattern) => !pattern.startsWith('!'))

    const exclusions = patterns
      .filter((pattern) => pattern.startsWith('!'))
      .map((pattern) => pattern.slice(1))

    const comparable =
      resourceType === 'web-app'
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
            webApps: z.unknown().optional(),
            launchers: z.unknown().optional(),
            services: z.unknown().optional()
          })
          .safeParse(parsedPackageJson.data.treeport)

        if (!parsedTreeport.success) {
          throw new Error(
            `${packageJsonPath} treeport manifest must be an object`
          )
        }

        manifest = {
          webApps: this.validateWebAppManifest(
            parsedTreeport.data.webApps ?? [],
            packageJsonPath
          ),
          launchers: this.validateManifestPatterns(
            parsedTreeport.data.launchers ?? [],
            'launchers',
            packageJsonPath
          ),
          services: (() => {
            const services = z
              .record(z.string().min(1), packageServiceSchema)
              .safeParse(parsedTreeport.data.services ?? {})

            if (!services.success) {
              throw new Error(
                `${packageJsonPath} treeport.services is invalid: ${z.prettifyError(services.error)}`
              )
            }

            return Object.entries(services.data).map(([name, service]) => ({
              name,
              ...service
            }))
          })()
        }
      }
    }

    const candidates = await this.resourceCandidates(
      root,
      scope,
      source,
      projectId
    )

    const appCandidates = candidates.webApps.filter((candidate) =>
      manifest
        ? this.manifestAllows(
            candidate.relativePath,
            manifest.webApps.map((entry) => entry.source),
            'web-app'
          )
        : candidate.relativePath.startsWith('web-apps/') &&
          candidate.relativePath.split('/').length === 2
    )

    const launcherCandidates = candidates.launchers.filter((candidate) =>
      manifest
        ? this.manifestAllows(
            candidate.relativePath,
            manifest.launchers,
            'launcher'
          )
        : candidate.relativePath.startsWith('launchers/') &&
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

    const webApps = applyNormalFilter(
      appCandidates.map((candidate): ResolvedWebApp => {
        const resourceId = encodeURIComponent(
          path.posix.basename(candidate.relativePath)
        )

        const declarations = (manifest?.webApps ?? []).filter((entry) =>
          this.manifestAllows(candidate.relativePath, [entry.source], 'web-app')
        )

        const permissions = [
          ...new Set(declarations.flatMap((entry) => entry.permissions))
        ]

        const sandboxEnabled = declarations.every((entry) => entry.sandbox)

        const resolved: ResolvedWebApp = {
          definition: {
            id: `package:${parsed.packageId}:web-app:${resourceId}`,
            title:
              declarations.find((entry) => entry.title !== null)?.title ??
              titleFromPath(candidate.relativePath),
            icon: null,
            source: metadata,
            permissions,
            permissionsGranted: permissions.length === 0,
            sandbox: {
              enabled: sandboxEnabled,
              allowSameOrigin:
                !sandboxEnabled || permissions.includes('same-origin')
            }
          },
          root: candidate.root,
          entry: 'index.html',
          packageRoot: root,
          development: true,
          relativePath: candidate.relativePath,
          enabled: true
        }

        return resolved
      }),
      filter?.webApps,
      autoload
    )

    const launchers: ResolvedLauncher[] = []

    for (const candidate of launcherCandidates) {
      let value: unknown

      try {
        value = JSON.parse(await fs.readFile(candidate.path, 'utf8'))
      } catch (error) {
        candidates.diagnostics.push(
          diagnostic(
            scope,
            `Could not parse launcher: ${
              error instanceof Error ? error.message : String(error)
            }`,
            {
              source,
              projectId: projectId ?? undefined,
              resourceType: 'launcher',
              path: candidate.path
            }
          )
        )
        continue
      }

      const result = decodeUnknownOrNull(createLauncherSchema, value)

      if (!result) {
        candidates.diagnostics.push(
          diagnostic(scope, 'Invalid launcher: Request validation failed', {
            source,
            projectId: projectId ?? undefined,
            resourceType: 'launcher',
            path: candidate.path
          })
        )
        continue
      }

      const resourceName = path.posix.basename(candidate.relativePath, '.json')
      launchers.push({
        definition: {
          id: `package:${parsed.packageId}:launcher:${encodeURIComponent(
            resourceName
          )}`,
          name: result.name,
          executable: result.executable,
          args: [...result.args],
          treeTitle: result.treeTitle,
          shellCommand: null,
          cwd: null,
          env: {},
          closeOnSuccess: result.closeOnSuccess,
          source: metadata
        },
        relativePath: candidate.relativePath,
        enabled: true
      })
    }

    const filteredLaunchers = applyNormalFilter(
      launchers,
      filter?.launchers,
      autoload
    )

    const duplicateIds = new Set<string>()

    for (const resource of [...webApps, ...filteredLaunchers]) {
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
      webApps,
      launchers: filteredLaunchers,
      services: manifest?.services ?? [],
      diagnostics: candidates.diagnostics
    }
  }

  private clonePackage(pkg: ResolvedPackage): ResolvedPackage {
    return {
      ...pkg,
      webApps: pkg.webApps.map((resource) => ({
        ...resource,
        definition: {
          ...resource.definition,
          source: { ...resource.definition.source }
        }
      })),
      launchers: pkg.launchers.map((resource) => ({
        ...resource,
        definition: {
          ...resource.definition,
          args: [...resource.definition.args],
          source: { ...resource.definition.source }
        }
      })),
      services: pkg.services.map((service) => ({
        ...service,
        args: [...service.args],
        query: { ...service.query }
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
    result.webApps = applyDelta(result.webApps, configured.webApps)
    result.launchers = applyDelta(result.launchers, configured.launchers)

    for (const resource of [...result.webApps, ...result.launchers]) {
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
    previous?: ResolvedPackage
  ): Promise<ResolvedPackage> {
    const settingsPath = this.settingsPath(scope, projectId ?? undefined)

    const parsed = await this.parseSource(
      sourceString(configured),
      settingsPath
    )

    try {
      const root = await this.packageRoot(parsed)

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
        root: parsed.path,
        installedPath: parsed.path,
        webApps: [],
        launchers: [],
        services: [],
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

  private reconcileGlobal(
    force = false
  ): Effect.Effect<void, never, ApplicationServices> {
    const reconcileProject = this.reconcileProject.bind(this)
    const settingsPath = this.settingsPath('global')

    return Effect.gen(
      function* (this: PackageSystem) {
        const mutations = yield* PackageMutations

        const changed = yield* mutations.enqueue(
          'global',
          Effect.promise(async () => {
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
        )

        if (changed) {
          yield* Effect.all(
            [...this.projectContexts.keys()].map((projectId) =>
              reconcileProject(projectId, true)
            ),
            { concurrency: 'unbounded', discard: true }
          )
        }
      }.bind(this)
    )
  }

  private reconcileProject(
    projectId: string,
    force = false
  ): Effect.Effect<void, never, ApplicationServices> {
    const context = this.projectContexts.get(projectId)

    if (!context) {
      return Effect.void
    }

    const settingsPath = this.settingsPath('project', projectId)

    return Effect.gen(
      function* (this: PackageSystem) {
        const mutations = yield* PackageMutations
        yield* mutations.enqueue(
          `project:${projectId}`,
          Effect.promise(async () => {
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
              [...this.globalState.packages.entries()].map(
                ([identity, pkg]) => [identity, this.clonePackage(pkg)]
              )
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
                previous?.ownPackages.get(parsed.identity)
              )

              const projectPackage =
                filter?.autoload === false
                  ? this.applyProjectDelta(
                      {
                        ...resolved,
                        webApps: resolved.webApps.map((resource) => ({
                          ...resource,
                          enabled: false
                        })),
                        launchers: resolved.launchers.map((resource) => ({
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
        )
      }.bind(this)
    )
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

  initialize(
    projects: Array<Pick<ProjectRecord, 'id' | 'name' | 'rootPath'>>
  ): Effect.Effect<void, never, ApplicationServices> {
    return Effect.gen(this, function* () {
      this.syncProjects(projects)
      yield* this.reconcileGlobal(true)
      yield* Effect.all(
        projects.map((project) => this.reconcileProject(project.id, true)),
        { concurrency: 'unbounded', discard: true }
      )
    })
  }

  registerProject(
    project: Pick<ProjectRecord, 'id' | 'name' | 'rootPath'>
  ): Effect.Effect<void, never, ApplicationServices> {
    return Effect.gen(this, function* () {
      this.syncProjects([project])
      yield* this.reconcileGlobal()
      yield* this.reconcileProject(project.id, true)
    })
  }

  forgetProject(projectId: string): void {
    this.projectContexts.delete(projectId)
    this.projectStates.delete(projectId)
    this.projectFingerprints.delete(projectId)
  }

  private ensureProject(
    projectId: string
  ): Effect.Effect<
    ProjectPackageState,
    DomainError<unknown>,
    ApplicationServices
  > {
    return Effect.gen(this, function* () {
      yield* this.reconcileGlobal()
      yield* this.reconcileProject(projectId)
      const state = this.projectStates.get(projectId)

      if (!state) {
        return yield* Effect.fail(
          new DomainError('PROJECT_NOT_FOUND', 'Project not found', 404)
        )
      }

      return state
    })
  }

  services(): Effect.Effect<
    PackageServiceDeclaration[],
    never,
    ApplicationServices
  > {
    return Effect.gen(this, function* () {
      yield* this.reconcileGlobal()
      yield* Effect.all(
        [...this.projectContexts.keys()].map((projectId) =>
          this.reconcileProject(projectId)
        ),
        { concurrency: 'unbounded', discard: true }
      )
      const declarations = new Map<string, PackageServiceDeclaration>()

      const add = (pkg: ResolvedPackage, projectId: string | null) => {
        for (const service of pkg.services) {
          const id = `${pkg.root}\0${service.name}`
          const existing = declarations.get(id)

          if (!existing) {
            declarations.set(id, {
              ...service,
              args: [...service.args],
              query: { ...service.query },
              packageId: pkg.packageId,
              root: pkg.root,
              projectIds: projectId === null ? null : [projectId]
            })
          } else if (existing.projectIds && projectId === null) {
            existing.projectIds = null
          } else if (existing.projectIds && projectId !== null) {
            existing.projectIds.push(projectId)
          }
        }
      }

      for (const pkg of this.globalState.packages.values()) {
        add(pkg, null)
      }

      for (const [projectId, state] of this.projectStates) {
        for (const pkg of state.ownPackages.values()) {
          add(pkg, projectId)
        }
      }

      return [...declarations.values()]
    })
  }

  webAppDefinitions(
    projectId: string
  ): Effect.Effect<
    ResolvedWebApp[],
    DomainError<unknown>,
    ApplicationServices
  > {
    return this.ensureProject(projectId).pipe(
      Effect.map((state) =>
        [...state.effectivePackages.values()].flatMap((pkg) =>
          pkg.webApps.filter((resource) => resource.enabled)
        )
      )
    )
  }

  launcherDefinitions(
    projectId?: string
  ): Effect.Effect<
    LauncherDefinition[],
    DomainError<unknown>,
    ApplicationServices
  > {
    return Effect.gen(this, function* () {
      yield* this.reconcileGlobal()

      const packages = projectId
        ? (yield* this.ensureProject(projectId)).effectivePackages
        : this.globalState.packages

      return [...packages.values()].flatMap((pkg) =>
        pkg.launchers
          .filter((resource) => resource.enabled)
          .map((resource) => resource.definition)
      )
    })
  }

  list(): Effect.Effect<
    {
      packages: PackageListing[]
      diagnostics: PackageResourceDiagnostic[]
    },
    never,
    ApplicationServices
  > {
    return Effect.gen(this, function* () {
      yield* this.reconcileGlobal()
      yield* Effect.all(
        [...this.projectContexts.keys()].map((projectId) =>
          this.reconcileProject(projectId)
        ),
        { concurrency: 'unbounded', discard: true }
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
            webApps: pkg.webApps.filter((resource) => resource.enabled).length,
            launchers: pkg.launchers.filter((resource) => resource.enabled)
              .length
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
              webApps: pkg.webApps.filter((resource) => resource.enabled)
                .length,
              launchers: pkg.launchers.filter((resource) => resource.enabled)
                .length
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
    })
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
    const relative = toPosix(
      path.relative(path.dirname(settingsPath), parsed.path)
    )

    if (!relative) {
      return './'
    }

    return relative.startsWith('.') ? relative : `./${relative}`
  }

  install(
    source: string,
    projectId?: string
  ): Effect.Effect<
    PackageOperationResult,
    DomainError<unknown>,
    ApplicationServices
  > {
    const scope: PackageScope = projectId ? 'project' : 'global'

    return Effect.gen(this, function* () {
      if (projectId && !this.projectContexts.has(projectId)) {
        return yield* Effect.fail(
          new DomainError('PROJECT_NOT_FOUND', 'Project not found', 404)
        )
      }

      const mutations = yield* PackageMutations

      const result = yield* mutations.enqueue(
        projectId ? `project:${projectId}` : 'global',
        packagePromise(async () => {
          const { settings, settingsPath } = await this.currentSettings(
            scope,
            projectId
          )

          const parsed = await this.parseSource(source, settingsPath)

          const root = await this.packageRoot(parsed)

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
        })
      )

      if (scope === 'global') {
        yield* this.reconcileGlobal(true)
      } else {
        yield* this.reconcileProject(projectId!, true)
      }

      return result
    })
  }

  remove(
    source: string,
    projectId?: string
  ): Effect.Effect<
    PackageOperationResult,
    DomainError<unknown>,
    ApplicationServices
  > {
    const scope: PackageScope = projectId ? 'project' : 'global'

    return Effect.gen(this, function* () {
      const mutations = yield* PackageMutations

      const result = yield* mutations.enqueue(
        projectId ? `project:${projectId}` : 'global',
        packagePromise(async () => {
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

            ;(existing.identity === parsed.identity
              ? matching
              : remaining
            ).push(configured)
          }

          if (matching.length === 0) {
            throw new DomainError(
              'PACKAGE_NOT_CONFIGURED',
              `No configured package matches ${source}`,
              404
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
        })
      )

      if (scope === 'global') {
        yield* this.reconcileGlobal(true)
      } else {
        yield* this.reconcileProject(projectId!, true)
      }

      return result
    })
  }

  reload(projectId?: string): Effect.Effect<
    {
      results: PackageOperationResult[]
      diagnostics: PackageResourceDiagnostic[]
    },
    DomainError<unknown>,
    ApplicationServices
  > {
    return Effect.gen(this, function* () {
      if (projectId) {
        yield* this.reconcileGlobal()
        yield* this.reconcileProject(projectId, true)
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

      yield* this.reconcileGlobal(true)
      yield* Effect.all(
        [...this.projectContexts.keys()].map((id) =>
          this.reconcileProject(id, true)
        ),
        { concurrency: 'unbounded', discard: true }
      )
      const listed = yield* this.list()

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
    })
  }
}
