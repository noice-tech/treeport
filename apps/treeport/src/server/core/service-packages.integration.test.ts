import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from './database'
import { GhAdapter } from './gh'
import { GitAdapter } from './git'
import { TreeportService } from './service'
import { TmuxAdapter } from './tmux'
import {
  databases,
  fixture,
  persistedWebPanel
} from './service.integration-fixture'

describe('TreeportService with injected command adapters', () => {
  it('resolves repository terminal presets from each worktree and keeps usable choices through configuration errors', async () => {
    const { main, service } = await fixture()
    const treeportDirectory = path.join(main, '.treeport')
    const configPath = path.join(treeportDirectory, 'terminal-presets.json')
    await fs.mkdir(treeportDirectory, { recursive: true })
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        presets: {
          review: {
            name: 'Review',
            executable: 'pi',
            args: ['--prompt', 'Review; do not invoke a shell', '$HOME'],
            closeOnSuccess: false
          },
          dev: {
            name: 'Development',
            executable: 'pnpm',
            args: ['dev'],
            closeOnSuccess: true
          },
          broken: {
            name: '',
            executable: 'pnpm',
            args: ['broken']
          }
        }
      })
    )
    await service.createTerminalPreset({
      name: 'Development',
      executable: 'global-dev',
      args: [],
      closeOnSuccess: false
    })
    const project = await service.registerProject(main)
    const mainWorktree = project.worktrees[0]!

    const initial = await service.listTerminalPresetDefinitions({
      worktreeId: mainWorktree.id
    })
    expect(initial.definitions).toMatchObject([
      {
        name: 'Development',
        executable: 'pnpm',
        args: ['dev'],
        source: { type: 'repository' }
      },
      {
        name: 'Review',
        executable: 'pi',
        args: ['--prompt', 'Review; do not invoke a shell', '$HOME'],
        source: { type: 'repository' }
      },
      {
        name: 'Development',
        executable: 'global-dev',
        source: { type: 'user' }
      }
    ])
    expect(initial.diagnostics).toEqual([
      expect.objectContaining({
        presetId: 'broken',
        message: expect.stringContaining(
          'Invalid repository terminal preset broken'
        )
      })
    ])

    const linked = (
      await service.createWorktree(project.id, 'preset-linked', 'default')
    ).worktree
    await fs.mkdir(path.join(linked.path, '.treeport'), { recursive: true })
    await fs.writeFile(
      path.join(linked.path, '.treeport', 'terminal-presets.json'),
      JSON.stringify({
        version: 1,
        presets: {
          'linked-only': {
            name: 'Linked only',
            executable: 'linked-command',
            args: []
          }
        }
      })
    )
    const linkedDefinitions = await service.listTerminalPresetDefinitions({
      worktreeId: linked.id
    })
    expect(linkedDefinitions.definitions).toContainEqual(
      expect.objectContaining({
        name: 'Linked only',
        executable: 'linked-command',
        source: { type: 'repository' }
      })
    )
    expect(linkedDefinitions.definitions).not.toContainEqual(
      expect.objectContaining({ name: 'Review' })
    )

    await fs.writeFile(configPath, '{ invalid json')
    const malformed = await service.listTerminalPresetDefinitions({
      worktreeId: mainWorktree.id
    })
    expect(malformed.definitions).toEqual([
      expect.objectContaining({
        name: 'Development',
        executable: 'global-dev',
        source: { type: 'user' }
      })
    ])
    expect(malformed.diagnostics[0]?.message).toContain(
      'Could not parse repository terminal presets'
    )

    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        presets: {
          fixed: {
            name: 'Fixed immediately',
            executable: 'fixed-command',
            args: ['argument with spaces']
          }
        }
      })
    )
    expect(
      await service.listTerminalPresetDefinitions({
        worktreeId: mainWorktree.id
      })
    ).toMatchObject({
      definitions: [
        {
          name: 'Fixed immediately',
          executable: 'fixed-command',
          args: ['argument with spaces'],
          source: { type: 'repository' }
        },
        {
          name: 'Development',
          executable: 'global-dev',
          source: { type: 'user' }
        }
      ],
      diagnostics: []
    })
  })

  it('discovers local web panels and owns their persistent synchronized lifecycle', async () => {
    const { main, service, database } = await fixture()
    const webPanels = path.join(main, '.treeport', 'web-panels')
    const reviewPanel = path.join(webPanels, 'review')
    await fs.mkdir(reviewPanel, { recursive: true })
    await fs.writeFile(path.join(reviewPanel, 'index.html'), '<h1>Review</h1>')
    await fs.mkdir(path.join(webPanels, 'code-review'))
    await fs.writeFile(
      path.join(webPanels, 'code-review', 'index.html'),
      '<h1>Code review</h1>'
    )
    await fs.mkdir(path.join(webPanels, 'missing-entry'))
    const project = await service.registerProject(main)
    const worktree = project.worktrees[0]!
    expect(await service.listWebPanelDefinitions(worktree.id)).toEqual([
      {
        id: 'project:code-review',
        source: { type: 'project' },
        title: 'Code review'
      },
      {
        id: 'project:review',
        source: { type: 'project' },
        title: 'Review'
      }
    ])

    await expect(
      service.createWebPanel(worktree.id, 'project:missing')
    ).rejects.toMatchObject({ code: 'WEB_PANEL_DEFINITION_NOT_FOUND' })

    const events: string[] = []
    const unsubscribe = service.events.subscribe((event) => {
      if (
        event.type === 'panel.created' ||
        event.type === 'panel.updated' ||
        event.type === 'panel.open_requested' ||
        event.type === 'panel.removed'
      ) {
        events.push(`${event.type}:${event.data.panelId}`)
      }
    })
    const panel = await service.createWebPanel(worktree.id, 'project:review', {
      input: { path: 'output/demo.mp4', autoplay: false },
      cwd: '.'
    })
    expect(panel.launch).toEqual({
      input: { path: 'output/demo.mp4', autoplay: false },
      cwd: '.'
    })
    expect((await service.getWebPanelContext(panel.id)).launch).toEqual(
      panel.launch
    )
    expect(
      (await service.getWorktreeSnapshot(worktree.id)).panels
    ).toContainEqual(panel)
    expect(await service.resolveWebPanelAsset(panel.id, '')).toMatchObject({
      kind: 'redirect',
      development: true
    })
    await expect(
      service.resolveWebPanelAsset(panel.id, '../../outside')
    ).rejects.toMatchObject({ code: 'INVALID_ASSET_PATH' })
    const outside = path.join(main, 'outside.js')
    await fs.writeFile(outside, 'outside')
    await fs.symlink(outside, path.join(reviewPanel, 'outside.js'))
    await expect(
      service.resolveWebPanelAsset(panel.id, 'outside.js')
    ).rejects.toMatchObject({ code: 'INVALID_ASSET_PATH' })
    expect(await persistedWebPanel(database, panel.id)).toEqual(panel)

    await expect(
      service.createWebPanel(worktree.id, 'project:review', {
        input: { body: 'x'.repeat(65_537) },
        cwd: null
      })
    ).rejects.toMatchObject({ code: 'WEB_PANEL_INPUT_TOO_LARGE' })
    await expect(
      service.createWebPanel(worktree.id, 'project:review', {
        input: null,
        cwd: '..'
      })
    ).rejects.toMatchObject({ code: 'INVALID_WEB_PANEL_LAUNCH_CWD' })

    expect(
      await service.getWebPanelStorage(panel.id, 'comments')
    ).toBeUndefined()
    expect(await service.hasWebPanelStorage(panel.id)).toBe(false)
    await service.setWebPanelStorage(panel.id, 'comments', [
      { file: 'src/app.ts', line: 12, body: 'Handle this case' }
    ])
    expect(await service.getWebPanelStorage(panel.id, 'comments')).toEqual([
      { file: 'src/app.ts', line: 12, body: 'Handle this case' }
    ])
    expect(await service.hasWebPanelStorage(panel.id)).toBe(true)

    const reused = await service.openWebPanel(worktree.id, 'project:review', {
      input: { path: 'output/updated.mp4' },
      cwd: '.'
    })
    expect(reused).toMatchObject({
      created: false,
      reused: true,
      panel: {
        id: panel.id,
        launch: { input: { path: 'output/updated.mp4' }, cwd: '.' }
      }
    })
    expect(reused.panel.updatedAt > panel.updatedAt).toBe(true)
    expect(await service.getWebPanelStorage(panel.id, 'comments')).toEqual([
      { file: 'src/app.ts', line: 12, body: 'Handle this case' }
    ])

    const separate = await service.openWebPanel(
      worktree.id,
      'project:review',
      { input: null, cwd: null },
      true
    )
    expect(separate.created).toBe(true)
    expect(separate.reused).toBe(false)
    expect(separate.panel.id).not.toBe(panel.id)
    await service.deleteWebPanel(separate.panel.id)

    await expect(service.deleteWebPanel(panel.id)).rejects.toMatchObject({
      code: 'PANEL_HAS_STORED_DATA'
    })
    expect(await persistedWebPanel(database, panel.id)).toEqual(reused.panel)
    await service.deleteWebPanelStorage(panel.id, 'comments')
    expect(
      await service.getWebPanelStorage(panel.id, 'comments')
    ).toBeUndefined()
    expect(await service.hasWebPanelStorage(panel.id)).toBe(false)
    await expect(
      service.setWebPanelStorage(panel.id, 'too-large', 'x'.repeat(65_537))
    ).rejects.toMatchObject({ code: 'WEB_PANEL_STORAGE_VALUE_TOO_LARGE' })

    await service.deleteWebPanel(panel.id)
    unsubscribe()
    expect(await persistedWebPanel(database, panel.id)).toBeNull()
    expect(events).toEqual([
      `panel.created:${panel.id}`,
      `panel.updated:${panel.id}`,
      `panel.open_requested:${panel.id}`,
      `panel.created:${separate.panel.id}`,
      `panel.open_requested:${separate.panel.id}`,
      `panel.removed:${separate.panel.id}`,
      `panel.removed:${panel.id}`
    ])
  })

  it('restores web-panel launch input after a daemon service reconstruction', async () => {
    const { main, service, database, config, runner } = await fixture()
    const panelRoot = path.join(main, '.treeport', 'web-panels', 'preview')
    await fs.mkdir(panelRoot, { recursive: true })
    await fs.writeFile(path.join(panelRoot, 'index.html'), '<h1>Preview</h1>')
    const project = await service.registerProject(main)
    const worktree = project.worktrees[0]!
    const panel = await service.createWebPanel(worktree.id, 'project:preview', {
      input: { path: 'output/demo.mp4', autoplay: false },
      cwd: '.'
    })

    database.close()
    databases.splice(databases.indexOf(database), 1)
    const reopenedDatabase = await openDatabase(config.databasePath)
    databases.push(reopenedDatabase)
    const reconstructed = new TreeportService({
      config,
      database: reopenedDatabase,
      runner,
      git: new GitAdapter(runner),
      tmux: new TmuxAdapter(
        runner,
        config.runtimeDir,
        'tmux',
        '/launcher with spaces.js'
      ),
      gh: new GhAdapter(runner)
    })
    await reconstructed.initialize()

    await expect(
      reconstructed.getWebPanelContext(panel.id)
    ).resolves.toMatchObject({
      panel: { id: panel.id, launch: panel.launch },
      launch: panel.launch
    })
  })

  it('serves package resources across repository worktrees while preserving ordinary terminals and persistent panels through removal', async () => {
    const { root, main, service, database } = await fixture()
    const packageRoot = path.join(root, 'review package')
    const reviewRoot = path.join(packageRoot, 'web-panels', 'review')
    await fs.mkdir(reviewRoot, { recursive: true })
    await fs.mkdir(path.join(packageRoot, 'terminal-presets'), {
      recursive: true
    })
    await fs.mkdir(path.join(main, '.treeport'), {
      recursive: true
    })
    await Promise.all([
      fs.writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({
          name: '@acme/review',
          keywords: ['treeport-package'],
          treeport: {
            webPanels: ['./web-panels/*'],
            terminalPresets: ['./terminal-presets/*.json']
          }
        })
      ),
      fs.writeFile(path.join(reviewRoot, 'index.html'), '<h1>Review v1</h1>'),
      fs.writeFile(
        path.join(packageRoot, 'terminal-presets', 'dev.json'),
        JSON.stringify({
          name: 'Package dev server',
          executable: 'pnpm',
          args: ['dev'],
          closeOnSuccess: false
        })
      )
    ])

    await fs.writeFile(
      path.join(main, '.treeport', 'settings.json'),
      JSON.stringify({ packages: [packageRoot] })
    )
    const project = await service.registerProject(main)
    const mainWorktree = project.worktrees[0]!
    const definition = (
      await service.listWebPanelDefinitions(mainWorktree.id)
    ).find((candidate) => candidate.source.type === 'package')!
    expect(definition).toMatchObject({
      title: 'Review',
      source: { type: 'package', scope: 'project' }
    })
    expect(
      await service.listTerminalPresetDefinitions({ projectId: project.id })
    ).toEqual({
      definitions: [
        expect.objectContaining({
          name: 'Package dev server',
          executable: 'pnpm',
          args: ['dev'],
          source: expect.objectContaining({ type: 'package', scope: 'project' })
        })
      ],
      diagnostics: []
    })

    const linked = (
      await service.createWorktree(project.id, 'package-linked', 'default')
    ).worktree
    expect(
      (await service.listWebPanelDefinitions(linked.id)).map(
        (candidate) => candidate.id
      )
    ).toContain(definition.id)

    const panel = await service.createWebPanel(linked.id, definition.id)
    await service.setWebPanelStorage(panel.id, 'draft', { body: 'keep me' })
    const terminal = await service.createTerminal(linked.id, 'Package dev', [
      'pnpm',
      'dev'
    ])
    expect(await service.resolveWebPanelAsset(panel.id, '')).toMatchObject({
      kind: 'redirect',
      development: true
    })

    await fs.writeFile(
      path.join(reviewRoot, 'index.html'),
      '<h1>Review v2</h1>'
    )
    await service.reloadPackages()
    expect(
      (await service.listWebPanelDefinitions(linked.id)).find(
        (candidate) => candidate.title === 'Review'
      )?.id
    ).toBe(definition.id)

    const outside = path.join(root, 'outside-package.js')
    await fs.writeFile(outside, 'outside')
    await fs.symlink(outside, path.join(reviewRoot, 'outside.js'))
    await expect(
      service.resolveWebPanelAsset(panel.id, 'outside.js')
    ).rejects.toMatchObject({ code: 'INVALID_ASSET_PATH' })

    await service.removePackage(packageRoot, project.id)
    expect(await service.listWebPanelDefinitions(linked.id)).not.toContainEqual(
      expect.objectContaining({ id: definition.id })
    )
    expect(await persistedWebPanel(database, panel.id)).toEqual(panel)
    expect(await service.getWebPanelStorage(panel.id, 'draft')).toEqual({
      body: 'keep me'
    })
    expect(
      (await service.getWorktreeSnapshot(linked.id)).terminals
    ).toContainEqual(
      expect.objectContaining({ id: terminal.id, argv: ['pnpm', 'dev'] })
    )
    await expect(
      service.resolveWebPanelAsset(panel.id, '')
    ).rejects.toMatchObject({
      code: 'WEB_PANEL_DEFINITION_NOT_FOUND',
      message: 'The definition for this panel is unavailable'
    })

    await service.installPackage(packageRoot, project.id)
    const persistedSettings = JSON.parse(
      await fs.readFile(path.join(main, '.treeport', 'settings.json'), 'utf8')
    ) as { packages: string[] }
    expect(path.isAbsolute(persistedSettings.packages[0]!)).toBe(false)
    expect(
      (await service.listWebPanelDefinitions(linked.id)).find(
        (candidate) => candidate.title === 'Review'
      )?.id
    ).toBe(definition.id)
    expect(await service.getWebPanelStorage(panel.id, 'draft')).toEqual({
      body: 'keep me'
    })
  })

  it('browses bounded server directories and resolves repository roots', async () => {
    const { root, main, service } = await fixture()
    const browserRoot = path.join(root, 'folder browser')
    const spaced = path.join(browserRoot, 'space folder')
    const unicode = path.join(browserRoot, '世界')
    const hidden = path.join(browserRoot, '.hidden')
    await fs.mkdir(browserRoot)
    await Promise.all([
      fs.mkdir(spaced, { recursive: true }),
      fs.mkdir(unicode, { recursive: true }),
      fs.mkdir(hidden, { recursive: true }),
      fs.writeFile(path.join(browserRoot, 'ordinary.txt'), 'not a folder')
    ])
    await fs.symlink(spaced, path.join(browserRoot, 'linked folder'))
    const canonicalBrowserRoot = await fs.realpath(browserRoot)
    const canonicalSpaced = await fs.realpath(spaced)

    const visible = await service.browseDirectory(browserRoot)
    expect(visible.exact).toBe(true)
    expect(visible.directory.entries.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['linked folder', 'space folder', '世界'])
    )
    expect(visible.directory.entries).toHaveLength(3)
    expect(visible.directory.breadcrumbs.at(-1)).toEqual({
      name: 'folder browser',
      path: canonicalBrowserRoot
    })

    const partial = await service.browseDirectory(path.join(browserRoot, 'spa'))
    expect(partial).toMatchObject({
      exact: false,
      repository: { state: 'incomplete' },
      directory: {
        entries: [{ name: 'space folder', path: canonicalSpaced }]
      }
    })

    const withHidden = await service.browseDirectory(browserRoot, true)
    expect(withHidden.directory.entries.map((entry) => entry.name)).toContain(
      '.hidden'
    )
    await expect(
      service.browseDirectory(path.join(browserRoot, 'missing', 'child'))
    ).rejects.toMatchObject({ code: 'DIRECTORY_NOT_FOUND', status: 404 })
    await expect(
      service.browseDirectory(path.join(browserRoot, 'ordinary.txt'))
    ).rejects.toMatchObject({
      code: 'DIRECTORY_NOT_A_DIRECTORY',
      status: 400
    })

    const nested = path.join(main, 'nested folder')
    await fs.mkdir(nested)
    await expect(service.browseDirectory(nested)).resolves.toMatchObject({
      exact: true,
      repository: {
        state: 'valid',
        repositoryPath: await fs.realpath(main)
      }
    })

    await Promise.all(
      Array.from({ length: 201 }, (_, index) =>
        fs.mkdir(
          path.join(browserRoot, `many-${String(index).padStart(3, '0')}`)
        )
      )
    )
    const bounded = await service.browseDirectory(browserRoot)
    expect(bounded.directory.entries).toHaveLength(200)
    expect(bounded.directory.truncated).toBe(true)
  })

  it('persists ordered terminal preset CRUD across service reconstruction', async () => {
    const { runner, service, database, config } = await fixture()
    const first = await service.createTerminalPreset({
      name: 'Pi 世界',
      executable: '/Applications/Tools with spaces/pi',
      args: ['a b', 'semi;colon', '$HOME', '"quote"', ''],
      closeOnSuccess: true
    })
    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = await service.createTerminalPreset({
      name: 'Hunk',
      executable: 'npx',
      args: ['--yes', 'hunkdiff@0.17.3', 'diff', 'HEAD', '--watch']
    })
    expect(first.id).toMatch(/^preset_[0-9a-f]{32}$/)
    expect(
      (await service.listTerminalPresets()).map((preset) => preset.id)
    ).toEqual([first.id, second.id])

    const updated = await service.updateTerminalPreset(
      first.id,
      {
        name: 'Pi updated',
        executable: 'pi',
        args: ['--model', 'literal;$HOME']
      },
      first.updatedAt
    )
    expect(updated.closeOnSuccess).toBe(true)
    await expect(
      service.updateTerminalPreset(
        first.id,
        {
          name: 'Stale overwrite',
          executable: 'pi',
          args: []
        },
        first.updatedAt
      )
    ).rejects.toMatchObject({
      code: 'TERMINAL_PRESET_CHANGED',
      status: 409
    })
    await service.deleteTerminalPreset(second.id, second.updatedAt)
    expect(await service.listTerminalPresets()).toEqual([updated])
    await expect(
      service.updateTerminalPreset('preset_missing', updated, updated.updatedAt)
    ).rejects.toMatchObject({
      code: 'TERMINAL_PRESET_NOT_FOUND',
      status: 404
    })
    await expect(
      service.deleteTerminalPreset('preset_missing', updated.updatedAt)
    ).rejects.toMatchObject({
      code: 'TERMINAL_PRESET_NOT_FOUND',
      status: 404
    })
    await expect(
      service.deleteTerminalPreset(first.id, first.updatedAt)
    ).rejects.toMatchObject({
      code: 'TERMINAL_PRESET_CHANGED',
      status: 409
    })

    database.close()
    databases.splice(databases.indexOf(database), 1)
    const reopenedDatabase = await openDatabase(config.databasePath)
    databases.push(reopenedDatabase)
    const reconstructed = new TreeportService({
      config,
      database: reopenedDatabase,
      runner,
      git: new GitAdapter(runner),
      tmux: new TmuxAdapter(
        runner,
        config.runtimeDir,
        'tmux',
        '/launcher with spaces.js'
      ),
      gh: new GhAdapter(runner)
    })
    expect(await reconstructed.listTerminalPresets()).toEqual([updated])
  })
})
