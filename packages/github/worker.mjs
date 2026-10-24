import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)
const apiUrl = process.env.TREEPORT_API_URL
const token = process.env.TREEPORT_PACKAGE_TOKEN
if (!apiUrl || !token) {
  console.error(
    'Treeport starts this worker; run `treeport install @treeport/github`.'
  )
  process.exit(1)
}

const INTERVAL_MS = 60_000
const REPOSITORY_RETRY_MS = 10 * 60_000
// Leave headroom for the user's own gh and GitHub usage.
const RATE_LIMIT_RESERVE = 500
const BADGE_KEY = 'pr'
// A merged pull request cannot change, so its tree is not queried again.
const mergedBranches = new Map()
const repositories = new Map()

async function api(method, pathname, body) {
  const response = await fetch(new URL(pathname, apiUrl), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  if (!response.ok) {
    throw new Error(
      `${method} ${pathname}: ${response.status} ${await response.text()}`
    )
  }

  return response.json()
}

async function repository(project) {
  const cached = repositories.get(project.rootPath)
  if (cached && (cached.name || Date.now() < cached.retryAt)) {
    return cached.name
  }

  const name = await run(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    { cwd: project.rootPath, timeout: 30_000 }
  ).then(
    ({ stdout }) => stdout.trim() || null,
    (error) => {
      console.error(
        `${project.name}: no GitHub repository (${error.message.trim()})`
      )
      return null
    }
  )
  repositories.set(project.rootPath, {
    name,
    retryAt: Date.now() + REPOSITORY_RETRY_MS
  })
  return name
}

/** Look up every branch's latest pull request in one GraphQL request. */
async function pullRequests(project, nameWithOwner, branches) {
  const [owner, name] = nameWithOwner.split('/')
  const variables = branches.map((_, index) => `$b${index}: String!`).join(', ')
  const aliases = branches
    .map(
      (_, index) =>
        `b${index}: pullRequests(headRefName: $b${index}, first: 1, orderBy: {field: CREATED_AT, direction: DESC}, states: [OPEN, MERGED, CLOSED]) { nodes { number state isDraft url } }`
    )
    .join('\n')
  const query = `query($owner: String!, $name: String!, ${variables}) {
    rateLimit { remaining resetAt }
    repository(owner: $owner, name: $name) { ${aliases} }
  }`
  const { stdout } = await run(
    'gh',
    [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      ...branches.flatMap((branch, index) => ['-f', `b${index}=${branch}`])
    ],
    { cwd: project.rootPath, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }
  )
  const { data } = JSON.parse(stdout)
  return {
    rateLimit: data.rateLimit,
    pulls: branches.map(
      (_, index) => data.repository[`b${index}`].nodes[0] ?? null
    )
  }
}

function badgeFor(pull) {
  if (!pull) {
    return null
  }

  const [tone, tooltip] =
    pull.state === 'MERGED'
      ? ['done', 'Pull request merged']
      : pull.state === 'CLOSED'
        ? ['danger', 'Pull request closed']
        : pull.isDraft
          ? ['neutral', 'Draft pull request']
          : ['info', 'Pull request open']
  return { text: `#${pull.number}`, tone, url: pull.url, tooltip }
}

async function publish(self, tree, badge) {
  const path = `/api/worktrees/${encodeURIComponent(tree.id)}/badges/${BADGE_KEY}`
  if (badge) {
    await api('PUT', path, badge)
  } else if (
    tree.badges.some(
      (entry) => entry.key === BADGE_KEY && entry.source === self.packageId
    )
  ) {
    await api('DELETE', path)
  }
}

async function refreshProject(self, project) {
  const trees = project.worktrees.filter(
    (tree) => tree.branch && tree.branch !== project.defaultBranch
  )
  for (const tree of project.worktrees) {
    if (!trees.includes(tree)) {
      await publish(self, tree, null)
    }
  }

  const pending = trees.filter(
    (tree) => mergedBranches.get(tree.id) !== tree.branch
  )
  const nameWithOwner = pending.length ? await repository(project) : null
  if (!nameWithOwner) {
    return null
  }

  const { rateLimit, pulls } = await pullRequests(
    project,
    nameWithOwner,
    pending.map((tree) => tree.branch)
  )
  for (const [index, tree] of pending.entries()) {
    const pull = pulls[index]
    await publish(self, tree, badgeFor(pull))
    if (pull?.state === 'MERGED') {
      mergedBranches.set(tree.id, tree.branch)
    }
  }

  return rateLimit
}

while (true) {
  let wait = INTERVAL_MS
  await (async () => {
    const self = await api('GET', '/api/package-workers/self')
    const { projects } = await api('GET', '/api/projects')
    for (const project of projects) {
      if (
        project.kind !== 'repository' ||
        project.availability.state !== 'available' ||
        (self.projectIds && !self.projectIds.includes(project.id))
      ) {
        continue
      }

      const rateLimit = await refreshProject(self, project).catch((error) => {
        console.error(`${project.name}: ${error.message}`)
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
  })().catch((error) => console.error(error.message))
  await delay(wait)
}
