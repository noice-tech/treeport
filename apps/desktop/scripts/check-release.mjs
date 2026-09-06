#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'
import electronFuses from '@electron/fuses'
import electronFuseConstants from '@electron/fuses/dist/constants.js'
import { z } from 'zod'

const { FuseV1Options, getCurrentFuseWire } = electronFuses
const { FuseState } = electronFuseConstants

const desktopDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const packageManifest = JSON.parse(
  readFileSync(path.join(desktopDirectory, 'package.json'), 'utf8')
)
const [
  version = packageManifest.version,
  outputArgument = 'out',
  teamId,
  ...extra
] = process.argv.slice(2)
if (
  extra.length > 0 ||
  !teamId ||
  !/^[A-Z0-9]{10}$/.test(teamId) ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
) {
  throw new Error(
    'Usage: node scripts/check-release.mjs <X.Y.Z> <forge-output-directory> <Apple-Team-ID>'
  )
}

const outputDirectory = path.resolve(desktopDirectory, outputArgument)
const paths = []
const visit = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    paths.push(entryPath)
    if (entry.isDirectory() && !entry.name.endsWith('.app')) {
      visit(entryPath)
    }
  }
}
visit(outputDirectory)

const expectedBase = `Treeport-${version}-darwin-universal`
const dmgFiles = paths.filter((entry) => entry.endsWith('.dmg'))
const zipFiles = paths.filter((entry) => entry.endsWith('.zip'))
const apps = paths.filter((entry) => entry.endsWith(`${path.sep}Treeport.app`))
if (
  dmgFiles.length !== 1 ||
  zipFiles.length !== 1 ||
  apps.length !== 1 ||
  path.basename(dmgFiles[0]) !== `${expectedBase}.dmg` ||
  path.basename(zipFiles[0]) !== `${expectedBase}.zip`
) {
  throw new Error(
    `Expected one universal app, DMG, and ZIP; found ${apps.length} app(s), ${dmgFiles.length} DMG(s), and ${zipFiles.length} ZIP(s)`
  )
}

for (const artifact of [...dmgFiles, ...zipFiles]) {
  if (statSync(artifact).size === 0) {
    throw new Error(`Release artifact is empty: ${artifact}`)
  }
}
const zipEntries = execFileSync('unzip', ['-Z1', zipFiles[0]], {
  encoding: 'utf8'
})
if (!zipEntries.split('\n').includes('Treeport.app/Contents/MacOS/Treeport')) {
  throw new Error('Updater ZIP does not contain the packaged Treeport app')
}

const appPath = apps[0]
const plistPath = path.join(appPath, 'Contents', 'Info.plist')
const plistValue = (key) =>
  execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plistPath], {
    encoding: 'utf8'
  }).trim()

if (plistValue('CFBundleIdentifier') !== 'tech.noice.treeport') {
  throw new Error('Packaged app has an unexpected bundle identifier')
}

const urlTypes = JSON.parse(
  execFileSync(
    'plutil',
    ['-extract', 'CFBundleURLTypes', 'json', '-o', '-', plistPath],
    { encoding: 'utf8' }
  )
)
const parsedUrlTypes = z
  .array(z.object({ CFBundleURLSchemes: z.array(z.string()) }))
  .safeParse(urlTypes)
if (
  !parsedUrlTypes.success ||
  !parsedUrlTypes.data.some((entry) =>
    entry.CFBundleURLSchemes.includes('treeport')
  )
) {
  throw new Error('Packaged app does not declare the treeport URL scheme')
}

if (plistValue('CFBundleShortVersionString') !== version) {
  throw new Error('Packaged app version does not match the release version')
}

const executable = path.join(appPath, 'Contents', 'MacOS', 'Treeport')
const architectures = new Set(
  execFileSync('lipo', ['-archs', executable], { encoding: 'utf8' })
    .trim()
    .split(/\s+/)
)
if (!architectures.has('arm64') || !architectures.has('x86_64')) {
  throw new Error(
    `Packaged app is not universal: ${[...architectures].join(', ')}`
  )
}

