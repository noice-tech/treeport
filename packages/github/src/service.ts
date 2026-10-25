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

// Octicons, MIT License, Copyright (c) GitHub Inc. https://primer.style/octicons
const ICONS = {
  open: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>',
  merged:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"/></svg>',
  closed:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>',
  draft:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z"/></svg>'
}

function badgeFor(pull: PullRequest): TreeBadgeInput {
  const [tone, icon, tooltip] =
    pull.state === 'MERGED'
      ? (['done', ICONS.merged, 'Pull request merged'] as const)
      : pull.state === 'CLOSED'
        ? (['danger', ICONS.closed, 'Pull request closed'] as const)
        : pull.isDraft
          ? (['neutral', ICONS.draft, 'Draft pull request'] as const)
          : (['success', ICONS.open, 'Pull request open'] as const)
  return { text: `#${pull.number}`, tone, icon, url: pull.url, tooltip }
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
