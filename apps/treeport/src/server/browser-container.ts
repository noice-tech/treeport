import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import seccomp from './browser-seccomp.json' with { type: 'json' }

// Chromium's user-namespace sandbox needs clone/setns/unshare. This is the
// Playwright project's Docker seccomp profile (Apache-2.0), not an unconfined
// container: https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json
// Build from distribution packages, not Chrome for Testing. No host files or
// Docker socket enter the build context or browser container.
const DOCKERFILE = `FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium chromium-sandbox ca-certificates fonts-liberation fonts-noto-color-emoji && rm -rf /var/lib/apt/lists/*
ENV HOME=/profile
ENTRYPOINT ["/usr/bin/chromium", "--headless", "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--user-data-dir=/profile", "about:blank"]
`
export const BROWSER_CONTAINER_IMAGE = `treeport-browser:${createHash('sha256').update(DOCKERFILE).digest('hex').slice(0, 12)}`

// A bounded, argv-only boundary also lets tests verify ownership and network
// isolation without installing Docker or starting a real browser.
function runBrowserDocker(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'docker',
      args,
      {
        encoding: 'utf8',
        timeout: input ? 600_000 : 30_000,
        maxBuffer: 2 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Browser Docker operation failed: ${stderr.trim() || error.message}. Ensure Docker is installed and this service user can access its local daemon.`
            )
          )
        } else {
          resolve((stdout || stderr).trim())
        }
      }
    )
    child.stdin?.end(input)
  })
}

export class BrowserContainer {
  private containerId: string | null = null
  private dockerHost: string | null = null

  constructor(
    private readonly profilePath: string,
    private readonly cachePath: string,
    private readonly run = runBrowserDocker
  ) {}

  private async docker(args: string[], input?: string): Promise<string> {
    if (!this.dockerHost) {
      const endpoint =
        process.env.DOCKER_HOST?.trim() ||
        (await this.run([
          'context',
          'inspect',
          '--format',
          '{{.Endpoints.docker.Host}}'
        ]))
      if (!endpoint.startsWith('unix:///')) {
        throw new Error(
          'The Browser container requires a local Docker Unix socket. Remote Docker contexts are not supported.'
        )
      }

      if (
        (await this.run([
          '--host',
          endpoint,
          'info',
          '--format',
          '{{.OSType}}'
        ])) !== 'linux'
      ) {
        throw new Error('The Browser container requires a Linux Docker daemon.')
      }

      const security = await this.run([
        '--host',
        endpoint,
        'info',
        '--format',
        '{{json .SecurityOptions}}'
      ])
      if (security.includes('name=rootless')) {
        throw new Error(
          'The Browser container requires rootful Docker so host networking reaches VPS localhost. Run Treeport itself as a non-root user.'
        )
      }

      this.dockerHost = endpoint
    }

    return this.run(['--host', this.dockerHost, ...args], input)
  }

  async installed(): Promise<boolean> {
    const images = await this.docker([
      'image',
      'ls',
      '--quiet',
      BROWSER_CONTAINER_IMAGE
    ])
    return images.length > 0
  }

  async install(): Promise<void> {
    if (process.getuid?.() === 0) {
      throw new Error(
        'Run Treeport as a non-root service user so the Browser sandbox can remain enabled.'
      )
    }

    // Only the explicit setup action may download or build an image. Re-running
    // setup refreshes security updates; running browsers update after restart.
    await this.docker(
      ['build', '--pull', '--no-cache', '--tag', BROWSER_CONTAINER_IMAGE, '-'],
      DOCKERFILE
    )
  }

  async start(): Promise<string> {
    if (process.getuid?.() === 0) {
      throw new Error(
        'Run Treeport as a non-root service user so the Browser sandbox can remain enabled.'
      )
    }

    if (!(await this.installed())) {
      throw new Error(
        'Browser is not set up. Select Set up browser, or run treeport browser install.'
      )
    }

    await fs.mkdir(this.profilePath, { recursive: true, mode: 0o700 })
    await fs.chmod(this.profilePath, 0o700)
    const profile = await fs.realpath(this.profilePath)
    if (profile.includes(',')) {
      throw new Error(
        'The Browser profile path cannot contain a comma when using Docker.'
      )
    }

    const owner = createHash('sha256').update(profile).digest('hex')
    const name = `treeport-browser-${owner.slice(0, 20)}`
    const existing = await this.docker([
      'container',
      'ls',
      '--all',
      '--filter',
      `name=^/${name}$`,
      '--format',
      '{{.ID}}'
    ])
    if (existing) {
      const identity = await this.docker([
        'inspect',
        '--format',
        '{{index .Config.Labels "app.treeport.profile"}}|{{.State.Running}}|{{.Id}}',
        existing
      ])
      const [label, running, id] = identity.split('|')
      if (label !== owner || !id || !/^[a-f0-9]{64}$/.test(id)) {
        throw new Error(
          'A container with the Browser name already exists but is not owned by this profile. It was not modified.'
        )
      }

      this.containerId = id
      if (running !== 'true') {
        await fs.rm(path.join(profile, 'DevToolsActivePort'), { force: true })
        await this.docker(['start', id])
      }
    } else {
      await fs.mkdir(this.cachePath, { recursive: true, mode: 0o700 })
      const policyPath = path.join(this.cachePath, 'browser-seccomp.json')
      const temporaryPolicy = path.join(
        this.cachePath,
        `.seccomp-${randomUUID()}`
      )
      await fs.writeFile(temporaryPolicy, JSON.stringify(seccomp), {
        mode: 0o600
      })
      // Concurrent status probes must never see a partially written policy.
      await fs
        .rename(temporaryPolicy, policyPath)
        .finally(() => fs.rm(temporaryPolicy, { force: true }))
      await fs.rm(path.join(profile, 'DevToolsActivePort'), { force: true })
      const id = await this.docker([
        'run',
        '--pull=never',
        '--detach',
        '--init',
        '--name',
        name,
        '--hostname',
        name,
        '--label',
        `app.treeport.profile=${owner}`,
        '--network',
        'host',
        '--shm-size',
        '1g',
        '--user',
        `${process.getuid!()}:${process.getgid!()}`,
        '--security-opt',
        `seccomp=${policyPath}`,
        '--mount',
        `type=bind,source=${profile},target=/profile`,
        BROWSER_CONTAINER_IMAGE
      ])
      if (!/^[a-f0-9]{64}$/.test(id)) {
        throw new Error('Docker did not return a valid Browser container ID.')
      }

      this.containerId = id
    }

    // Chrome chooses an unused loopback port. The private profile supplies its
    // unguessable browser endpoint; never probe a familiar fixed debugging port.
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const activePort = await fs
        .readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')
        .catch(() => '')
      const [port, endpoint] = activePort.trim().split('\n')
      if (
        port &&
        /^\d+$/.test(port) &&
        Number(port) > 0 &&
        Number(port) <= 65535 &&
        endpoint &&
        /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(endpoint)
      ) {
        return `ws://127.0.0.1:${port}${endpoint}`
      }

      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const logs = await this.docker([
      'logs',
      '--tail',
      '20',
      this.containerId
    ]).catch(() => '')
    throw new Error(
      `Browser container did not become ready. Check Docker's sandbox support and host user-namespace policy. ${logs}`
    )
  }

  async stop(): Promise<void> {
    const id = this.containerId
    this.containerId = null
    if (id) {
      // Only a previously verified/created ID may be stopped; never stop by image
      // or a globally shared name. Chrome's profile is outside the container.
      await this.docker(['stop', '--time', '20', id]).catch(() => undefined)
      // Do not force removal or remove volumes. Retaining failed containers until
      // this point lets startup diagnostics read Chrome's sandbox error output.
      await this.docker(['rm', id]).catch(() => undefined)
    }
  }
}