const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar')
const asarEntries = listPackage(asarPath)
const requiredEntries = [
  '/package.json',
  '/.vite/build/main.js',
  '/.vite/build/preload.js',
  '/.vite/renderer/main_window/index.html',
  '/node_modules/ws/index.js',
  '/node_modules/ws/package.json'
]
for (const required of requiredEntries) {
  if (!asarEntries.includes(required)) {
    throw new Error(`Packaged app is missing ${required}`)
  }
}
const forbiddenEntry = asarEntries.find(
  (entry) =>
    entry.startsWith('/src/') ||
    entry.startsWith('/e2e/') ||
    entry.includes('/migrations/') ||
    entry.endsWith('.map') ||
    /(?:^|\/)forge\.config\./.test(entry)
)
if (forbiddenEntry) {
  throw new Error(
    `Packaged app contains development/server content: ${forbiddenEntry}`
  )
}

const mainBundle = extractFile(asarPath, '.vite/build/main.js').toString()
if (
  !mainBundle.includes('https://update.electronjs.org') ||
  !mainBundle.includes('noice-tech/treeport') ||
  !mainBundle.includes('shell:install-update')
) {
  throw new Error('Packaged app is missing its automatic update integration')
}

const fuseWire = await getCurrentFuseWire(executable)
const expectedFuses = new Map([
  [FuseV1Options.RunAsNode, FuseState.DISABLE],
  [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE]
])
for (const [fuse, expected] of expectedFuses) {
  if (fuseWire[fuse] !== expected) {
    throw new Error(`Packaged app has an unsafe ${FuseV1Options[fuse]} fuse`)
  }
}

// Verify the distributed copies, not only Forge's loose application. Comparing
// every file also binds the ZIP/DMG to the version, architecture and fuse checks.
const temporary = mkdtempSync(path.join(os.tmpdir(), 'treeport-release-check-'))
const mount = path.join(temporary, 'dmg')
const extracted = path.join(temporary, 'zip')
mkdirSync(mount)
mkdirSync(extracted)
let mounted = false
try {
  execFileSync('ditto', ['-x', '-k', zipFiles[0], extracted])
  execFileSync('hdiutil', [
    'attach',
    '-readonly',
    '-nobrowse',
    '-noautoopen',
    '-mountpoint',
    mount,
    dmgFiles[0]
  ])
  mounted = true
  for (const copy of [
    path.join(extracted, 'Treeport.app'),
    path.join(mount, 'Treeport.app')
  ]) {
    execFileSync('diff', ['-qr', appPath, copy])
  }
  for (const signed of [
    appPath,
    path.join(extracted, 'Treeport.app'),
    path.join(mount, 'Treeport.app'),
    dmgFiles[0]
  ]) {
    execFileSync('codesign', ['--verify', '--deep', '--strict', signed])
    const identity = spawnSync(
      'codesign',
      ['--display', '--verbose=4', signed],
      { encoding: 'utf8' }
    )
    if (
      identity.status !== 0 ||
      !identity.stderr.split('\n').includes(`TeamIdentifier=${teamId}`) ||
      !identity.stderr.includes('Authority=Developer ID Application:')
    ) {
      throw new Error(
        'Artifact is not signed with the expected Developer ID team'
      )
    }

    execFileSync('xcrun', ['stapler', 'validate', signed])
    if (signed.endsWith('.app')) {
      execFileSync('spctl', ['--assess', '--type', 'execute', signed])
    }
  }
  execFileSync(
    process.execPath,
    [
      path.join(desktopDirectory, 'scripts/smoke-release.mjs'),
      path.join(extracted, 'Treeport.app'),
      version
    ],
    { stdio: 'inherit' }
  )
} finally {
  // If detach fails, leave the mount and report the failure. Never recurse into
  // a mounted volume during cleanup.
  if (mounted) {
    execFileSync('hdiutil', ['detach', mount])
  }

  rmSync(temporary, { recursive: true, force: true })
}

console.log(
  `Verified Treeport ${version}: signed/notarized universal app, DMG, ZIP, package boundary, Electron fuses, and isolated launch`
)
