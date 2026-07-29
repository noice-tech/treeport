import { describe, expect, it } from 'vitest'
import { extractJsonOutput } from './args.js'

describe('CLI global argument parsing', () => {
  it('consumes --json before the command separator', () => {
    const args = ['terminal', 'create', '--json', '--', 'tool', '--flag']
    expect(extractJsonOutput(args)).toBe(true)
    expect(args).toEqual(['terminal', 'create', '--', 'tool', '--flag'])
  })

  it('preserves a literal --json command argument after the separator', () => {
    const args = [
      'terminal',
      'create',
      '--worktree',
      '.',
      '--name',
      'tool',
      '--',
      'tool',
      '--json'
    ]
    expect(extractJsonOutput(args)).toBe(false)
    expect(args.slice(-2)).toEqual(['tool', '--json'])
  })
})
