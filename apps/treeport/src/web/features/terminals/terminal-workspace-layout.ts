import { z } from 'zod'

export type TerminalSplitDirection = 'left' | 'right' | 'up' | 'down'

export type TerminalWorkspaceLayoutNode =
  | {
      type: 'terminal'
      terminalId: string
    }
  | {
      type: 'split'
      orientation: 'horizontal' | 'vertical'
      ratio: number
      first: TerminalWorkspaceLayoutNode
      second: TerminalWorkspaceLayoutNode
    }

export interface TerminalWorkspaceLayout {
  readonly groups: readonly TerminalWorkspaceLayoutNode[]
}

const DEFAULT_RATIO = 50
const LAYOUT_STORAGE_PREFIX = 'treeport-terminal-workspace-v1:'
const MAX_TERMINALS = 64

const terminalWorkspaceLayoutNodeSchema: z.ZodType<TerminalWorkspaceLayoutNode> =
  z.lazy(() =>
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal('terminal'),
        terminalId: z.string().min(1).max(128)
      }),
      z.object({
        type: z.literal('split'),
        orientation: z.enum(['horizontal', 'vertical']),
        ratio: z.number().int().min(20).max(80),
        first: terminalWorkspaceLayoutNodeSchema,
        second: terminalWorkspaceLayoutNodeSchema
      })
    ])
  )
const terminalWorkspaceLayoutSchema = z
  .object({
    groups: z.array(terminalWorkspaceLayoutNodeSchema).max(MAX_TERMINALS)
  })
  .refine(({ groups }) => {
    const terminalIds = groups.flatMap(terminalIdsInLayoutNode)
    return (
      terminalIds.length <= MAX_TERMINALS &&
      terminalIds.length === new Set(terminalIds).size
    )
  })

