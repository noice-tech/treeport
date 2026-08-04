import { parseComputerUrl } from './renderer-url'

export interface WorkspaceTarget {
  origin: string
  url: string
}

function decodedRoutePart(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value)
    return decoded && !decoded.includes('/') ? decoded : null
  } catch {
    return null
  }
}

export function parseWorkspaceLink(value: unknown): WorkspaceTarget | null {
  if (typeof value !== 'string' || !URL.canParse(value)) {
    return null
  }

  const link = new URL(value)
  const targets = link.searchParams.getAll('url')
  if (
    link.protocol !== 'treeport:' ||
    link.hostname !== 'open' ||
    link.port ||
    link.username ||
    link.password ||
    link.pathname ||
    link.hash ||
    targets.length !== 1 ||
    [...link.searchParams.keys()].some((key) => key !== 'url')
  ) {
    return null
  }

  const targetValue = targets[0]!
  if (!URL.canParse(targetValue)) {
    return null
  }

  const target = new URL(targetValue)
  if (target.search || target.hash || target.username || target.password) {
    return null
  }

  let origin: string
  try {
    origin = parseComputerUrl(target.href).origin
  } catch {
    return null
  }

  const parts = target.pathname.split('/')
  if (
    parts.length !== 5 ||
    parts[0] !== '' ||
    parts[1] !== 'projects' ||
    parts[3] !== 'worktrees' ||
    !decodedRoutePart(parts[2]!) ||
    !decodedRoutePart(parts[4]!)
  ) {
    return null
  }

  return { origin, url: target.href }
}
