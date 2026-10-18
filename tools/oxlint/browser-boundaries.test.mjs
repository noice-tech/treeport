import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, afterAll, expect, it } from 'vitest'

const oxlint = path.resolve('node_modules/.bin/oxlint')
let root
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'browser-boundaries-'))
  await mkdir(path.join(root, 'tools/oxlint'), { recursive: true })
  await mkdir(path.join(root, 'apps/treeport/src/server'), { recursive: true })
  await copyFile(
    'tools/oxlint/browser-boundaries.mjs',
    path.join(root, 'tools/oxlint/browser-boundaries.mjs')
  )
  await writeFile(
    path.join(root, 'tools/oxlint/plugin.mjs'),
    `import rule from './browser-boundaries.mjs'; export default { meta: { name: 'treeport' }, rules: { 'browser-boundaries': rule } }`
  )
  await writeFile(
    path.join(root, '.oxlintrc.json'),
    JSON.stringify({
      jsPlugins: ['./tools/oxlint/plugin.mjs'],
      rules: { 'treeport/browser-boundaries': 'error' }
    })
  )
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function lint(filename, input) {
  const file = `apps/treeport/src/server/${filename}`
  await writeFile(path.join(root, file), input)
  return spawnSync(oxlint, [file], { cwd: root, encoding: 'utf8' })
}

// These are the allocation paths from #574 and #580, not invented bad APIs.
it.each([
  ['browser-clipboard.ts', 'export const reader = page.context().newPage()'],
  ['browser-video.ts', 'export const helper = context.newPage()'],
  ['browser-video.ts', "export const open = context['newPage']"],
  ['browser-video.ts', 'export const { newPage: open } = context'],
  ['browser-video.ts', 'helper.setViewportSize({ width: 1280, height: 800 })'],
  [
    'browser-page-host.ts',
    'export const context = chromium.launchPersistentContext(profile, { viewport: DEFAULT_VIEWPORT })'
  ],
  ['browser-page-host.ts', 'export const context = browser.newContext({})'],
  [
    'browser-page-host.ts',
    'export const context = browser.newContext({ viewport: null, ...options })'
  ]
])('rejects unsafe allocation in %s: %s', async (filename, input) => {
  const result = await lint(filename, input)
  expect(result.status).toBe(1)
  expect(result.stdout + result.stderr).toContain(
    'treeport(browser-boundaries)'
  )
  expect(result.stdout + result.stderr).toMatch(
    /PlaywrightBrowserHost|PlaywrightBrowser owns/
  )
})

it('allows only the host to allocate unsized contexts and helper pages', async () => {
  const result = await lint(
    'browser-page-host.ts',
    `export const context = chromium.launchPersistentContext(profile, { ...options, viewport: null })
export const reader = browser.newContext({ viewport: null })
export const helper = context.newPage()`
  )
  expect(result.status, result.stdout + result.stderr).toBe(0)
})
