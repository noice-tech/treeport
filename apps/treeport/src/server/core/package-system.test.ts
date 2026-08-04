import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppConfig } from './config'
import {
  SpawnCommandRunner,
  type CommandRequest,
  type CommandResult,
  type CommandRunner
} from './command'
import { PackageSystem } from './package-system'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

async function rootFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport packages '))
  directories.push(root)
  const dataDir = path.join(root, 'data')
  const projectA = path.join(root, 'project-a')
  const projectB = path.join(root, 'project-b')
  await Promise.all([
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(path.join(projectA, '.treeport'), { recursive: true }),
    fs.mkdir(path.join(projectB, '.treeport'), { recursive: true })
  ])
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 8733,
    databasePath: path.join(dataDir, 'treeport.db'),
    dataDir,
    cacheDir: path.join(root, 'cache'),
    runtimeDir: path.join(root, 'runtime'),
    shell: '/bin/sh',
    tmuxPath: 'tmux',
    gitPath: 'git',
    ghPath: 'gh',
    apiUrl: 'http://127.0.0.1:8733',
    daemonLifecycle: 'external'
  }
  const projects = [
    { id: 'project-a', name: 'A', mainWorktreePath: projectA },
    { id: 'project-b', name: 'B', mainWorktreePath: projectB }
  ]
  return { root, dataDir, projectA, projectB, config, projects }
}

async function writeLocalPackage(packageRoot: string) {
  await Promise.all([
    fs.mkdir(path.join(packageRoot, 'web-panels', 'review'), {
      recursive: true
    }),
    fs.mkdir(path.join(packageRoot, 'web-panels', 'legacy'), {
      recursive: true
    }),
    fs.mkdir(path.join(packageRoot, 'terminal-presets'), { recursive: true })
  ])
  await Promise.all([
    fs.writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@acme/treeport-tools',
        treeport: {
          webPanels: ['./web-panels/*', '!./web-panels/legacy'],
          terminalPresets: ['./terminal-presets/*.json']
        }
      })
    ),
    fs.writeFile(
      path.join(packageRoot, 'web-panels', 'review', 'index.html'),
      '<h1>Review</h1>'
    ),
    fs.writeFile(
      path.join(packageRoot, 'web-panels', 'legacy', 'index.html'),
      '<h1>Legacy</h1>'
    ),
    fs.writeFile(
      path.join(packageRoot, 'terminal-presets', 'dev.json'),
      JSON.stringify({
        name: 'Development server',
        executable: 'pnpm',
        args: ['dev'],
        closeOnSuccess: false
      })
    ),
    fs.writeFile(
      path.join(packageRoot, 'terminal-presets', 'once.json'),
      JSON.stringify({
        name: 'One shot',
        executable: 'node',
        args: ['script.js'],
        closeOnSuccess: true
      })
    )
  ])
}

class UnexpectedRunner implements CommandRunner {
  async run(request: CommandRequest): Promise<CommandResult> {
    throw new Error(
      `Unexpected command: ${request.executable} ${request.args.join(' ')}`
    )
  }
}

class ManagedNpmDouble implements CommandRunner {
  readonly calls: CommandRequest[] = []
  failNextInstall = false

  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request)
    const args = [...request.args]
    const install = args.includes('install')
    const uninstall = args.includes('uninstall')
    const prefixIndex = args.indexOf('--prefix')
    const installRoot = prefixIndex === -1 ? undefined : args[prefixIndex + 1]
    if (!installRoot || (!install && !uninstall)) {
      return { stdout: '', stderr: 'unexpected npm command', exitCode: 1 }
    }

    const spec = install
      ? args[args.indexOf('install') + 1]!
      : args[args.indexOf('uninstall') + 1]!
    const name = spec.startsWith('@')
      ? spec.lastIndexOf('@') > spec.indexOf('/')
        ? spec.slice(0, spec.lastIndexOf('@'))
        : spec
      : spec.split('@')[0]!
    const packageRoot = path.join(installRoot, 'node_modules', name)
    if (uninstall) {
      await fs.rm(packageRoot, { recursive: true, force: true })
      return { stdout: '', stderr: '', exitCode: 0 }
    }

    if (this.failNextInstall) {
      this.failNextInstall = false
      return { stdout: '', stderr: 'registry unavailable', exitCode: 1 }
    }

    const version = spec.endsWith('@1.0.0')
      ? '1.0.0'
      : spec.endsWith('@latest')
        ? '2.0.0'
        : '1.0.0'
    await fs.mkdir(path.join(packageRoot, 'web-panels', 'review'), {
      recursive: true
    })
    await fs.mkdir(path.join(packageRoot, 'terminal-presets'), {
      recursive: true
    })
    await Promise.all([
      fs.writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name, version })
      ),
      fs.writeFile(
        path.join(packageRoot, 'web-panels', 'review', 'index.html'),
        `<h1>${version}</h1>`
      ),
      fs.writeFile(
        path.join(packageRoot, 'terminal-presets', 'dev.json'),
        JSON.stringify({
          name: `Dev ${version}`,
          executable: 'pnpm',
          args: ['dev'],
          closeOnSuccess: false
        })
      )
    ])
    return { stdout: '', stderr: '', exitCode: 0 }
  }
}

