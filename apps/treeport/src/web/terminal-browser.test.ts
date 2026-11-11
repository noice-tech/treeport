import { describe, expect, it } from 'vitest'
import { terminalTitleInTree } from './terminal-browser'

describe('terminalTitleInTree', () => {
  const treePath =
    '/home/user/projects/worktrees/banger.show/tree-2/banger.show'

  it('shows the tree folder for a terminal at the tree root', () => {
    expect(
      terminalTitleInTree(
        '~/projects/worktrees/banger.show/tree-2/banger.show',
        treePath
      )
    ).toBe('banger.show')
    expect(terminalTitleInTree(treePath, treePath)).toBe('banger.show')
  })

  it('shows the path from the tree folder for a subfolder', () => {
    expect(
      terminalTitleInTree(
        '~/projects/worktrees/banger.show/tree-2/banger.show/packages/api',
        treePath
      )
    ).toBe('banger.show/packages/api')
  })

  it('keeps paths outside the tree', () => {
    expect(terminalTitleInTree('~/projects/remotion', treePath)).toBe(
      '~/projects/remotion'
    )
    expect(
      terminalTitleInTree(
        '~/projects/worktrees/banger.show/tree-3/banger.show',
        treePath
      )
    ).toBe('~/projects/worktrees/banger.show/tree-3/banger.show')
  })

  it('does not match a folder that only shares a name prefix', () => {
    expect(
      terminalTitleInTree(
        '~/projects/worktrees/banger.show/tree-2/banger.show-old',
        treePath
      )
    ).toBe('~/projects/worktrees/banger.show/tree-2/banger.show-old')
  })

  it('keeps titles that are not paths', () => {
    expect(terminalTitleInTree('Claude Code', treePath)).toBe('Claude Code')
    expect(terminalTitleInTree('~', treePath)).toBe('~')
  })
})
