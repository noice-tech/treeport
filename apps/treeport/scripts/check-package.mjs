#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const manifest = JSON.parse(
  await fs.readFile(path.join(directory, 'package.json'), 'utf8')
)
const dependencies = {
  ...manifest.dependencies,
  ...manifest.optionalDependencies
}
for (const [name, version] of Object.entries(dependencies)) {
  if (!String(version).startsWith('workspace:')) {
    continue
  }

  if (name !== '@treeport/panel-sdk' || version !== 'workspace:*') {
    throw new Error(`Published dependency ${name} uses ${version}`)
  }
}

const required = [
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
await Promise.all(required.map((file) => fs.access(path.join(directory, file))))

const forbidden = []
async function inspect(current) {
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name)
    if (entry.isDirectory()) {
      await inspect(fullPath)
    } else if (
      entry.name.endsWith('.map') ||
      /(?:^|\.)test\.[cm]?[jt]sx?$/.test(entry.name) ||
      entry.name === '.tsbuildinfo'
    ) {
      forbidden.push(path.relative(directory, fullPath))
    }
  }
}

await inspect(path.join(directory, 'dist'))
if (forbidden.length) {
  throw new Error(
    `Publish output contains forbidden files:\n${forbidden.join('\n')}`
  )
}

console.log(`Package checks passed for ${manifest.name}@${manifest.version}`)
