import { describe, expect, it } from 'vitest'
import {
  browseDirectoryQuerySchema as browseDirectoryQueryEffectSchema,
  createLauncherSchema as createLauncherEffectSchema,
  createTerminalSchema as createTerminalEffectSchema,
  createWorktreeSchema as createWorktreeEffectSchema,
  registerProjectSchema as registerProjectEffectSchema,
  removeWorktreeSchema as removeWorktreeEffectSchema,
  TERMINAL_ARGUMENT_MAX_LENGTH,
  TERMINAL_EXECUTABLE_MAX_LENGTH,
  TERMINAL_NAME_MAX_LENGTH,
  LAUNCHER_ARGUMENT_MAX_COUNT,
  updateLauncherSchema as updateLauncherEffectSchema
} from './index.ts'
import { testSchema } from './schema.test-support.ts'

const browseDirectoryQuerySchema = testSchema(browseDirectoryQueryEffectSchema)
const createLauncherSchema = testSchema(createLauncherEffectSchema)
const createTerminalSchema = testSchema(createTerminalEffectSchema)
const createWorktreeSchema = testSchema(createWorktreeEffectSchema)
const registerProjectSchema = testSchema(registerProjectEffectSchema)
const removeWorktreeSchema = testSchema(removeWorktreeEffectSchema)
const updateLauncherSchema = testSchema(updateLauncherEffectSchema)

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

  it('preserves terminal commands literally', () => {
    const command = `printf '%s' 'a "quote"' 'semi;colon' $HOME 'Unicode 世界'`

    expect(
      createTerminalSchema.parse({
        name: 'researcher',
        command,
        cwd: '/repo/worktrees/topic with spaces',
        env: { CUSTOM: 'value;$HOME 雪' },
        afterExit: 'closeOnSuccess',
        initialSize: { cols: 132, rows: 47 }
      })
    ).toMatchObject({
      command,
      cwd: '/repo/worktrees/topic with spaces',
      env: { CUSTOM: 'value;$HOME 雪' },
      afterExit: 'closeOnSuccess',
      initialSize: { cols: 132, rows: 47 }
    })
    expect(
      createTerminalSchema.safeParse({
        name: 'invalid lifecycle',
        command,
        afterExit: 'later'
      }).success
    ).toBe(false)
    expect(
      createWorktreeSchema.parse({
        name: 'topic',
        initialTerminal: {
          name: '  Hunk  ',
          command
        }
      })
    ).toMatchObject({
      initialTerminal: { name: 'Hunk', command }
    })
  })

  it('rejects blank commands and invalid initial sizes', () => {
    expect(
      createTerminalSchema.safeParse({ name: 'bad', command: '' }).success
    ).toBe(false)
    expect(
      createTerminalSchema.safeParse({ name: 'bad', command: ['pnpm', 'dev'] })
        .success
    ).toBe(false)
    expect(
      createTerminalSchema.safeParse({ name: 'bad', command: ' \t ' }).success
    ).toBe(false)
    expect(
      createTerminalSchema.safeParse({
        name: 'bad',
        command: 'bun\0remotion'
      }).success
    ).toBe(false)
    expect(
      createTerminalSchema.safeParse({
        name: 'bad size',
        initialSize: { cols: 1, rows: 24 }
      }).success
    ).toBe(false)
    expect(createTerminalSchema.safeParse({ name: ' \t ' }).success).toBe(false)
    expect(
      createWorktreeSchema.safeParse({
        name: 'bad worktree title',
        initialTerminal: {
          name: 'x'.repeat(TERMINAL_NAME_MAX_LENGTH + 1)
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

  it('limits terminal command length', () => {
    expect(
      createTerminalSchema.safeParse({
        name: 'Long command',
        command: 'x'.repeat(TERMINAL_ARGUMENT_MAX_LENGTH + 1)
      }).success
    ).toBe(false)
  })

  it('validates launcher fields separately and preserves literal arguments', () => {
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
      closeOnSuccess: false,
      treeTitle: null
    }

    expect(createLauncherSchema.parse(input)).toEqual(expected)
    expect(
      updateLauncherSchema.parse({
        ...input,
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z'
      })
    ).toEqual({
      ...input,
      name: 'Hunk review',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z'
    })
    expect(
      updateLauncherSchema.parse({
        ...input,
        closeOnSuccess: true,
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z'
      }).closeOnSuccess
    ).toBe(true)
    expect(
      createLauncherSchema.safeParse({
        name: 'bad',
        executable: 'npx --yes hunkdiff',
        args: '--watch'
      }).success
    ).toBe(false)
    expect(
      createLauncherSchema.safeParse({
        name: 'bad',
        executable: '   ',
        args: []
      }).success
    ).toBe(false)
  })

  it('bounds every launcher field', () => {
    const valid = {
      name: 'Launcher',
      executable: 'tool',
      args: new Array<string>()
    }

    expect(
      createLauncherSchema.safeParse({
        ...valid,
        name: 'n'.repeat(TERMINAL_NAME_MAX_LENGTH + 1)
      }).success
    ).toBe(false)
    expect(
      createLauncherSchema.safeParse({
        ...valid,
        executable: 'x'.repeat(TERMINAL_EXECUTABLE_MAX_LENGTH + 1)
      }).success
    ).toBe(false)
    expect(
      createLauncherSchema.safeParse({
        ...valid,
        args: Array.from(
          { length: LAUNCHER_ARGUMENT_MAX_COUNT + 1 },
          () => 'arg'
        )
      }).success
    ).toBe(false)
    expect(
      createLauncherSchema.safeParse({
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
      confirmDestructive: true,
      skipCleanup: false
    })
    expect(
      removeWorktreeSchema.parse({
        confirmationToken,
        confirmDestructive: true,
        skipCleanup: true
      })
    ).toMatchObject({ skipCleanup: true })
    expect(
      removeWorktreeSchema.safeParse({
        confirmationToken: 'short',
        confirmDestructive: true
      }).success
    ).toBe(false)
  })
})
