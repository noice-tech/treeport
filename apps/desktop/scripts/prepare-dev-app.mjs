import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const require = createRequire(import.meta.url)

// macOS reads the Dock label from the bundle, not app.setName(). Brand a local
// copy so other worktrees and Electron apps keep their original installation.
export async function prepareDevelopmentApp() {
  const electronExecutable = require('electron')
  const electronVersion = require('electron/package.json').version
  const icon = fileURLToPath(
    new URL('../assets/TreeportDev.icns', import.meta.url)
  )
  const fingerprint = createHash('sha256')
    .update(electronExecutable)
    .update(electronVersion)
    .update(await readFile(icon))
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest('hex')
    .slice(0, 16)
  const cache = fileURLToPath(
    new URL('../.treeport-dev/electron/', import.meta.url)
  )
  const distribution = path.join(cache, fingerprint)
  const ready = await access(distribution).then(
    () => true,
    () => false
  )

  if (!ready) {
    await mkdir(cache, { recursive: true })
    const temporary = await mkdtemp(path.join(cache, 'prepare-'))
    try {
      const bundle = path.join(temporary, 'Treeport Dev.app')
      await cp(path.resolve(electronExecutable, '../../..'), bundle, {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE
      })
      const plist = path.join(bundle, 'Contents/Info.plist')
      for (const [key, value] of [
        ['CFBundleName', 'Treeport Dev'],
        ['CFBundleDisplayName', 'Treeport Dev'],
        ['CFBundleIdentifier', 'tech.noice.treeport.dev'],
        ['CFBundleIconFile', 'electron.icns']
      ]) {
        await execute('plutil', ['-replace', key, '-string', value, plist])
      }
      await cp(icon, path.join(bundle, 'Contents/Resources/electron.icns'))
      await execute('codesign', ['--force', '--deep', '--sign', '-', bundle])
      await rename(temporary, distribution)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }

  // Forge gets its executable from require('electron'). Override only this
  // launcher's cached export: ELECTRON_OVERRIDE_DIST_PATH retains Electron.app
  // in the launch path, which macOS also uses for the Dock label.
  require.cache[require.resolve('electron')].exports = path.join(
    distribution,
    'Treeport Dev.app/Contents/MacOS/Electron'
  )
}
