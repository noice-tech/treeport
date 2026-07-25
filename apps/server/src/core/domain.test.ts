import { describe, expect, it } from 'vitest'
import { assertCleanupTransition } from './domain'

describe('worktree removal state', () => {
  it('enforces conservative removal state transitions', () => {
    expect(() => assertCleanupTransition('active', 'cleaning')).not.toThrow()
    expect(() =>
      assertCleanupTransition('cleanup_failed', 'cleaning')
    ).not.toThrow()
    expect(() => assertCleanupTransition('cleaning', 'removed')).not.toThrow()
    expect(() =>
      assertCleanupTransition('cleaning', 'cleanup_failed')
    ).not.toThrow()
    expect(() => assertCleanupTransition('active', 'removed')).toThrow(
      /Cannot transition/
    )
  })
})
