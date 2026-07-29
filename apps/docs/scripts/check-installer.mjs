#!/usr/bin/env node
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)

const docsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const repositoryRoot = path.resolve(docsDirectory, '../..')
const [manifest, packageManifest, installer] = await Promise.all([
  fs
    .readFile(path.join(docsDirectory, 'public/install-manifest.json'), 'utf8')
    .then(JSON.parse),
  fs
    .readFile(path.join(repositoryRoot, 'packages/cli/package.json'), 'utf8')
    .then(JSON.parse),
  fs.readFile(path.join(docsDirectory, 'public/install.sh'), 'utf8')
])

if (
  manifest.package !== packageManifest.name ||
  manifest.treeportVersion !== packageManifest.version
) {
  throw new Error('Installer manifest and npm package identity/version differ')
}

for (const platform of Object.values(manifest.platforms)) {
  if (!installer.includes(platform.nodeArchiveSha256)) {
    throw new Error('Installer does not contain a manifest Node archive hash')
  }
}
if (!installer.includes(`TREEPORT_VERSION:-${manifest.treeportVersion}`)) {
  throw new Error('Installer and manifest Treeport versions differ')
}

if (!installer.includes(`TREEPORT_NODE_VERSION:-${manifest.nodeVersion}`)) {
  throw new Error('Installer and manifest Node versions differ')
}

const temporaryDirectory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'treeport-installer-check-')
)
try {
  await Promise.all([
    fs.writeFile(
      path.join(temporaryDirectory, 'uname'),
      '#!/bin/sh\ncase "$1" in\n  -s) echo Darwin ;;\n  -m) echo arm64 ;;\nesac\n',
      { mode: 0o755 }
    ),
    fs.writeFile(path.join(temporaryDirectory, 'git'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755
    })
  ])
  const result = await execute(
    '/bin/sh',
    [path.join(docsDirectory, 'public/install.sh')],
    {
      env: {
        HOME: temporaryDirectory,
        PATH: temporaryDirectory
      }
    }
  ).then(
    () => ({ succeeded: true, stderr: '' }),
    (error) => ({ succeeded: false, stderr: String(error.stderr) })
  )
  if (
    result.succeeded ||
    !result.stderr.includes('Install it with your preferred package manager')
  ) {
    throw new Error(
      'Installer must handle systems without Homebrew, MacPorts, or tmux'
    )
  }
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
}

console.log(
  `Installer checks passed for ${manifest.package}@${manifest.treeportVersion}`
)
