import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { DirtyState, GitDiff } from '@treeport/shared'
import type { CommandRunner } from './command'
import { ExternalCommandError, runChecked } from './command'

export interface GitWorktreeInfo {
  path: string
  gitWorktreeKey: string | null
  head: string | null
  branch: string | null
  bare: boolean
  detached: boolean
  locked: boolean
  lockReason: string | null
  prunable: boolean
}

export interface GitDirtyStatus {
  dirty: DirtyState
  fingerprint: string
}

const repositoryIdentityKey = 'treeport.repositoryId'
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

class InvalidRepositoryIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRepositoryIdentityError'
  }
}

class GitMetadataNotWritableError extends Error {
  constructor(cwd: string, details: string) {
    super(
      `Treeport could not write repository-local Git metadata for ${cwd}: ${details}`
    )
    this.name = 'GitMetadataNotWritableError'
  }
}

export function parseWorktreePorcelain(output: string): GitWorktreeInfo[] {
  const records = output
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
  return records.map((record) => {
    const values = new Map<string, string>()
    const flags = new Set<string>()
    for (const line of record.split('\n')) {
      const separator = line.indexOf(' ')
      if (separator === -1) {
        flags.add(line)
      } else {
        values.set(line.slice(0, separator), line.slice(separator + 1))
      }
    }
    const worktreePath = values.get('worktree')
    if (!worktreePath) {
      throw new Error(
        'Invalid git worktree porcelain output: missing worktree path'
      )
    }

    const ref = values.get('branch')
    return {
      path: worktreePath,
      gitWorktreeKey: null,
      head: values.get('HEAD') ?? null,
      branch: ref?.replace(/^refs\/heads\//, '') ?? null,
      bare: flags.has('bare'),
      detached: flags.has('detached') || !ref,
      locked: values.has('locked') || flags.has('locked'),
      lockReason: values.get('locked') || null,
      prunable: values.has('prunable') || flags.has('prunable')
    }
  })
}

export function detectDefaultBranch(
  symbolicRef: string,
  fallback: string
): string {
  const value = symbolicRef.trim()
  const match = /refs\/remotes\/[^/]+\/(.+)$/.exec(value)
  return match?.[1] || fallback
}

export function parseDirtyStatus(output: string): DirtyState {
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicts = 0
  const entries = output.split('\0').filter(Boolean)
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const x = entry[0]
    const y = entry[1]
    if (x === '?' && y === '?') {
      untracked += 1
      continue
    }

    if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(`${x}${y}`)) {
      conflicts += 1
    }

    if (x && x !== ' ' && x !== '?') {
      staged += 1
    }

    if (y && y !== ' ' && y !== '?') {
      unstaged += 1
    }

    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      index += 1
    }
  }
  return {
    dirty: staged + unstaged + untracked > 0,
    staged,
    unstaged,
    untracked,
    conflicts,
    total: staged + unstaged + untracked
  }
}

export class GitAdapter {
  private readonly repositoryIdentityInitializations = new Map<
    string,
    Promise<string>
  >()

  constructor(
    private readonly runner: CommandRunner,
    private readonly executable = 'git'
  ) {}

  private async checked(cwd: string, args: string[]) {
    return runChecked(this.runner, {
      executable: this.executable,
      args,
      cwd,
      timeoutMs: 30_000
    })
  }

  async findRepositoryRoot(inputPath: string): Promise<string | null> {
    const canonicalInput = await fs.realpath(path.resolve(inputPath))
    const request = {
      executable: this.executable,
      args: ['rev-parse', '--show-toplevel'],
      cwd: canonicalInput,
      timeoutMs: 30_000
    } as const
    const result = await this.runner.run(request)
    if (result.exitCode === 0) {
      return fs.realpath(result.stdout.trim())
    }

    if (/not a git repository|outside repository/iu.test(result.stderr)) {
      return null
    }

    throw new ExternalCommandError(
      `Could not inspect Git repository state: ${
        result.stderr.trim() || `Git exited with code ${result.exitCode}`
      }`,
      request,
      result
    )
  }

