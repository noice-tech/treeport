import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { TreeBadgeInput, TreeportProject } from '@treeport/app-sdk'
import { treeport } from '@treeport/app-sdk/service'
import { z } from 'zod'

const INTERVAL_MS = 60_000
// Leave headroom for the user's own GitHub usage.
const RATE_LIMIT_RESERVE = 500
const BADGE_KEY = 'pr'

const pullRequestSchema = z.object({
  number: z.number().int(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  url: z.url()
})
const rateLimitSchema = z.object({
  remaining: z.number().int(),
  resetAt: z.iso.datetime()
})
const pullRequestsResponseSchema = z.object({
  data: z
    .object({
      rateLimit: rateLimitSchema,
      repository: z
        .record(z.string(), z.object({ nodes: z.array(pullRequestSchema) }))
        .nullable()
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional()
})

type PullRequest = z.infer<typeof pullRequestSchema>
type RateLimit = z.infer<typeof rateLimitSchema>

interface Repository {
  host: string
  owner: string
  name: string
}

/** Parse remotes such as git@github.com:owner/name.git or https://host/owner/name. */
function parseRemote(url: string): Repository | null {
  const match =
    /^(?:https:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(
      url
    )
  return match ? { host: match[1]!, owner: match[2]!, name: match[3]! } : null
}

const tokens = new Map<string, Promise<string | null>>()

/** Borrow the user's GitHub login: GITHUB_TOKEN, else the gh CLI's stored token. */
function token(host: string): Promise<string | null> {
  const environment =
    host === 'github.com'
      ? (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN)
      : undefined
  if (environment) {
    return Promise.resolve(environment)
  }

  let pending = tokens.get(host)
  if (!pending) {
    pending = promisify(execFile)('gh', ['auth', 'token', '--hostname', host], {
      timeout: 10_000
    }).then(
      ({ stdout }) => stdout.trim() || null,
      () => {
        console.error(`No GitHub login for ${host}; run \`gh auth login\``)
        return null
      }
    )
    tokens.set(host, pending)
  }

  return pending
}

/** Look up every branch's latest pull request in one GraphQL request. */
async function pullRequests(
  repository: Repository,
  credential: string,
  branches: string[]
): Promise<{ rateLimit: RateLimit; pulls: (PullRequest | null)[] }> {
  const variables = branches.map((_, index) => `$b${index}: String!`)
  const aliases = branches.map(
    (_, index) =>
      `b${index}: pullRequests(headRefName: $b${index}, first: 1, orderBy: {field: CREATED_AT, direction: DESC}, states: [OPEN, MERGED, CLOSED]) { nodes { number state isDraft url } }`
  )
  const response = await fetch(
    repository.host === 'github.com'
      ? 'https://api.github.com/graphql'
      : `https://${repository.host}/api/graphql`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        query: `query($owner: String!, $name: String!, ${variables.join(', ')}) {
          rateLimit { remaining resetAt }
          repository(owner: $owner, name: $name) { ${aliases.join('\n')} }
        }`,
        variables: Object.fromEntries([
          ['owner', repository.owner],
          ['name', repository.name],
          ...branches.map((branch, index) => [`b${index}`, branch])
        ])
      })
    }
  )
  if (response.status === 401) {
    // The stored login may have been refreshed; read it again next time.
    tokens.delete(repository.host)
  }

  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status}`)
  }

  const { data, errors } = pullRequestsResponseSchema.parse(
    await response.json()
  )
  if (!data?.repository) {
    throw new Error(
      errors?.map((error) => error.message).join('; ') ??
        `${repository.owner}/${repository.name} was not found`
    )
  }

  const pulls = data.repository
  return {
    rateLimit: data.rateLimit,
    pulls: branches.map((_, index) => pulls[`b${index}`]?.nodes[0] ?? null)
  }
}

function badgeFor(pull: PullRequest): TreeBadgeInput {
  const [tone, tooltip] =
    pull.state === 'MERGED'
      ? (['done', 'Pull request merged'] as const)
      : pull.state === 'CLOSED'
        ? (['danger', 'Pull request closed'] as const)
        : pull.isDraft
          ? (['neutral', 'Draft pull request'] as const)
          : (['info', 'Pull request open'] as const)
  return { text: `#${pull.number}`, tone, url: pull.url, tooltip }
}

const { packageId } = await treeport.self()
// A merged pull request cannot change, so its tree is not queried again.
const mergedBranches = new Map<string, string>()

async function refreshProject(
  project: TreeportProject
): Promise<RateLimit | null> {
  const trees = project.worktrees.filter(
    (tree) => tree.branch !== null && tree.branch !== project.defaultBranch
  )
  for (const tree of project.worktrees) {
    if (
      !trees.includes(tree) &&
      tree.badges.some(
        (badge) => badge.key === BADGE_KEY && badge.source === packageId
      )
    ) {
      await treeport.badges.clear(tree.id, BADGE_KEY)
    }
  }

  const pending = trees.filter(
    (tree) => mergedBranches.get(tree.id) !== tree.branch
  )
  const repository = project.originUrl ? parseRemote(project.originUrl) : null
  const credential = repository ? await token(repository.host) : null
  if (!pending.length || !repository || !credential) {
    return null
  }

  const { rateLimit, pulls } = await pullRequests(
    repository,
    credential,
    pending.map((tree) => tree.branch!)
  )
  for (const [index, tree] of pending.entries()) {
    const pull = pulls[index] ?? null
    if (pull) {
      await treeport.badges.set(tree.id, BADGE_KEY, badgeFor(pull))
    } else {
      await treeport.badges.clear(tree.id, BADGE_KEY)
    }

    if (pull?.state === 'MERGED') {
      mergedBranches.set(tree.id, tree.branch!)
    }
  }

  return rateLimit
}

while (true) {
  let wait = INTERVAL_MS
  const projects = await treeport.projects().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    return []
  })
  for (const project of projects) {
    if (
      project.kind !== 'repository' ||
      project.availability.state !== 'available'
    ) {
      continue
    }

    const rateLimit = await refreshProject(project).catch((error) => {
      console.error(
        `${project.name}: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    })
    if (rateLimit && rateLimit.remaining < RATE_LIMIT_RESERVE) {
      wait = Math.max(wait, Date.parse(rateLimit.resetAt) - Date.now())
      console.error(
        `GitHub rate limit is low; pausing until ${rateLimit.resetAt}`
      )
      break
    }
  }

  await delay(wait)
}
