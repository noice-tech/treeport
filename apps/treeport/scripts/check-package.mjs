#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const directory = fileURLToPath(new URL('..', import.meta.url))
const sdkDirectory = path.resolve(directory, '../../packages/panel-sdk')
const packed = process.argv.includes('--packed')

// The build uses only the local output check. The gate also checks real pnpm
// tarballs, with lifecycle scripts disabled to avoid prepack -> build recursion.
// Neither mode installs dependencies or proves end-to-end npm update wiring.
async function checkPackage(packageDirectory, published, sdkVersion) {
  const manifest = JSON.parse(
    await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8')
  )
  const cli = manifest.name === '@treeport/treeport'
  assert(cli || manifest.name === '@treeport/panel-sdk', 'Unexpected package')
  for (const kind of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'devDependencies'
  ]) {
    for (const [name, version] of Object.entries(manifest[kind] ?? {})) {
      if (kind !== 'devDependencies') {
        assert(
          !/^(?:electron(?:$|-)|@electron(?:-forge)?\/)/.test(name),
          `Electron runtime dependency: ${name}`
        )
      }

      if (published) {
        assert(
          !/^(?:workspace:|catalog:|link:|file:)/.test(version),
          `Unresolved published dependency ${name}: ${version}`
        )
      } else if (
        kind !== 'devDependencies' &&
        String(version).startsWith('workspace:')
      ) {
        assert(
          name === '@treeport/panel-sdk' && version === 'workspace:*',
          `Published dependency ${name} uses ${version}`
        )
      }
    }
  }

  const required = cli
    ? [
        'bin/treeport.mjs',
        'dist/node/cli/index.js',
        'dist/node/server/index.js',
        'dist/node/server/core/launcher.js',
        'dist/web/index.html',
        'drizzle/0000_public_baseline.sql',
        'drizzle/meta/_journal.json',
        'skills/treeport/SKILL.md',
        'LICENSE',
        'README.md'
      ]
    : ['dist/index.js', 'dist/index.d.ts', 'LICENSE', 'README.md']
  for (const file of required) {
    assert(
      (await fs.stat(path.join(packageDirectory, file))).size > 0,
      `Empty required file: ${file}`
    )
  }
  assert.equal(manifest.main, cli ? 'dist/node/cli/index.js' : 'dist/index.js')
  if (cli) {
    assert.deepEqual(manifest.bin, { treeport: 'bin/treeport.mjs' })
    assert.equal(
      manifest.dependencies['@treeport/panel-sdk'],
      published ? sdkVersion : 'workspace:*'
    )
    for (const entrypoint of [
      manifest.bin.treeport,
      manifest.main,
      'dist/node/server/core/launcher.js'
    ]) {
      const entrypointPath = path.join(packageDirectory, entrypoint)
      // pnpm normalizes non-bin modes; the CLI and daemon launcher run via Node.
      if (entrypoint === manifest.bin.treeport) {
        assert(
          (await fs.stat(entrypointPath)).mode & 0o111,
          `Entrypoint must be executable: ${entrypoint}`
        )
      }

      assert(
        (await fs.readFile(entrypointPath, 'utf8')).startsWith(
          '#!/usr/bin/env node\n'
        ),
        `Entrypoint must have a Node shebang: ${entrypoint}`
      )
    }
    const binSource = await fs.readFile(
      path.join(packageDirectory, manifest.bin.treeport),
      'utf8'
    )
    assert(
      binSource.includes('TREEPORT_CLI_ENTRYPOINT'),
      'The CLI must preserve its stable bin entrypoint'
    )
    assert.equal(
      await fs.readFile(
        path.join(packageDirectory, 'skills/treeport/SKILL.md'),
        'utf8'
      ),
      await fs.readFile(
        path.resolve(directory, '../../skills/treeport/SKILL.md'),
        'utf8'
      ),
      'The packaged CLI skill must match the Treeport skill'
    )
    const journal = JSON.parse(
      await fs.readFile(
        path.join(packageDirectory, 'drizzle/meta/_journal.json'),
        'utf8'
      )
    )
    assert(journal.entries.length > 0, 'Missing migration history')
    for (const entry of journal.entries) {
      assert(
        (
          await fs.stat(
            path.join(packageDirectory, 'drizzle', `${entry.tag}.sql`)
          )
        ).size > 0,
        `Missing migration: ${entry.tag}`
      )
    }
    const html = await fs.readFile(
      path.join(packageDirectory, 'dist/web/index.html'),
      'utf8'
    )
    assert(html.includes('<div id="root"></div>'), 'Missing web app root')
    const assets = [...html.matchAll(/(?:src|href)="(\/[^"#?]+)"/g)].map(
      (match) => match[1]
    )
    assert(
      assets.some((asset) => asset.endsWith('.js')),
      'Missing web JavaScript'
    )
    assert(
      assets.some((asset) => asset.endsWith('.css')),
      'Missing web styles'
    )
    for (const asset of assets) {
      assert(
        (await fs.stat(path.join(packageDirectory, 'dist/web', asset))).size >
          0,
        `Missing web asset: ${asset}`
      )
    }
  } else {
    assert.equal(manifest.types, 'dist/index.d.ts')
    assert.deepEqual(manifest.exports, {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' }
    })
  }

  const files = await fs.readdir(
    published ? packageDirectory : path.join(packageDirectory, 'dist'),
    { recursive: true }
  )
  const forbidden = files.filter(
    (file) =>
      /(?:^|\/)(?:tests?|__tests__|fixtures|apps\/desktop|\.vite|electron(?:-forge)?)(?:\/|$)/.test(
        file
      ) ||
      /(?:^|[/.])(?:test|spec)\.[cm]?[jt]sx?$|\.(?:map|tsbuildinfo)$/.test(file)
  )
  assert.deepEqual(
    forbidden,
    [],
    'Publish output contains tests, build metadata or desktop content'
  )
  if (cli) {
    const privateWorkspaceImports = []
    for (const file of files.filter((file) => file.endsWith('.js'))) {
      const source = await fs.readFile(
        path.join(
          published ? packageDirectory : path.join(packageDirectory, 'dist'),
          file
        ),
        'utf8'
      )
      if (source.includes('@treeport/shared')) {
        privateWorkspaceImports.push(file)
      }
    }
    assert.deepEqual(
      privateWorkspaceImports,
      [],
      'Publish output imports the private @treeport/shared workspace package'
    )
  }

  return manifest
}

