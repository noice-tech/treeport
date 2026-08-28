import { describe, expect, it } from 'vitest'
import {
  browseDirectoryQuerySchema,
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

  it('parses directory browsing query flags explicitly', () => {
    expect(
      browseDirectoryQuerySchema.parse({
        input: ' ~/Projects ',
        hidden: 'false'
      })
    ).toEqual({ input: '~/Projects', hidden: false })
    expect(
      browseDirectoryQuerySchema.parse({ input: '/srv/repos', hidden: 'true' })
    ).toEqual({ input: '/srv/repos', hidden: true })
    expect(
      browseDirectoryQuerySchema.safeParse({ input: '', hidden: 'yes' }).success
    ).toBe(false)
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
      createTerminalSchema.parse({
        name: 'researcher',
        initialTitle: '  Review preset  ',
        argv,
        cwd: '/repo/worktrees/topic with spaces',
        env: { CUSTOM: 'value;$HOME 雪' },
        returnToShell: true,
        initialSize: { cols: 132, rows: 47 }
      })
    ).toMatchObject({
      initialTitle: 'Review preset',
      argv,
      cwd: '/repo/worktrees/topic with spaces',
      env: { CUSTOM: 'value;$HOME 雪' },
      returnToShell: true,
      initialSize: { cols: 132, rows: 47 }
    })
    expect(
      createTerminalSchema.safeParse({
        name: 'invalid lifecycle',
        argv,
        returnToShell: true,
        closeOnSuccess: true
      }).success
    ).toBe(false)
    expect(
      createTerminalSchema.parse({
        name: 'Zed task',
        shellCommand: 'bun remotion',
        returnToShell: true
      })
    ).toMatchObject({
      shellCommand: 'bun remotion',
      returnToShell: true
    })
    expect(
      createTerminalSchema.safeParse({
        name: 'ambiguous',
        argv,
        shellCommand: 'bun remotion'
      }).success
    ).toBe(false)
    expect(
      spawnSchema.parse({
        project: '.',
        worktreeName: 'topic',
        name: 'Pi',
        argv
      }).argv
    ).toEqual(argv)
    expect(
      createWorktreeSchema.parse({
        name: 'topic',
        initialTerminal: {
          name: 'Hunk',
          initialTitle: '  Hunk review  ',
          argv
        }
      }).initialTerminal
    ).toEqual({ name: 'Hunk', initialTitle: 'Hunk review', argv })
  })

  it('rejects empty argv, command strings, and invalid initial sizes', () => {
    expect(
      createTerminalSchema.safeParse({ name: 'bad', argv: [] }).success
    ).toBe(false)
    expect(
      createTerminalSchema.safeParse({ name: 'bad', argv: 'pnpm dev' }).success
    ).toBe(false)
    expect(
      createTerminalSchema.safeParse({ name: 'bad', shellCommand: ' \t ' })
        .success
    ).toBe(false)
    expect(
      createTerminalSchema.safeParse({
        name: 'bad',
        shellCommand: 'bun\0remotion'
      }).success
    ).toBe(false)
    expect(
      createTerminalSchema.safeParse({
        name: 'bad size',
        initialSize: { cols: 1, rows: 24 }
      }).success
    ).toBe(false)
    expect(
      createTerminalSchema.safeParse({
        name: 'bad title',
        initialTitle: ' \t '
      }).success
    ).toBe(false)
    expect(
      createWorktreeSchema.safeParse({
        name: 'bad worktree title',
        initialTerminal: {
          name: 'Hunk',
          initialTitle: 'x'.repeat(TERMINAL_NAME_MAX_LENGTH + 1)
        }
      }).success
    ).toBe(false)
    expect(
      createWorktreeSchema.safeParse({
        name: 'bad worktree size',
        initialTerminal: {
          name: 'Hunk',
          initialSize: { cols: 120, rows: 501 }
        }
      }).success
    ).toBe(false)
    for (const invalid of [
      { cwd: '' },
      { cwd: ' \t ' },
      { cwd: '/repo/with\0nul' },
      { env: { 'BAD=KEY': 'value' } },
      { env: { 'BAD\0KEY': 'value' } },
      { env: { GOOD: 'value\0with-nul' } },
      {
        env: Object.fromEntries(
          Array.from({ length: 129 }, (_, index) => [`KEY_${index}`, 'value'])
        )
      }
    ]) {
      expect(
        createTerminalSchema.safeParse({ name: 'invalid launch', ...invalid })
          .success
      ).toBe(false)
    }
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
    expect(
      createTerminalSchema.safeParse({
        name: 'Shell command',
        shellCommand: longArgument
      }).success
    ).toBe(false)
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
      name: 'Hunk review',
      closeOnSuccess: false
    }
    expect(createTerminalPresetSchema.parse(input)).toEqual(expected)
    expect(
      updateTerminalPresetSchema.parse({
        ...input,
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z'
      })
    ).toEqual({
      ...input,
      name: 'Hunk review',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z'
    })
    expect(
      updateTerminalPresetSchema.parse({
        ...input,
        closeOnSuccess: true,
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z'
      }).closeOnSuccess
    ).toBe(true)
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
    // SAFETY: The test fixture provides the asserted contract used here.
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
