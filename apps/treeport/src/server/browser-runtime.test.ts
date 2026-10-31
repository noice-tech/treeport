import fs from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { browserRuntime } from './browser-runtime.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('discovers native Chrome or Chromium on macOS and Linux without downloading a browser', async () => {
  vi.stubEnv('TREEPORT_BROWSER_EXECUTABLE', '')
  const access = vi.spyOn(fs, 'access').mockRejectedValue(new Error('ENOENT'))
  await expect(browserRuntime('darwin')).resolves.toEqual({
    executablePath: null,
    channel: 'chrome',
    launchError: expect.stringContaining('No supported Chrome or Chromium')
  })
  const missing = await browserRuntime('linux')
  expect(missing.executablePath).toBeNull()
  expect(missing.launchError).toContain('sudo snap install chromium')
  expect(missing.launchError).toContain('Treeport daemon host')
  expect(missing.launchError).toContain('TREEPORT_BROWSER_EXECUTABLE')
  expect(missing.launchError).toContain('Retry')

  for (const [platform, executablePath] of [
    ['darwin', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['linux', '/opt/google/chrome/chrome'],
    ['linux', '/usr/bin/google-chrome-stable'],
    ['linux', '/usr/bin/google-chrome'],
    ['linux', '/usr/bin/chromium'],
    ['linux', '/usr/bin/chromium-browser'],
    ['linux', '/snap/bin/chromium']
  ] as const) {
    access.mockImplementation(async (candidate, mode) => {
      expect(mode).toBe(fs.constants.X_OK)

      if (candidate !== executablePath) {
        throw new Error('ENOENT')
      }
    })
    await expect(browserRuntime(platform)).resolves.toEqual({
      executablePath,
      channel: executablePath.includes('chromium') ? 'chromium' : 'chrome',
      launchError: null
    })
  }
})

it('uses an explicit native executable and reports invalid executable paths without falling back', async () => {
  const access = vi.spyOn(fs, 'access').mockResolvedValue(undefined)
  vi.stubEnv('TREEPORT_BROWSER_EXECUTABLE', '/usr/bin/chromium')
  await expect(browserRuntime('linux')).resolves.toEqual({
    executablePath: '/usr/bin/chromium',
    channel: 'chromium',
    launchError: null
  })
  vi.stubEnv('TREEPORT_BROWSER_EXECUTABLE', '/usr/bin/google-chrome-stable')
  await expect(browserRuntime('linux')).resolves.toEqual({
    executablePath: '/usr/bin/google-chrome-stable',
    channel: 'chrome',
    launchError: null
  })
  access.mockClear()
  vi.stubEnv('TREEPORT_BROWSER_EXECUTABLE', './chromium')
  expect((await browserRuntime('linux')).launchError).toContain('absolute path')
  expect(access).not.toHaveBeenCalled()

  vi.stubEnv('TREEPORT_BROWSER_EXECUTABLE', '/custom/chromium')

  for (const reason of ['ENOENT', 'EACCES']) {
    access.mockClear().mockRejectedValue(new Error(reason))
    const runtime = await browserRuntime('linux')
    expect(runtime.executablePath).toBe('/custom/chromium')
    expect(runtime.launchError).toContain('missing or not executable')
    expect(runtime.launchError).toContain('/custom/chromium')
    expect(runtime.launchError).toContain('restart the daemon')
    expect(access).toHaveBeenCalledExactlyOnceWith(
      '/custom/chromium',
      fs.constants.X_OK
    )
  }

  access.mockResolvedValue(undefined)
  expect((await browserRuntime('linux')).launchError).toBeNull()
})
