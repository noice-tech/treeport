#!/usr/bin/env node

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const temporaryDirectory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'treeport-pi-package-')
)

try {
  const manifest = JSON.parse(
    await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8')
  )
  if (manifest.pi?.extensions?.[0] !== './extensions/treeport/index.ts') {
    throw new Error('The Pi manifest must identify the Treeport extension')
  }

  if (manifest.pi?.skills?.[0] !== './skills/treeport') {
    throw new Error('The Pi manifest must identify the Treeport skill')
  }

  const packagedSkill = await fs.readFile(
    path.join(packageDirectory, 'skills/treeport/SKILL.md'),
    'utf8'
  )
  const canonicalSkill = await fs.readFile(
    path.join(packageDirectory, '../../skills/treeport/SKILL.md'),
    'utf8'
  )
  if (packagedSkill !== canonicalSkill) {
    throw new Error('The packaged Pi skill must match the Treeport skill')
  }

  for (const name of ['@earendil-works/pi-coding-agent', 'typebox']) {
    if (manifest.peerDependencies?.[name] !== '*') {
      throw new Error(`${name} must be a wildcard peer dependency`)
    }

    if (manifest.dependencies?.[name]) {
      throw new Error(`${name} must not be a runtime dependency`)
    }
  }

  await execute(
    'pnpm',
    [
      '--config.ignore-scripts=true',
      'pack',
      '--pack-destination',
      temporaryDirectory
    ],
    { cwd: packageDirectory }
  )
  const tarball = path.join(
    temporaryDirectory,
    `treeport-pi-${manifest.version}.tgz`
  )
  const files = (await execute('tar', ['-tzf', tarball])).stdout
    .trim()
    .split('\n')
    .sort()
  const required = [
    'package/LICENSE',
    'package/README.md',
    'package/extensions/treeport/index.ts',
    'package/extensions/treeport/treeport-cli.ts',
    'package/skills/treeport/SKILL.md',
    'package/package.json'
  ]
  for (const file of required) {
    if (!files.includes(file)) {
      throw new Error(`The npm tarball is missing ${file}`)
    }
  }

  const forbidden = files.find(
    (file) =>
      /(?:^|\/)node_modules(?:\/|$)/.test(file) ||
      /(?:^|\/)apps(?:\/|$)/.test(file) ||
      /(?:^|\/)(?:dist|dist-types)(?:\/|$)/.test(file) ||
      /(?:^|\.)test\.[cm]?[jt]sx?$/.test(file) ||
      file.endsWith('.map') ||
      file.endsWith('.tsbuildinfo') ||
      /(?:^|\/)(?:playwright|node-pty|electron)(?:\/|$)/.test(file)
  )
  if (forbidden) {
    throw new Error(`The npm tarball contains forbidden content: ${forbidden}`)
  }

  console.log(`Package checks passed for ${manifest.name}@${manifest.version}`)
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
}