function parseStoredLayout(value: string): TerminalWorkspaceLayout | null {
  try {
    const result = terminalWorkspaceLayoutSchema.safeParse(JSON.parse(value))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

class TerminalWorkspaceLayoutStore {
  private readonly layouts = new Map<string, TerminalWorkspaceLayout | null>()
  private readonly listeners = new Set<() => void>()
  private revision = 0

  constructor() {
    window.addEventListener('storage', (event) => {
      if (event.key === null) {
        this.layouts.clear()
      } else if (event.key.startsWith(LAYOUT_STORAGE_PREFIX)) {
        this.layouts.delete(event.key.slice(LAYOUT_STORAGE_PREFIX.length))
      } else {
        return
      }

      this.emit()
    })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): number => this.revision

  read(worktreeId: string): TerminalWorkspaceLayout | null {
    if (this.layouts.has(worktreeId)) {
      return this.layouts.get(worktreeId) ?? null
    }

    let layout: TerminalWorkspaceLayout | null = null
    try {
      const stored = localStorage.getItem(
        `${LAYOUT_STORAGE_PREFIX}${worktreeId}`
      )
      layout = stored ? parseStoredLayout(stored) : null
    } catch {
      // Keep the layout in memory when storage is unavailable.
    }

    this.layouts.set(worktreeId, layout)
    return layout
  }

  update(
    worktreeId: string,
    availableTerminalIds: readonly string[],
    transform: (layout: TerminalWorkspaceLayout) => TerminalWorkspaceLayout
  ): void {
    const current = normalizeTerminalWorkspaceLayout(
      this.read(worktreeId),
      availableTerminalIds
    )
    this.write(worktreeId, transform(current))
  }

  write(worktreeId: string, layout: TerminalWorkspaceLayout): void {
    const serialized = JSON.stringify(layout)
    if (JSON.stringify(this.read(worktreeId)) === serialized) {
      return
    }

    this.layouts.set(worktreeId, layout)
    try {
      localStorage.setItem(`${LAYOUT_STORAGE_PREFIX}${worktreeId}`, serialized)
    } catch {
      // The in-memory layout remains usable when storage is unavailable.
    }
    this.emit()
  }

  private emit(): void {
    this.revision += 1
    for (const listener of this.listeners) {
      listener()
    }
  }
}

export const terminalWorkspaceLayouts = new TerminalWorkspaceLayoutStore()

export function terminalIdsInLayoutNode(
  node: TerminalWorkspaceLayoutNode
): string[] {
  return node.type === 'terminal'
    ? [node.terminalId]
    : [
        ...terminalIdsInLayoutNode(node.first),
        ...terminalIdsInLayoutNode(node.second)
      ]
}

export function normalizeTerminalWorkspaceLayout(
  layout: TerminalWorkspaceLayout | null,
  availableTerminalIds: readonly string[]
): TerminalWorkspaceLayout {
  const available = new Set(availableTerminalIds)
  const seen = new Set<string>()
  const normalizeNode = (
    node: TerminalWorkspaceLayoutNode
  ): TerminalWorkspaceLayoutNode | null => {
    if (node.type === 'terminal') {
      if (!available.has(node.terminalId) || seen.has(node.terminalId)) {
        return null
      }

      seen.add(node.terminalId)
      return node
    }

    const first = normalizeNode(node.first)
    const second = normalizeNode(node.second)
    return first && second ? { ...node, first, second } : (first ?? second)
  }

  const groups = (layout?.groups ?? [])
    .map(normalizeNode)
    .filter((group): group is TerminalWorkspaceLayoutNode => group !== null)
  for (const terminalId of availableTerminalIds) {
    if (!seen.has(terminalId)) {
      groups.push({ type: 'terminal', terminalId })
    }
  }

  return { groups }
}

function removeTerminalFromNode(
  node: TerminalWorkspaceLayoutNode,
  terminalId: string
): TerminalWorkspaceLayoutNode | null {
  if (node.type === 'terminal') {
    return node.terminalId === terminalId ? null : node
  }

  const first = removeTerminalFromNode(node.first, terminalId)
  const second = removeTerminalFromNode(node.second, terminalId)
  return first && second ? { ...node, first, second } : (first ?? second)
}

function insertTerminalAtTarget(
  node: TerminalWorkspaceLayoutNode,
  targetTerminalId: string,
  terminalId: string,
  direction: TerminalSplitDirection
): TerminalWorkspaceLayoutNode {
  if (node.type === 'terminal') {
    if (node.terminalId !== targetTerminalId) {
      return node
    }

    const terminal: TerminalWorkspaceLayoutNode = {
      type: 'terminal',
      terminalId
    }
    const orientation =
      direction === 'left' || direction === 'right' ? 'vertical' : 'horizontal'
    const before = direction === 'left' || direction === 'up'
    return {
      type: 'split',
      orientation,
      ratio: DEFAULT_RATIO,
      first: before ? terminal : node,
      second: before ? node : terminal
    }
  }

  return {
    ...node,
    first: insertTerminalAtTarget(
      node.first,
      targetTerminalId,
      terminalId,
      direction
    ),
    second: insertTerminalAtTarget(
      node.second,
      targetTerminalId,
      terminalId,
      direction
    )
  }
}

export function disconnectTerminalFromLayout(
  layout: TerminalWorkspaceLayout,
  terminalId: string
): TerminalWorkspaceLayout {
  const groupIndex = layout.groups.findIndex((group) =>
    terminalIdsInLayoutNode(group).includes(terminalId)
  )
  const group = layout.groups[groupIndex]
  if (!group || terminalIdsInLayoutNode(group).length < 2) {
    return layout
  }

  const remaining = removeTerminalFromNode(group, terminalId)
  if (!remaining) {
    return layout
  }

  const groups = [...layout.groups]
  groups.splice(groupIndex, 1, remaining, { type: 'terminal', terminalId })
  return { groups }
}

export function splitTerminalInLayout(
  layout: TerminalWorkspaceLayout,
  targetTerminalId: string,
  terminalId: string,
  direction: TerminalSplitDirection
): TerminalWorkspaceLayout {
  if (targetTerminalId === terminalId) {
    return layout
  }

  const groups = layout.groups
    .map((group) => removeTerminalFromNode(group, terminalId))
    .filter((group): group is TerminalWorkspaceLayoutNode => group !== null)
  return {
    groups: groups.map((group) =>
      insertTerminalAtTarget(group, targetTerminalId, terminalId, direction)
    )
  }
}

export function updateTerminalSplitRatio(
  node: TerminalWorkspaceLayoutNode,
  path: readonly number[],
  ratio: number
): TerminalWorkspaceLayoutNode {
  if (!path.length || node.type === 'terminal') {
    return node.type === 'split' ? { ...node, ratio } : node
  }

  const [side, ...rest] = path
  return side === 0
    ? { ...node, first: updateTerminalSplitRatio(node.first, rest, ratio) }
    : { ...node, second: updateTerminalSplitRatio(node.second, rest, ratio) }
}
