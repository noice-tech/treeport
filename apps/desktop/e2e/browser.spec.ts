import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'

const repositoryRoot = path.resolve(__dirname, '..', '..', '..')
const treeport = path.join(repositoryRoot, 'apps', 'treeport')

// EXTERNAL: The outer Treeport instance exports TREEPORT_* to its terminals. Inheriting
// them would point this test's server and desktop at the user's real instance.
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('TREEPORT_'))
)

let directory = ''
let server: ChildProcess | null = null
let site: http.Server | null = null
let desktop: ElectronApplication | null = null

async function freePort(): Promise<number> {
  const probe = net.createServer().listen(0, '127.0.0.1')
  await new Promise((resolve) => probe.once('listening', resolve))
  // SAFETY: A server listening on a TCP port reports an AddressInfo, not a pipe path.
  const { port } = probe.address() as AddressInfo
  await new Promise((resolve) => probe.close(resolve))

  return port
}

test.afterEach(async () => {
  await desktop?.close()
  server?.kill('SIGTERM')
  await new Promise((resolve) => site?.close(resolve) ?? resolve(null))
  await fs.rm(directory, { recursive: true, force: true })
})

test('Browser loads pages and keeps navigating in the desktop app', async () => {
  test.setTimeout(120_000)
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-desktop-'))

  const pages = new Map([
    ['/first', 'First page'],
    ['/second', 'Second page']
  ])

  site = http
    .createServer((request, response) => {
      const title = pages.get(request.url ?? '') ?? 'Missing page'
      response.setHeader('content-type', 'text/html')
      response.end(`<title>${title}</title><h1>${title}</h1>`)
    })
    .listen(0, '127.0.0.1')
  await new Promise((resolve) => site!.once('listening', resolve))
  // SAFETY: A server listening on a TCP port reports an AddressInfo, not a pipe path.
  const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`

  const port = await freePort()
  const apiUrl = `http://127.0.0.1:${port}`
  const runtime = path.join(directory, 'runtime')

  const serverEnvironment = {
    ...environment,
    TREEPORT_HOST: '127.0.0.1',
    TREEPORT_PORT: String(port),
    TREEPORT_API_URL: apiUrl,
    TREEPORT_WEB_DIST: path.join(treeport, 'dist', 'web'),
    TREEPORT_DATA_DIR: path.join(directory, 'data'),
    TREEPORT_RUNTIME_DIR: runtime,
    TREEPORT_CACHE_DIR: path.join(directory, 'cache'),
    TREEPORT_DAEMON_RECORD: path.join(runtime, 'daemon.json')
  }

  server = spawn(
    process.execPath,
    [path.join(treeport, 'src', 'server', 'index.ts')],
    { cwd: repositoryRoot, env: serverEnvironment, stdio: 'inherit' }
  )

  await expect
    .poll(
      () =>
        fetch(`${apiUrl}/api/health`).then(
          (response) => response.ok,
          () => false
        ),
      { timeout: 30_000 }
    )
    .toBe(true)

  const project = path.join(directory, 'project')
  await fs.mkdir(project)

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: project, encoding: 'utf8' })

  git('init', '--initial-branch=main')
  git(
    '-c',
    'user.name=Treeport',
    '-c',
    'user.email=treeport@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'Initial commit'
  )

  const cli = (...args: string[]) =>
    execFileSync(path.join(treeport, 'bin', 'treeport'), args, {
      cwd: project,
      env: serverEnvironment,
      encoding: 'utf8'
    })

  cli('project', 'add', '.')
  const opened = cli('browser', 'open', `${siteUrl}/first`, '--worktree', '.')
  const appUrl = opened.match(/https?:\/\/\S+\/apps\/\S+/)?.[0]
  expect(appUrl).toBeDefined()

  desktop = await electron.launch({
    args: [path.join(repositoryRoot, 'apps', 'desktop')],
    env: {
      ...environment,
      TREEPORT_DESKTOP_E2E: '1',
      TREEPORT_DESKTOP_USER_DATA: path.join(directory, 'desktop'),
      TREEPORT_DESKTOP_URL: apiUrl
    }
  })

  const workspacePage = () =>
    desktop!
      .context()
      .pages()
      .find((page) => page.url().startsWith(apiUrl))

  await expect.poll(workspacePage, { timeout: 30_000 }).toBeDefined()
  const workspace: Page = workspacePage()!
  await workspace.goto(appUrl!)

  const address = workspace.getByRole('textbox', { name: 'Application URL' })
  const tab = workspace.getByRole('tab', { name: /, Browser$/ })

  await expect(tab).toHaveAccessibleName('First page, Browser', {
    timeout: 30_000
  })
  await expect(address).toHaveValue(`${siteUrl}/first`)

  for (const [pathname, title] of [
    ['/second', 'Second page'],
    ['/first', 'First page']
  ]) {
    await address.fill(`${siteUrl}${pathname}`)
    await address.press('Enter')

    await expect(tab).toHaveAccessibleName(`${title}, Browser`)
    await expect(address).toHaveValue(`${siteUrl}${pathname}`)
  }

  await expect(workspace.getByText('Browser unavailable')).toBeHidden()
})
