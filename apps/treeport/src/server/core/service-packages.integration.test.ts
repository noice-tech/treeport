import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TREE_FILE_MAX_BYTES } from '@treeport/shared'
import { openDatabase } from './database'
import { GhAdapter } from './gh'
import { GitAdapter } from './git'
import { TreeportService } from './service'
import { TerminalHostDouble } from './service.integration-fixture'
import {
  databases,
  fixture,
  persistedWebPanel
} from './service.integration-fixture'

describe('TreeportService with injected command adapters', () => {
  it('resolves repository terminal presets from each worktree and keeps usable choices through configuration errors', async () => {
    const { main, runner, service } = await fixture()
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
    await fs.mkdir(path.join(main, '.zed'), { recursive: true })
    await fs.writeFile(
      path.join(main, '.zed', 'tasks.json'),
      `[
        {
          // This remains manually runnable even though it is also a setup hook.
          "label": "Shared $ZED_WORKTREE_ROOT",
          "command": "node",
          "args": ["$ZED_MAIN_GIT_WORKTREE/script.js", "argument with spaces"],
          "cwd": "tools",
          "env": {
            "CUSTOM": "$ZED_MAIN_GIT_WORKTREE:$ZED_WORKTREE_ROOT",
            "TREEPORT_PROJECT_ID": "cannot-override"
          },
          "hooks": ["create_worktree"],
          "reveal": "always",
        },
        { "label": "Duplicate", "command": "echo one" },
        { "label": "Duplicate", "command": "printf", "args": ["two"] },
      ]`
    )
    await service.createTerminalPreset({
      name: 'Development',
      executable: 'global-dev',
      args: [],
      closeOnSuccess: false
    })
    const project = await service.registerProject(main)
    const canonicalMain = project.mainWorktreePath
    const mainWorktree = project.worktrees[0]!

    const initial = await service.listTerminalPresetDefinitions({
      worktreeId: mainWorktree.id
    })
    expect(initial.definitions).toMatchObject([
      {
        name: 'Development',
        executable: 'pnpm',
        args: ['dev'],
        source: { type: 'repository', format: 'treeport' }
      },
      {
        name: 'Review',
        executable: 'pi',
        args: ['--prompt', 'Review; do not invoke a shell', '$HOME'],
        source: { type: 'repository', format: 'treeport' }
      },
      {
        name: `Shared ${canonicalMain}`,
        executable: 'node',
        args: [path.join(canonicalMain, 'script.js'), 'argument with spaces'],
        cwd: path.join(canonicalMain, 'tools'),
        source: { type: 'repository', format: 'zed' }
      },
      {
        name: 'Duplicate',
        executable: null,
        args: [],
        shellCommand: 'echo one',
        source: { type: 'repository', format: 'zed' }
      },
      {
        name: 'Duplicate',
        executable: 'printf',
        source: { type: 'repository', format: 'zed' }
      },
      {
        name: 'Development',
        executable: 'global-dev',
        source: { type: 'user' }
      }
    ])
    expect(initial.diagnostics).toEqual([
      expect.objectContaining({
        itemId: 'broken',
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
    await fs.mkdir(path.join(linked.path, '.zed'), { recursive: true })
    await fs.writeFile(
      path.join(linked.path, '.zed', 'tasks.json'),
      JSON.stringify([{ label: 'Linked Zed task', command: 'ignored' }])
    )
    const linkedDefinitions = await service.listTerminalPresetDefinitions({
      worktreeId: linked.id
    })
    expect(linkedDefinitions.definitions).toContainEqual(
      expect.objectContaining({
        name: 'Linked only',
        executable: 'linked-command',
        source: { type: 'repository', format: 'treeport' }
      })
    )
    expect(linkedDefinitions.definitions).not.toContainEqual(
      expect.objectContaining({ name: 'Review' })
    )
    expect(linkedDefinitions.definitions).not.toContainEqual(
      expect.objectContaining({ name: 'Linked Zed task' })
    )
    expect(
      linkedDefinitions.definitions.filter(
        (definition) =>
          definition.source.type === 'repository' &&
          definition.source.format === 'zed'
      )
    ).toMatchObject([
      {
        name: `Shared ${linked.path}`,
        cwd: path.join(linked.path, 'tools'),
        env: {
          CUSTOM: `${canonicalMain}:${linked.path}`,
          ZED_WORKTREE_ROOT: linked.path,
          ZED_MAIN_GIT_WORKTREE: canonicalMain
        }
      },
      { name: 'Duplicate' },
      { name: 'Duplicate' }
    ])
    expect(
      (
        await service.listTerminalPresetDefinitions({ projectId: project.id })
      ).definitions.some(
        (definition) => definition.source.type === 'repository'
      )
    ).toBe(false)

    const resolvedZed = linkedDefinitions.definitions.find(
      (definition) => definition.name === `Shared ${linked.path}`
    )
    if (!resolvedZed?.executable || !resolvedZed.cwd) {
      throw new Error('Direct Zed preset was not resolved')
    }

    const terminal = await service.createTerminal(
      linked.id,
      resolvedZed.name,
      [resolvedZed.executable, ...resolvedZed.args],
      {
        initialTitle: resolvedZed.name,
        cwd: resolvedZed.cwd,
        env: resolvedZed.env,
        returnToShell: true
      }
    )
    const launchSpec = runner.terminalCreateInputs.get(terminal.id)
    expect(launchSpec).toMatchObject({
      initialTitle: resolvedZed.name,
      argv: [
        'node',
        path.join(canonicalMain, 'script.js'),
        'argument with spaces'
      ],
      fallbackArgv: ['/bin/zsh', '-l'],
      cwd: path.join(linked.path, 'tools'),
      env: {
        CUSTOM: `${canonicalMain}:${linked.path}`,
        ZED_WORKTREE_ROOT: linked.path,
        ZED_MAIN_GIT_WORKTREE: canonicalMain,
        TREEPORT_PROJECT_ID: project.id,
        TREEPORT_WORKTREE_ID: linked.id,
        TREEPORT_TERMINAL_ID: terminal.id
      }
    })

    const resolvedShell = linkedDefinitions.definitions.find(
      (definition) => definition.shellCommand === 'echo one'
    )
    if (!resolvedShell?.shellCommand || !resolvedShell.cwd) {
      throw new Error('Shell Zed preset was not resolved')
    }

    const shellTerminal = await service.createTerminal(
      linked.id,
      resolvedShell.name,
      undefined,
      {
        shellCommand: resolvedShell.shellCommand,
        cwd: resolvedShell.cwd,
        env: resolvedShell.env,
        returnToShell: true
      }
    )
    expect(shellTerminal).toMatchObject({
      argv: ['/bin/zsh', '-lc', 'echo one'],
      shellCommand: 'echo one',
      interactiveShell: false
    })
    expect(runner.terminalCreateInputs.get(shellTerminal.id)).toMatchObject({
      argv: ['/bin/zsh', '-lc', 'echo one'],
      fallbackArgv: ['/bin/zsh', '-l']
    })

    await fs.writeFile(configPath, '{ invalid json')
    const malformed = await service.listTerminalPresetDefinitions({
      worktreeId: mainWorktree.id
    })
    expect(malformed.definitions.map((definition) => definition.name)).toEqual([
      `Shared ${canonicalMain}`,
      'Duplicate',
      'Duplicate',
      'Development'
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
    const fixed = await service.listTerminalPresetDefinitions({
      worktreeId: mainWorktree.id
    })
    expect(fixed.definitions.map((definition) => definition.name)).toEqual([
      'Fixed immediately',
      `Shared ${canonicalMain}`,
      'Duplicate',
      'Duplicate',
      'Development'
    ])
    expect(fixed.diagnostics).toEqual([])

    await fs.writeFile(path.join(main, '.zed', 'tasks.json'), '{ invalid json')
    const malformedZed = await service.listTerminalPresetDefinitions({
      worktreeId: mainWorktree.id
    })
    expect(
      malformedZed.definitions.map((definition) => definition.name)
    ).toEqual(['Fixed immediately', 'Development'])
    expect(malformedZed.diagnostics).toEqual([
      expect.objectContaining({
        path: path.join('.zed', 'tasks.json'),
        itemId: null,
        message: expect.stringContaining('Could not load Zed tasks')
      })
    ])

    await fs.writeFile(
      path.join(main, '.zed', 'tasks.json'),
      JSON.stringify([{ label: 'Recovered Zed task', command: 'recovered' }])
    )
    expect(
      (
        await service.listTerminalPresetDefinitions({
          worktreeId: mainWorktree.id
        })
      ).definitions.map((definition) => definition.name)
    ).toEqual(['Fixed immediately', 'Recovered Zed task', 'Development'])
  })

  it('discovers local web panels and owns their persistent synchronized lifecycle', async () => {
    const { main, service, database } = await fixture()
    const webPanels = path.join(main, '.treeport', 'web-panels')
    const reviewPanel = path.join(webPanels, 'review')
    await fs.mkdir(reviewPanel, { recursive: true })
    await fs.writeFile(path.join(reviewPanel, 'index.html'), '<h1>Review</h1>')
    await fs.writeFile(path.join(reviewPanel, 'icon.svg'), '<svg/>')
    const codeReviewPanel = path.join(webPanels, 'code-review')
    await fs.mkdir(codeReviewPanel)
    await fs.writeFile(
      path.join(codeReviewPanel, 'index.html'),
      '<h1>Code review</h1>'
    )
    const outsideIcon = path.join(webPanels, 'outside-icon.svg')
    await fs.writeFile(outsideIcon, '<svg/>')
    await fs.symlink(outsideIcon, path.join(codeReviewPanel, 'icon.svg'))
    await fs.mkdir(path.join(webPanels, 'missing-entry'))
    const project = await service.registerProject(main)
    const worktree = project.worktrees[0]!
    expect(await service.listWebPanelDefinitions(worktree.id)).toEqual([
      {
        id: 'project:code-review',
        icon: null,
        source: { type: 'project' },
        permissions: [],
        permissionsGranted: true,
        sandbox: { allowSameOrigin: false },
        title: 'Code review'
      },
      {
        id: 'project:review',
        icon: 'data:image/svg+xml;base64,PHN2Zy8+',
        source: { type: 'project' },
        permissions: [],
        permissionsGranted: true,
        sandbox: { allowSameOrigin: false },
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
      terminalHost: new TerminalHostDouble(runner),
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
    // SAFETY: The test fixture provides the asserted contract used here.
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

  it('scopes web panel grants to the package source and permission set', async () => {
    const { root, main, service } = await fixture()
    const packageRoot = path.join(root, 'packages', 'privileged-panel')
    const panelRoot = path.join(packageRoot, 'web-panels', 'dashboard')
    await Promise.all([
      fs.mkdir(panelRoot, { recursive: true }),
      fs.mkdir(path.join(main, '.treeport'), { recursive: true })
    ])
    await Promise.all([
      fs.writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({
          name: '@treeport/privileged-panel',
          keywords: ['treeport-package'],
          treeport: {
            webPanels: [
              {
                source: './web-panels/dashboard',
                permissions: ['same-origin']
              }
            ]
          }
        })
      ),
      fs.writeFile(path.join(panelRoot, 'index.html'), '<h1>Dashboard</h1>'),
      fs.writeFile(
        path.join(main, '.treeport', 'settings.json'),
        JSON.stringify({ packages: [packageRoot] })
      )
    ])

    const project = await service.registerProject(main)
    const worktree = project.worktrees[0]!
    const definition = (
      await service.listWebPanelDefinitions(worktree.id)
    ).find((candidate) => candidate.title === 'Dashboard')!
    expect(definition).toMatchObject({
      permissions: ['same-origin'],
      permissionsGranted: false,
      sandbox: { allowSameOrigin: true }
    })
    await expect(
      service.createWebPanel(worktree.id, definition.id)
    ).rejects.toMatchObject({
      code: 'WEB_PANEL_PERMISSION_REQUIRED',
      details: { permissions: ['same-origin'] }
    })
    await expect(
      service.setWebPanelPermissionGrant(worktree.id, definition.id, true, [])
    ).rejects.toMatchObject({ code: 'WEB_PANEL_PERMISSIONS_CHANGED' })

    await service.setWebPanelPermissionGrant(
      worktree.id,
      definition.id,
      true,
      definition.permissions
    )
    await expect(
      service.createWebPanel(worktree.id, definition.id)
    ).resolves.toMatchObject({
      kind: 'web',
      permissions: ['same-origin'],
      sandbox: { allowSameOrigin: true }
    })

    await service.removePackage(packageRoot, project.id)
    await service.installPackage(packageRoot, project.id)
    expect(
      (await service.listWebPanelDefinitions(worktree.id)).find(
        (candidate) => candidate.id === definition.id
      )
    ).toMatchObject({ permissionsGranted: false })
  })

  it('edits existing tree files only with an exact granted permission', async () => {
    const { root, main, runner, service } = await fixture()
    runner.headExists = false
    const folder = path.join(main, 'editable folder')
    const packageRoot = path.join(root, 'packages', 'files-panel')
    const panelRoot = path.join(packageRoot, 'web-panels', 'files')
    await Promise.all([
      fs.mkdir(path.join(folder, '.treeport'), { recursive: true }),
      fs.mkdir(path.join(folder, 'src'), { recursive: true }),
      fs.mkdir(path.join(folder, '.git'), { recursive: true }),
      fs.mkdir(panelRoot, { recursive: true })
    ])
    await Promise.all([
      fs.writeFile(
        path.join(folder, 'src', 'app.ts'),
        'export const value = 1\n'
      ),
      fs.writeFile(path.join(folder, 'src', 'untracked.txt'), 'untracked\n'),
      fs.writeFile(path.join(folder, 'binary.bin'), Buffer.from([0xff, 0x00])),
      fs.writeFile(
        path.join(folder, 'oversized.txt'),
        Buffer.alloc(TREE_FILE_MAX_BYTES + 1, 97)
      ),
      fs.writeFile(path.join(folder, '.git', 'config'), 'hidden\n'),
      fs.writeFile(path.join(panelRoot, 'index.html'), '<h1>Files</h1>'),
      fs.writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({
          name: '@treeport/files-panel',
          keywords: ['treeport-package'],
          treeport: {
            webPanels: [
              {
                source: './web-panels/files',
                permissions: ['tree-files']
              }
            ]
          }
        })
      ),
      fs.writeFile(
        path.join(folder, '.treeport', 'settings.json'),
        JSON.stringify({ packages: [packageRoot] })
      )
    ])
    await fs.chmod(path.join(folder, 'src', 'app.ts'), 0o755)
    const outside = path.join(root, 'outside.txt')
    await fs.writeFile(outside, 'outside\n')
    await fs.symlink(outside, path.join(folder, 'escape.txt'))

    const project = await service.registerProject(folder)
    const worktree = project.worktrees[0]!
    const definition = (
      await service.listWebPanelDefinitions(worktree.id)
    ).find((candidate) => candidate.title === 'Files')!
    expect(definition).toMatchObject({
      permissions: ['tree-files'],
      permissionsGranted: false,
      sandbox: { allowSameOrigin: false }
    })
    await service.setWebPanelPermissionGrant(
      worktree.id,
      definition.id,
      true,
      definition.permissions
    )
    const panel = await service.createWebPanel(worktree.id, definition.id)
    await service.setWebPanelPermissionGrant(
      worktree.id,
      definition.id,
      false,
      definition.permissions
    )
    await expect(service.listTreeFiles(panel.id)).rejects.toMatchObject({
      code: 'WEB_PANEL_PERMISSION_REQUIRED'
    })

    await service.setWebPanelPermissionGrant(
      worktree.id,
      definition.id,
      true,
      definition.permissions
    )
    await expect(service.listTreeFiles(panel.id)).resolves.toEqual({
      paths: [
        '.treeport/settings.json',
        'binary.bin',
        'oversized.txt',
        'src/app.ts',
        'src/untracked.txt'
      ],
      truncated: false
    })

    const opened = await service.readTreeFile(panel.id, 'src/app.ts')
    expect(opened).toMatchObject({
      path: 'src/app.ts',
      content: 'export const value = 1\n'
    })
    const saved = await service.writeTreeFile(panel.id, {
      path: opened.path,
      content: 'export const value = 2\n',
      expectedRevision: opened.revision
    })
    expect(await fs.readFile(path.join(folder, 'src', 'app.ts'), 'utf8')).toBe(
      'export const value = 2\n'
    )
    expect(
      (await fs.stat(path.join(folder, 'src', 'app.ts'))).mode & 0o777
    ).toBe(0o755)
    await expect(
      service.writeTreeFile(panel.id, {
        path: opened.path,
        content: 'stale\n',
        expectedRevision: opened.revision
      })
    ).rejects.toMatchObject({ code: 'TREE_FILE_CHANGED', status: 409 })
    expect(await fs.readFile(path.join(folder, 'src', 'app.ts'), 'utf8')).toBe(
      'export const value = 2\n'
    )

    const concurrent = await Promise.allSettled([
      service.writeTreeFile(panel.id, {
        path: opened.path,
        content: 'first\n',
        expectedRevision: saved.revision
      }),
      service.writeTreeFile(panel.id, {
        path: opened.path,
        content: 'second\n',
        expectedRevision: saved.revision
      })
    ])
    expect(
      concurrent.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1)
    expect(
      concurrent.filter((result) => result.status === 'rejected')
    ).toHaveLength(1)

    await expect(
      service.readTreeFile(panel.id, '../outside.txt')
    ).rejects.toMatchObject({ code: 'INVALID_TREE_FILE_PATH' })
    await expect(
      service.readTreeFile(panel.id, 'escape.txt')
    ).rejects.toMatchObject({ code: 'INVALID_TREE_FILE_PATH' })
    await expect(
      service.readTreeFile(panel.id, 'binary.bin')
    ).rejects.toMatchObject({ code: 'TREE_FILE_UNSUPPORTED' })
    await expect(
      service.readTreeFile(panel.id, 'oversized.txt')
    ).rejects.toMatchObject({ code: 'TREE_FILE_TOO_LARGE' })
    await expect(
      service.readTreeFile(panel.id, 'missing.txt')
    ).rejects.toMatchObject({ code: 'TREE_FILE_NOT_FOUND' })

    await fs.writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@treeport/files-panel',
        keywords: ['treeport-package'],
        treeport: { webPanels: ['./web-panels/files'] }
      })
    )
    await service.reloadPackages(project.id)
    await expect(
      service.readTreeFile(panel.id, 'src/app.ts')
    ).rejects.toMatchObject({ code: 'WEB_PANEL_TREE_FILES_REQUIRED' })
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
      terminalHost: new TerminalHostDouble(runner),
      gh: new GhAdapter(runner)
    })
    expect(await reconstructed.listTerminalPresets()).toEqual([updated])
  })
})
