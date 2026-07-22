import { describe, expect, it } from 'vitest'
import {
  createTerminalPresetSchema,
  createTerminalSchema,
  createWorktreeSchema,
  registerProjectSchema,
  removeWorktreeSchema,
  spawnSchema,
  TERMINAL_ARGUMENT_MAX_LENGTH,
  TERMINAL_EXECUTABLE_MAX_LENGTH,
  TERMINAL_NAME_MAX_LENGTH,
  TERMINAL_PRESET_ARGUMENT_MAX_COUNT,
  updateProjectSchema,
  updateTerminalPresetSchema
} from './index.js'

describe('API input validation', () => {
  it('requires repository paths and valid names', () => {
    expect(registerProjectSchema.safeParse({ path: '' }).success).toBe(false)
    expect(registerProjectSchema.parse({ path: '/repo with spaces' })).toEqual({
      path: '/repo with spaces'
    })
  })

  it('accepts only curated project colors and neutral', () => {
    expect(updateProjectSchema.parse({ color: 'cyan' })).toEqual({
      color: 'cyan'
    })
    expect(updateProjectSchema.parse({ color: null })).toEqual({ color: null })
    expect(updateProjectSchema.safeParse({ color: 'indigo' }).success).toBe(
      false
    )
    expect(updateProjectSchema.safeParse({ color: '#00ffff' }).success).toBe(
      false
    )
  })

  it('preserves command argv literally', () => {
    const argv = [
      'command with spaces',
      'a "quote"',
      'semi;colon',
      '$HOME',
      'Unicode 世界',
      "single'quote"
    ]
    expect(
      createTerminalSchema.parse({ name: 'researcher', argv }).argv
    ).toEqual(argv)
    expect(
      spawnSchema.parse({
        project: '.',
        worktreeName: 'topic',
        name: 'Pi',
        argv
      }).argv
    ).toEqual(argv)
  })

  it('rejects empty argv rather than accepting a shell command string', () => {
    expect(
      createTerminalSchema.safeParse({ name: 'bad', argv: [] }).success
    ).toBe(false)
    expect(
      createTerminalSchema.safeParse({ name: 'bad', argv: 'pnpm dev' }).success
    ).toBe(false)
  })

  it('keeps legacy terminal and spawn argument lengths unchanged', () => {
    const longArgument = 'x'.repeat(TERMINAL_ARGUMENT_MAX_LENGTH + 1)
    expect(
      createTerminalSchema.safeParse({
        name: 'Legacy terminal',
        argv: ['tool', longArgument]
      }).success
    ).toBe(true)
    expect(
      spawnSchema.safeParse({
        project: '.',
        worktreeName: 'topic',
        name: 'Legacy spawn',
        argv: ['tool', longArgument]
      }).success
    ).toBe(true)
  })

  it('validates preset fields separately and preserves literal arguments', () => {
    const input = {
      name: '  Hunk review  ',
      executable: '/Applications/Tools with spaces/npx',
      args: [
        '--yes',
        'hunkdiff@0.17.3',
        'a "quote"',
        'semi;colon',
        '$HOME',
        'Unicode 世界',
        '',
        "single'quote"
      ]
    }
    const expected = {
      ...input,
      name: 'Hunk review'
    }
    expect(createTerminalPresetSchema.parse(input)).toEqual(expected)
    expect(
      updateTerminalPresetSchema.parse({
        ...input,
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z'
      })
    ).toEqual({
      ...expected,
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z'
    })
    expect(
      createTerminalPresetSchema.safeParse({
        name: 'bad',
        executable: 'npx --yes hunkdiff',
        args: '--watch'
      }).success
    ).toBe(false)
    expect(
      createTerminalPresetSchema.safeParse({
        name: 'bad',
        executable: '   ',
        args: []
      }).success
    ).toBe(false)
  })

  it('bounds every terminal preset field', () => {
    const valid = { name: 'Preset', executable: 'tool', args: [] as string[] }
    expect(
      createTerminalPresetSchema.safeParse({
        ...valid,
        name: 'n'.repeat(TERMINAL_NAME_MAX_LENGTH + 1)
      }).success
    ).toBe(false)
    expect(
      createTerminalPresetSchema.safeParse({
        ...valid,
        executable: 'x'.repeat(TERMINAL_EXECUTABLE_MAX_LENGTH + 1)
      }).success
    ).toBe(false)
    expect(
      createTerminalPresetSchema.safeParse({
        ...valid,
        args: Array.from(
          { length: TERMINAL_PRESET_ARGUMENT_MAX_COUNT + 1 },
          () => 'arg'
        )
      }).success
    ).toBe(false)
    expect(
      createTerminalPresetSchema.safeParse({
        ...valid,
        args: ['x'.repeat(TERMINAL_ARGUMENT_MAX_LENGTH + 1)]
      }).success
    ).toBe(false)
  })

  it('validates detached worktree creation and removal payloads', () => {
    expect(createWorktreeSchema.parse({ name: 'feature-cache' })).toMatchObject(
      {
        name: 'feature-cache',
        base: 'default'
      }
    )
    expect(
      createWorktreeSchema.safeParse({ name: 'topic', base: 'current' }).success
    ).toBe(false)
    const confirmationToken = 'a'.repeat(64)
    expect(
      removeWorktreeSchema.parse({
        confirmationToken,
        confirmDestructive: true
      })
    ).toEqual({
      confirmationToken,
      confirmDestructive: true
    })
    expect(
      removeWorktreeSchema.safeParse({
        confirmationToken: 'short',
        confirmDestructive: true
      }).success
    ).toBe(false)
  })
})