describe('PackageSystem', () => {
  it('combines global and main-worktree package settings with filtering, project overrides, deltas, and resilient reloads', async () => {
    const { root, dataDir, projectA, config, projects } = await rootFixture()
    const packageRoot = path.join(root, 'local tools')
    const repositoryPackageRoot = path.join(root, 'repository tools')
    await writeLocalPackage(packageRoot)
    await fs.mkdir(
      path.join(repositoryPackageRoot, 'web-panels', 'repository'),
      { recursive: true }
    )
    await fs.mkdir(path.join(repositoryPackageRoot, 'terminal-presets'), {
      recursive: true
    })
    await Promise.all([
      fs.writeFile(
        path.join(
          repositoryPackageRoot,
          'web-panels',
          'repository',
          'index.html'
        ),
        '<h1>Repository</h1>'
      ),
      fs.writeFile(
        path.join(repositoryPackageRoot, 'terminal-presets', 'repository.json'),
        JSON.stringify({
          name: 'Repository command',
          executable: 'repo-tool',
          args: [],
          closeOnSuccess: false
        })
      )
    ])
    await fs.writeFile(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({
        packages: [
          {
            source: packageRoot,
            terminalPresets: ['terminal-presets/dev.json']
          }
        ]
      })
    )
    await fs.writeFile(
      path.join(projectA, '.treeport', 'settings.json'),
      JSON.stringify({
        packages: [
          {
            source: packageRoot,
            autoload: false,
            webPanels: ['-web-panels/review'],
            terminalPresets: ['+terminal-presets/once.json']
          },
          repositoryPackageRoot
        ]
      })
    )

    const packages = new PackageSystem(config, new UnexpectedRunner())
    await packages.initialize(projects)

    const globalPanel = (await packages.webPanelDefinitions('project-b'))[0]!
    expect(globalPanel.definition).toMatchObject({
      id: expect.stringMatching(
        /^package:local:[a-f0-9]{16}:web-panel:review$/
      ),
      title: 'Review',
      source: { type: 'package', scope: 'global' }
    })
    expect(
      (await packages.terminalPresetDefinitions('project-b')).map(
        (preset) => preset.name
      )
    ).toEqual(['Development server'])
    expect(
      (await packages.webPanelDefinitions('project-a')).map(
        (panel) => panel.definition.title
      )
    ).toEqual(['Repository'])
    expect(
      (await packages.terminalPresetDefinitions('project-a')).map(
        (preset) => preset.name
      )
    ).toEqual(['Development server', 'One shot', 'Repository command'])
    expect(
      (await packages.webPanelDefinitions('project-b')).map(
        (panel) => panel.definition.title
      )
    ).not.toContain('Repository')

    await fs.writeFile(
      path.join(projectA, '.treeport', 'settings.json'),
      JSON.stringify({
        packages: [
          {
            source: packageRoot,
            webPanels: [],
            terminalPresets: ['terminal-presets/once.json']
          }
        ]
      })
    )
    await packages.reload('project-a')
    expect(await packages.webPanelDefinitions('project-a')).toEqual([])
    expect(
      (await packages.terminalPresetDefinitions('project-a')).map(
        (preset) => preset.name
      )
    ).toEqual(['One shot'])
    expect(
      (await packages.terminalPresetDefinitions('project-b')).map(
        (preset) => preset.name
      )
    ).toEqual(['Development server'])

    const durableId = globalPanel.definition.id
    await fs.writeFile(
      path.join(packageRoot, 'web-panels', 'review', 'index.html'),
      '<h1>Changed without copying</h1>'
    )
    await fs.writeFile(
      path.join(packageRoot, 'terminal-presets', 'dev.json'),
      '{ malformed'
    )
    const reload = await packages.reload()
    expect(
      (await packages.webPanelDefinitions('project-b'))[0]?.definition.id
    ).toBe(durableId)
    expect(await packages.terminalPresetDefinitions('project-b')).toEqual([])
    expect(reload.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceType: 'terminal-preset',
          message: expect.stringContaining('Could not parse terminal preset')
        })
      ])
    )

    await fs.writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@acme/treeport-tools', treeport: 'invalid' })
    )
    const malformedManifest = await packages.reload()
    expect(
      (await packages.webPanelDefinitions('project-b'))[0]?.definition.id
    ).toBe(durableId)
    expect(malformedManifest.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining(
            'treeport manifest must be an object'
          )
        })
      ])
    )
    await fs.writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@acme/treeport-tools',
        treeport: {
          webPanels: ['./web-panels/*', '!./web-panels/legacy'],
          terminalPresets: ['./terminal-presets/*.json']
        }
      })
    )

    const restarted = new PackageSystem(config, new UnexpectedRunner())
    await restarted.initialize(projects)
    expect(
      (await restarted.webPanelDefinitions('project-b'))[0]?.definition.id
    ).toBe(durableId)
    expect(await restarted.webPanelDefinitions('project-a')).toEqual([])

    await fs.writeFile(path.join(dataDir, 'settings.json'), '{ broken')
    await packages.reload()
    expect(
      (await packages.webPanelDefinitions('project-b'))[0]?.definition.id
    ).toBe(durableId)
    expect((await packages.list()).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: path.join(dataDir, 'settings.json'),
          message: expect.stringContaining('Could not parse')
        })
      ])
    )
  })

  it('installs npm packages with lifecycle scripts disabled', async () => {
    const { root, dataDir, config, projects } = await rootFixture()
    const packageRoot = path.join(root, 'npm lifecycle fixture')
    await writeLocalPackage(packageRoot)
    await fs.writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'treeport-lifecycle-fixture',
        version: '1.0.0',
        scripts: {
          postinstall:
            "node -e \"require('fs').writeFileSync('LIFECYCLE_RAN','yes')\""
        },
        treeport: {
          webPanels: ['./web-panels/*'],
          terminalPresets: ['./terminal-presets/*.json']
        }
      })
    )
    await fs.writeFile(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({
        packages: [`npm:treeport-lifecycle-fixture@file:${packageRoot}`]
      })
    )

    const packages = new PackageSystem(config, new SpawnCommandRunner())
    await packages.initialize(projects)

    expect(
      (await packages.terminalPresetDefinitions('project-a')).map(
        (preset) => preset.name
      )
    ).toEqual(['Development server', 'One shot'])
    await expect(
      fs.stat(path.join(packageRoot, 'LIFECYCLE_RAN'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      fs.stat(
        path.join(
          dataDir,
          'npm',
          'node_modules',
          'treeport-lifecycle-fixture',
          'LIFECYCLE_RAN'
        )
      )
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reconciles managed npm projects without scripts or implicit updates and updates only eligible sources', async () => {
    const { dataDir, config, projects } = await rootFixture()
    await fs.writeFile(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({
        npmCommand: ['npm'],
        packages: ['npm:@acme/tools', 'npm:@acme/pinned@1.0.0']
      })
    )
    const runner = new ManagedNpmDouble()
    const packages = new PackageSystem(config, runner)
    await packages.initialize(projects)

    expect(runner.calls).toHaveLength(2)
    expect(
      runner.calls.every((call) => call.args.includes('--ignore-scripts'))
    ).toBe(true)
    expect(
      await fs.readFile(path.join(dataDir, 'npm', '.gitignore'), 'utf8')
    ).toBe('*\n!.gitignore\n')
    const initialDefinition = (
      await packages.webPanelDefinitions('project-a')
    ).find((panel) => panel.definition.id.includes('npm:@acme/tools'))!
      .definition.id

    await packages.reload()
    expect(runner.calls).toHaveLength(2)

    const results = await packages.update()
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'npm:@acme/tools',
          status: 'updated'
        }),
        expect.objectContaining({
          source: 'npm:@acme/pinned@1.0.0',
          status: 'skipped',
          reason: 'Exact npm versions are pinned'
        })
      ])
    )
    expect(runner.calls).toHaveLength(3)
    expect(runner.calls[2]?.args).toContain('@acme/tools@latest')
    expect(
      (await packages.webPanelDefinitions('project-a')).find((panel) =>
        panel.definition.id.includes('npm:@acme/tools')
      )?.definition.id
    ).toBe(initialDefinition)

    runner.failNextInstall = true
    await expect(packages.update('npm:@acme/tools')).rejects.toThrow(
      'registry unavailable'
    )
    expect(
      (await packages.webPanelDefinitions('project-a')).find((panel) =>
        panel.definition.id.includes('npm:@acme/tools')
      )?.definition.id
    ).toBe(initialDefinition)

    await fs.writeFile(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({
        npmCommand: ['npm'],
        packages: [
          'npm:@acme/tools',
          'npm:@acme/pinned@1.0.0',
          'npm:@acme/unavailable'
        ]
      })
    )
    runner.failNextInstall = true
    const failedInstall = await packages.reload()
    expect(failedInstall.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'npm:@acme/unavailable',
          message: expect.stringContaining('registry unavailable')
        })
      ])
    )
    expect(
      (await packages.webPanelDefinitions('project-b')).find((panel) =>
        panel.definition.id.includes('npm:@acme/tools')
      )?.definition.id
    ).toBe(initialDefinition)

    await fs.rm(path.join(dataDir, 'npm', 'node_modules', '@acme', 'tools'), {
      recursive: true,
      force: true
    })
    await packages.reload()
    expect(runner.calls.at(-1)?.args).toContain('--ignore-scripts')
    expect(
      (await packages.terminalPresetDefinitions('project-b')).map(
        (preset) => preset.name
      )
    ).toEqual(expect.arrayContaining(['Dev 1.0.0']))
  })
})
