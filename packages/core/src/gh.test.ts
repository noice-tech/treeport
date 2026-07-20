import { describe, expect, it } from 'vitest'
import { mapPrState } from './gh.js'

describe('GitHub PR state mapping', () => {
  it.each([
    [null, 'no_pr'],
    [{ state: 'OPEN' }, 'open'],
    [{ state: 'CLOSED' }, 'closed'],
    [{ state: 'MERGED' }, 'merged'],
    [{ state: 'CLOSED', mergedAt: '2026-01-01T00:00:00Z' }, 'merged'],
    [{ state: 'surprise' }, 'unknown']
  ] as const)('maps %j to %s', (value, expected) => {
    expect(mapPrState(value)).toBe(expected)
  })
})