if (!packed) {
  const manifest = await checkPackage(directory, false, null)
  console.log(
    `Build output checks passed for ${manifest.name}@${manifest.version}`
  )
} else {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'treeport-package-contract-')
  )
  try {
    const manifests = []
    for (const source of [sdkDirectory, directory]) {
      const sourceManifest = JSON.parse(
        await fs.readFile(path.join(source, 'package.json'), 'utf8')
      )
      await execute(
        'pnpm',
        [
          '--config.ignore-scripts=true',
          'pack',
          '--pack-destination',
          temporaryDirectory
        ],
        { cwd: source }
      )
      const tarball = path.join(
        temporaryDirectory,
        `${sourceManifest.name.replace('@', '').replace('/', '-')}-${sourceManifest.version}.tgz`
      )
      const extracted = path.join(
        temporaryDirectory,
        sourceManifest.name.split('/')[1]
      )
      await fs.mkdir(extracted)
      await execute('tar', ['-xzf', tarball, '-C', extracted])
      const manifest = await checkPackage(
        path.join(extracted, 'package'),
        true,
        manifests[0]?.version
      )
      assert.equal(manifest.name, sourceManifest.name)
      assert.equal(manifest.version, sourceManifest.version)
      manifests.push(manifest)
    }
    console.log(
      `Packed artifact checks passed for ${manifests.map((manifest) => `${manifest.name}@${manifest.version}`).join(' and ')} (no npm installation or daemon)`
    )
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
  }
}
