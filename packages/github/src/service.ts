import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type {
  TreeDecorationInput,
  TreeportProject,
  TreeportTree
} from '@treeport/app-sdk'
import { treeport } from '@treeport/app-sdk/service'
import { z } from 'zod'

const POLL_MS = 15_000

const RATE_LIMIT_RESERVE = 500
const PULL_REQUEST_KEY = 'pr'
const CHECKS_KEY = 'ci'

const pullRequestSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  merged_at: z.string().nullable(),
  html_url: z.url(),
  head: z.object({ sha: z.string() })
})

const checkRunsSchema = z.object({
  check_runs: z.array(z.object({ conclusion: z.string().nullable() }))
})

const statusSchema = z.object({ state: z.string() })

type PullRequest = z.infer<typeof pullRequestSchema>

interface Repository {
  host: string
  owner: string
  name: string
}

function parseRemote(url: string): Repository | null {
  const match =
    /^(?:https:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(
      url
    )

  return match ? { host: match[1]!, owner: match[2]!, name: match[3]! } : null
}

const tokens = new Map<string, Promise<string | null>>()

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

// EXTERNAL: Conditional requests answered with 304 do not count against the rate limit.
const responses = new Map<string, { etag: string; body: unknown }>()
let pausedUntil = 0

async function github<Body extends z.ZodType>(
  repository: Repository,
  credential: string,
  pathname: string,
  schema: Body
): Promise<z.infer<Body>> {
  const url =
    repository.host === 'github.com'
      ? `https://api.github.com/repos/${repository.owner}/${repository.name}${pathname}`
      : `https://${repository.host}/api/v3/repos/${repository.owner}/${repository.name}${pathname}`

  const cached = responses.get(url)

  const headers = new Headers({
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${credential}`,
    'x-github-api-version': '2022-11-28'
  })

  if (cached) {
    headers.set('if-none-match', cached.etag)
  }

  const response = await fetch(url, { headers })

  if (response.status === 401) {
    tokens.delete(repository.host)
  }

  if (response.status === 304 && cached) {
    return schema.parse(cached.body)
  }

  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} for ${pathname}`)
  }

  // EXTERNAL: GitHub Enterprise Server may run without rate limits and omit these.
  const remaining = response.headers.get('x-ratelimit-remaining')

  if (remaining !== null && Number(remaining) < RATE_LIMIT_RESERVE) {
    pausedUntil = Number(response.headers.get('x-ratelimit-reset')) * 1_000
    console.error(
      `GitHub rate limit is low; pausing until ${new Date(pausedUntil).toISOString()}`
    )
  }

  const body: unknown = await response.json()
  const etag = response.headers.get('etag')

  if (etag) {
    responses.delete(url)
    responses.set(url, { etag, body })

    if (responses.size > 1_000) {
      responses.delete(responses.keys().next().value!)
    }
  }

  return schema.parse(body)
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

function decorationFor(pull: PullRequest): TreeDecorationInput {
  const [tone, icon] = pull.merged_at
    ? (['done', ICONS.merged] as const)
    : pull.state === 'closed'
      ? (['danger', ICONS.closed] as const)
      : pull.draft
        ? (['neutral', ICONS.draft] as const)
        : (['success', ICONS.open] as const)

  return {
    text: `#${pull.number}`,
    title: pull.title.slice(0, 240),
    tone,
    icon,
    url: pull.html_url
  }
}

const { packageId } = await treeport.self()

const mergedBranches = new Map<string, string>()

async function refreshProject(project: TreeportProject): Promise<void> {
  const defaultBranch = project.git?.defaultBranch

  const trees = project.worktrees.filter(
    (tree) => tree.git?.branch && tree.git.branch !== defaultBranch
  )

  const clear = async (tree: TreeportTree, key: string) => {
    if (
      tree.decorations.some(
        (decoration) =>
          decoration.key === key && decoration.source === packageId
      )
    ) {
      await treeport.decorations.clear(tree.id, key)
    }
  }

  for (const tree of project.worktrees) {
    if (!trees.includes(tree)) {
      await clear(tree, PULL_REQUEST_KEY)
      await clear(tree, CHECKS_KEY)
    }
  }

  const originUrl = project.git?.originUrl
  const repository = originUrl ? parseRemote(originUrl) : null
  const credential = repository ? await token(repository.host) : null

  if (!repository || !credential) {
    return
  }

  for (const tree of trees) {
    const branch = tree.git!.branch!

    if (mergedBranches.get(tree.id) === branch) {
      continue
    }

    const [pull = null] = await github(
      repository,
      credential,
      `/pulls?state=all&per_page=1&head=${encodeURIComponent(`${repository.owner}:${branch}`)}`,
      z.array(pullRequestSchema)
    )

    if (pull) {
      await treeport.decorations.set(
        tree.id,
        PULL_REQUEST_KEY,
        decorationFor(pull)
      )
    } else {
      await clear(tree, PULL_REQUEST_KEY)
    }

    const open = pull?.state === 'open'

    const [checkRuns, status] = open
      ? await Promise.all([
          github(
            repository,
            credential,
            `/commits/${pull.head.sha}/check-runs?per_page=100`,
            checkRunsSchema
          ),
          github(
            repository,
            credential,
            `/commits/${pull.head.sha}/status`,
            statusSchema
          )
        ])
      : [null, null]

    if (
      open &&
      (status?.state === 'failure' ||
        status?.state === 'error' ||
        checkRuns?.check_runs.some((run) =>
          ['failure', 'timed_out', 'startup_failure'].includes(
            run.conclusion ?? ''
          )
        ))
    ) {
      await treeport.decorations.set(tree.id, CHECKS_KEY, {
        text: 'CI',
        title: `Checks failing on #${pull.number}`,
        tone: 'danger',
        url: `${pull.html_url}/checks`
      })
    } else {
      await clear(tree, CHECKS_KEY)
    }

    if (pull?.merged_at) {
      mergedBranches.set(tree.id, branch)
    }
  }
}

let pending: Set<string> | null = new Set()
let wake = () => {}

const refresh = (projectId: string | null) => {
  pending = projectId && pending ? pending.add(projectId) : null
  wake()
}

setInterval(() => refresh(null), POLL_MS)

void (async () => {
  for await (const event of treeport.events()) {
    refresh(event.type === 'resync' ? null : event.projectId)
  }
})()

refresh(null)

while (true) {
  if (pending?.size === 0) {
    await new Promise<void>((resolve) => {
      wake = resolve
    })
  }

  if (Date.now() < pausedUntil) {
    await delay(pausedUntil - Date.now())
  }

  const due = pending
  pending = new Set()

  const projects = await treeport.projects().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))

    return []
  })

  for (const project of projects) {
    if (
      project.availability.state === 'available' &&
      (!due || due.has(project.id))
    ) {
      await refreshProject(project).catch((error) => {
        console.error(
          `${project.name}: ${error instanceof Error ? error.message : String(error)}`
        )
      })
    }
  }
}
