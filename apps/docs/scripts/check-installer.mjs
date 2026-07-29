#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

console.log(
  `Installer checks passed for ${manifest.package}@${manifest.treeportVersion}`
)