  async findProjectRepositoryRoot(inputPath: string): Promise<string | null> {
    const canonicalInput = await fs.realpath(path.resolve(inputPath))
    const repositoryRoot = await this.findRepositoryRoot(canonicalInput)
    if (!repositoryRoot || repositoryRoot === canonicalInput) {
      return repositoryRoot
    }

    const commits = await this.checked(repositoryRoot, [
      'rev-list',
      '--all',
      '--max-count=1'
    ])
    return commits.stdout.trim() ? repositoryRoot : null
  }

  async canonicalizeRepositoryPath(inputPath: string): Promise<string> {
    const repositoryRoot = await this.findRepositoryRoot(inputPath)
    if (repositoryRoot) {
      return repositoryRoot
    }

    const canonicalInput = await fs.realpath(path.resolve(inputPath))
    throw new Error(`Not a Git repository: ${canonicalInput}`)
  }

  private async repositoryIdentityValues(cwd: string): Promise<string[]> {
    const result = await this.runner.run({
      executable: this.executable,
      args: [
        'config',
        '--local',
        '--no-includes',
        '--get-all',
        repositoryIdentityKey
      ],
      cwd,
      timeoutMs: 30_000
    })
    if (result.exitCode === 1 && !result.stdout.trim()) {
      return []
    }

    if (result.exitCode !== 0) {
      throw new InvalidRepositoryIdentityError(
        `Could not read the local Treeport repository identity: ${
          result.stderr.trim() || `Git exited with code ${result.exitCode}`
        }`
      )
    }

    return result.stdout
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean)
  }

  async repositoryIdentity(cwd: string): Promise<string | null> {
    const values = await this.repositoryIdentityValues(cwd)
    if (values.length === 0) {
      return null
    }

    if (values.length !== 1 || !uuidPattern.test(values[0]!)) {
      throw new InvalidRepositoryIdentityError(
        values.length > 1
          ? 'The local Git config contains multiple Treeport repository identities'
          : 'The local Git config contains an invalid Treeport repository identity'
      )
    }

    return values[0]!.toLowerCase()
  }

  async ensureRepositoryIdentity(cwd: string): Promise<string> {
    const commonDirectoryResult = await this.checked(cwd, [
      'rev-parse',
      '--git-common-dir'
    ])
    const commonDirectoryValue = commonDirectoryResult.stdout.trim()
    const resolvedCommonDirectory = path.isAbsolute(commonDirectoryValue)
      ? commonDirectoryValue
      : path.resolve(cwd, commonDirectoryValue)
    const commonDirectory = await fs
      .realpath(resolvedCommonDirectory)
      .catch(() => path.resolve(resolvedCommonDirectory))
    const pending = this.repositoryIdentityInitializations.get(commonDirectory)
    if (pending) {
      return pending
    }

    const initialization = this.initializeRepositoryIdentity(cwd)
    this.repositoryIdentityInitializations.set(commonDirectory, initialization)
    try {
      return await initialization
    } finally {
      if (
        this.repositoryIdentityInitializations.get(commonDirectory) ===
        initialization
      ) {
        this.repositoryIdentityInitializations.delete(commonDirectory)
      }
    }
  }

  private async initializeRepositoryIdentity(cwd: string): Promise<string> {
    let existing: string | null = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        existing = await this.repositoryIdentity(cwd)
        break
      } catch (error) {
        if (
          !(error instanceof InvalidRepositoryIdentityError) ||
          !error.message.includes('multiple') ||
          attempt === 19
        ) {
          throw error
        }

        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }

    if (existing) {
      return existing
    }

    const generated = crypto.randomUUID()
    let write = await this.runner.run({
      executable: this.executable,
      args: ['config', '--local', '--add', repositoryIdentityKey, generated],
      cwd,
      timeoutMs: 30_000
    })
    for (
      let attempt = 0;
      write.exitCode !== 0 &&
      /could not lock config file|File exists/iu.test(write.stderr) &&
      attempt < 100;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      write = await this.runner.run({
        executable: this.executable,
        args: ['config', '--local', '--add', repositoryIdentityKey, generated],
        cwd,
        timeoutMs: 30_000
      })
    }

    if (write.exitCode !== 0) {
      const raced = await this.repositoryIdentity(cwd).catch(() => null)
      if (raced) {
        return raced
      }

      throw new GitMetadataNotWritableError(
        cwd,
        write.stderr.trim() || `Git exited with code ${write.exitCode}`
      )
    }

    const values = await this.repositoryIdentityValues(cwd)
    const valid = values.filter((value) => uuidPattern.test(value))
    if (valid.length === 0) {
      throw new InvalidRepositoryIdentityError(
        'Git did not persist a valid Treeport repository identity'
      )
    }

    const identity = valid[0]!.toLowerCase()
    if (values.length !== 1 || values[0] !== identity) {
      let cleanup = await this.runner.run({
        executable: this.executable,
        args: [
          'config',
          '--local',
          '--replace-all',
          repositoryIdentityKey,
          identity
        ],
        cwd,
        timeoutMs: 30_000
      })
      for (
        let attempt = 0;
        cleanup.exitCode !== 0 &&
        /could not lock config file|File exists/iu.test(cleanup.stderr) &&
        attempt < 100;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        cleanup = await this.runner.run({
          executable: this.executable,
          args: [
            'config',
            '--local',
            '--replace-all',
            repositoryIdentityKey,
            identity
          ],
          cwd,
          timeoutMs: 30_000
        })
      }

      if (cleanup.exitCode !== 0) {
        throw new GitMetadataNotWritableError(
          cwd,
          cleanup.stderr.trim() || `Git exited with code ${cleanup.exitCode}`
        )
      }
    }

    const persisted = await this.repositoryIdentity(cwd)
    if (persisted !== identity) {
      throw new InvalidRepositoryIdentityError(
        'The local Treeport repository identity changed while it was initialized'
      )
    }

    return persisted
  }

  async listWorktrees(cwd: string): Promise<GitWorktreeInfo[]> {
    const [result, commonDirectoryResult] = await Promise.all([
      this.checked(cwd, ['worktree', 'list', '--porcelain']),
      this.checked(cwd, ['rev-parse', '--git-common-dir'])
    ])
    const commonDirectoryValue = commonDirectoryResult.stdout.trim()
    const resolvedCommonDirectory = path.isAbsolute(commonDirectoryValue)
      ? commonDirectoryValue
      : path.resolve(cwd, commonDirectoryValue)
    const commonDirectory = await fs
      .realpath(resolvedCommonDirectory)
      .catch(() => path.resolve(resolvedCommonDirectory))
    const parsed = parseWorktreePorcelain(result.stdout)
    return Promise.all(
      parsed.map(async (item) => {
        const worktreePath = await fs
          .realpath(item.path)
          .catch(() => path.resolve(item.path))
        if (item.prunable) {
          return { ...item, path: worktreePath }
        }

        const gitDirectory = await this.checked(worktreePath, [
          'rev-parse',
          '--absolute-git-dir'
        ])
        const gitDirectoryValue = gitDirectory.stdout.trim()
        const canonicalGitDirectory = await fs
          .realpath(gitDirectoryValue)
          .catch(() => path.resolve(gitDirectoryValue))
        const relative = path.relative(commonDirectory, canonicalGitDirectory)
        let gitWorktreeKey: string
        if (relative === '') {
          gitWorktreeKey = 'main'
        } else {
          const segments = relative.split(path.sep)
          if (
            segments.length !== 2 ||
            segments[0] !== 'worktrees' ||
            !segments[1]
          ) {
            throw new Error(
              `Invalid Git worktree administrative path: ${canonicalGitDirectory}`
            )
          }

          gitWorktreeKey = `worktrees/${segments[1]}`
        }

        return {
          ...item,
          path: worktreePath,
          gitWorktreeKey
        }
      })
    )
  }

  async repairWorktrees(cwd: string): Promise<void> {
    await this.checked(cwd, ['worktree', 'repair'])
  }

  async resolveMainCheckout(cwd: string): Promise<string> {
    const result = await this.checked(cwd, ['worktree', 'list', '--porcelain'])
    const main = parseWorktreePorcelain(result.stdout)[0]
    if (!main || main.bare) {
      throw new Error('A non-bare main Git checkout is required')
    }

    return fs.realpath(main.path)
  }

  async currentBranch(cwd: string): Promise<string> {
    const result = await this.checked(cwd, ['branch', '--show-current'])
    return result.stdout.trim() || '(detached)'
  }

  async remoteDefaultBranch(cwd: string): Promise<string | null> {
    const remote = await this.runner.run({
      executable: this.executable,
      args: ['ls-remote', '--symref', 'origin', 'HEAD'],
      cwd,
      timeoutMs: 30_000
    })
    if (remote.exitCode !== 0) {
      return null
    }

    const match = /^ref:\s+refs\/heads\/(.+?)\s+HEAD$/m.exec(remote.stdout)
    return match?.[1] ?? null
  }

  async defaultBranch(cwd: string): Promise<string> {
    const remote = await this.remoteDefaultBranch(cwd)
    if (remote) {
      return remote
    }

    const symbolic = await this.runner.run({
      executable: this.executable,
      args: ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
      cwd,
      timeoutMs: 10_000
    })
    if (symbolic.exitCode === 0) {
      return detectDefaultBranch(symbolic.stdout, '')
    }

    const configured = await this.runner.run({
      executable: this.executable,
      args: ['config', '--get', 'init.defaultBranch'],
      cwd,
      timeoutMs: 10_000
    })
    if (configured.exitCode === 0 && configured.stdout.trim()) {
      return configured.stdout.trim()
    }

    return this.currentBranch(cwd)
  }

  async resolveCommit(cwd: string, ref = 'HEAD'): Promise<string> {
    const result = await this.checked(cwd, [
      'rev-parse',
      '--verify',
      `${ref}^{commit}`
    ])
    const commit = result.stdout.trim()
    if (!commit) {
      throw new Error(`Git did not resolve ${ref} to a commit`)
    }

    return commit
  }

  async resolveDefaultCommit(cwd: string): Promise<string> {
    const defaultBranch = await this.defaultBranch(cwd)
    const fetched = await this.runner.run({
      executable: this.executable,
      args: ['fetch', '--quiet', 'origin', defaultBranch],
      cwd,
      timeoutMs: 60_000
    })
    if (fetched.exitCode === 0) {
      return this.resolveCommit(cwd, `origin/${defaultBranch}`)
    }

    return this.resolveCommit(cwd, defaultBranch)
  }

  async createDetachedWorktree(
    cwd: string,
    worktreePath: string,
    commit: string
  ): Promise<void> {
    await runChecked(this.runner, {
      executable: this.executable,
      args: ['worktree', 'add', '--detach', '--', worktreePath, commit],
      cwd,
      timeoutMs: 10 * 60_000
    })
  }

  async pruneWorktrees(cwd: string): Promise<void> {
    await runChecked(this.runner, {
      executable: this.executable,
      args: ['worktree', 'prune', '--expire', 'now'],
      cwd,
      timeoutMs: 10 * 60_000
    })
  }

  async removeWorktree(
    cwd: string,
    worktreePath: string,
    force: boolean
  ): Promise<void> {
    const args = ['worktree', 'remove']
    if (force) {
      args.push('--force')
    }

    args.push('--', worktreePath)
    await runChecked(this.runner, {
      executable: this.executable,
      args,
      cwd,
      timeoutMs: 10 * 60_000
    })
  }

  async isCommitReachable(
    cwd: string,
    commit: string
  ): Promise<boolean | null> {
    const result = await this.runner.run({
      executable: this.executable,
      args: [
        'for-each-ref',
        '--contains',
        commit,
        '--format=%(refname)',
        'refs/heads',
        'refs/tags',
        'refs/remotes'
      ],
      cwd,
      timeoutMs: 30_000
    })
    if (result.exitCode !== 0) {
      return null
    }

    return Boolean(result.stdout.trim())
  }

  async dirtyStatus(cwd: string): Promise<GitDirtyStatus> {
    const result = await this.checked(cwd, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all'
    ])
    return {
      dirty: parseDirtyStatus(result.stdout),
      fingerprint: crypto
        .createHash('sha256')
        .update(result.stdout)
        .digest('hex')
    }
  }

  async dirtyState(cwd: string): Promise<DirtyState> {
    return (await this.dirtyStatus(cwd)).dirty
  }

  async worktreeDiff(cwd: string, defaultBranch: string): Promise<GitDiff> {
    const candidates = [`origin/${defaultBranch}`, defaultBranch]
    let baseRef = ''
    for (const candidate of candidates) {
      const resolved = await this.runner.run({
        executable: this.executable,
        args: ['rev-parse', '--verify', `${candidate}^{commit}`],
        cwd,
        timeoutMs: 10_000
      })
      if (resolved.exitCode === 0) {
        baseRef = candidate
        break
      }
    }
    if (!baseRef) {
      throw new Error(`Default branch ${defaultBranch} is unavailable locally`)
    }

    const mergeBase = await this.checked(cwd, ['merge-base', baseRef, 'HEAD'])
    const baseCommit = mergeBase.stdout.trim()
    const headCommit = await this.resolveCommit(cwd)
    const [diff, branch, staged, unstaged, untracked] = await Promise.all([
      this.checked(cwd, [
        'diff',
        '--no-ext-diff',
        '--binary',
        '--find-renames',
        baseCommit
      ]),
      this.checked(cwd, [
        'diff',
        '--no-ext-diff',
        '--name-only',
        '-z',
        '--find-renames',
        baseCommit,
        headCommit
      ]),
      this.checked(cwd, [
        'diff',
        '--no-ext-diff',
        '--cached',
        '--name-only',
        '-z',
        '--find-renames',
        headCommit
      ]),
      this.checked(cwd, [
        'diff',
        '--no-ext-diff',
        '--name-only',
        '-z',
        '--find-renames'
      ]),
      this.checked(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
    ])
    const paths = (output: string) =>
      [...new Set(output.split('\0').filter(Boolean))].sort()
    const untrackedPaths = paths(untracked.stdout)
    let unified = diff.stdout
    for (const file of untrackedPaths) {
      const addition = await this.runner.run({
        executable: this.executable,
        args: ['diff', '--no-index', '--binary', '--', '/dev/null', file],
        cwd,
        timeoutMs: 30_000
      })
      if (addition.exitCode !== 0 && addition.exitCode !== 1) {
        throw new Error(addition.stderr.trim() || `Could not diff ${file}`)
      }

      unified += addition.stdout
    }

    return {
      baseRef,
      baseCommit,
      headCommit,
      generatedAt: new Date().toISOString(),
      unified,
      changeSets: {
        branch: paths(branch.stdout),
        staged: paths(staged.stdout),
        unstaged: paths(unstaged.stdout),
        untracked: untrackedPaths
      }
    }
  }

  async isMerged(cwd: string, branch: string): Promise<boolean> {
    const remoteDefaultBranch = await this.remoteDefaultBranch(cwd)
    if (!remoteDefaultBranch) {
      return false
    }

    const fetch = await this.runner.run({
      executable: this.executable,
      args: ['fetch', '--quiet', 'origin', remoteDefaultBranch],
      cwd,
      timeoutMs: 60_000
    })
    if (fetch.exitCode !== 0) {
      return false
    }

    const merged = await this.runner.run({
      executable: this.executable,
      args: [
        'merge-base',
        '--is-ancestor',
        branch,
        `origin/${remoteDefaultBranch}`
      ],
      cwd,
      timeoutMs: 15_000
    })
    return merged.exitCode === 0
  }

  async commitSummary(
    cwd: string,
    branch: string,
    defaultBranch: string
  ): Promise<{ ahead: number; behind: number } | null> {
    const result = await this.runner.run({
      executable: this.executable,
      args: [
        'rev-list',
        '--left-right',
        '--count',
        `${defaultBranch}...${branch}`
      ],
      cwd,
      timeoutMs: 15_000
    })
    if (result.exitCode !== 0) {
      return null
    }

    const [behind = '0', ahead = '0'] = result.stdout.trim().split(/\s+/)
    return {
      ahead: Number.parseInt(ahead, 10),
      behind: Number.parseInt(behind, 10)
    }
  }
}
