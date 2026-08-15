#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
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
const [version = packageManifest.version, outputArgument = 'out', ...extra] =
  process.argv.slice(2)
if (
  extra.length > 0 ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
) {
  throw new Error(
    'Usage: node scripts/check-release.mjs [X.Y.Z] [forge-output-directory]'
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
const dmgFiles = paths.filter((entry) => entry.endsWith(`${expectedBase}.dmg`))
const zipFiles = paths.filter((entry) => entry.endsWith(`${expectedBase}.zip`))
const apps = paths.filter((entry) => entry.endsWith(`${path.sep}Treeport.app`))
if (dmgFiles.length !== 1 || zipFiles.length !== 1 || apps.length !== 1) {
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
  '/.vite/build/shell-preload.js',
  '/.vite/renderer/main_window/index.html'
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
  !mainBundle.includes('Treeport Update Ready')
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

console.log(
  `Verified Treeport ${version}: universal app, DMG, ZIP, package boundary, and Electron fuses`
)
