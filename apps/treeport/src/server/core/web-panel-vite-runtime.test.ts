import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AppConfig } from './config'
import {
  WebPanelViteRuntime,
  type ResolvedWebPanelSource
} from './web-panel-vite-runtime'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      fs.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100
      })
    )
  )
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-panel-vite-'))
  directories.push(root)
  const packageRoot = path.join(root, 'package')
  const panelRoot = path.join(packageRoot, 'web-panels', 'review')
  await fs.mkdir(path.join(packageRoot, 'node_modules', 'panel-message'), {
    recursive: true
  })
  await Promise.all([
    fs.symlink(
      path.dirname(fileURLToPath(import.meta.resolve('react/package.json'))),
      path.join(packageRoot, 'node_modules', 'react'),
      'dir'
    ),
    fs.symlink(
      path.dirname(
        fileURLToPath(import.meta.resolve('react-dom/package.json'))
      ),
      path.join(packageRoot, 'node_modules', 'react-dom'),
      'dir'
    ),
    fs.writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@acme/review',
        dependencies: {
          'panel-message': '1.0.0',
          react: '19.2.4',
          'react-dom': '19.2.4'
        }
      })
    ),
    fs.writeFile(
      path.join(packageRoot, 'node_modules', 'panel-message', 'package.json'),
      JSON.stringify({
        name: 'panel-message',
        version: '1.0.0',
        type: 'module',
        exports: './index.js'
      })
    ),
    fs.writeFile(
      path.join(packageRoot, 'node_modules', 'panel-message', 'index.js'),
      "export default 'dependency loaded'\n"
    )
  ])
  await fs.mkdir(panelRoot, { recursive: true })
  await Promise.all([
    fs.writeFile(
      path.join(panelRoot, 'index.html'),
      '<!doctype html><main id="root"></main><script type="module" src="./panel.tsx"></script>'
    ),
    fs.writeFile(
      path.join(panelRoot, 'panel.tsx'),
      "import message from 'panel-message'; import { treeport } from '@treeport/panel-sdk'; const view = <h1>{message} {treeport.version}</h1>; document.querySelector('#root').textContent = view.props.children\n"
    ),
    fs.writeFile(
      path.join(packageRoot, 'vite.config.ts'),
      "throw new Error('package Vite config was executed')\n"
    )
  ])
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 8733,
    databasePath: path.join(root, 'treeport.db'),
    dataDir: root,
    cacheDir: path.join(root, 'cache'),
    runtimeDir: path.join(root, 'runtime'),
    shell: '/bin/sh',
    tmuxPath: 'tmux',
    gitPath: 'git',
    ghPath: 'gh',
    apiUrl: 'http://127.0.0.1:8733',
    daemonLifecycle: 'external',
    webDevelopment: false,
    appVersion: 'test'
  }
  const source: ResolvedWebPanelSource = {
    root: panelRoot,
    entry: 'index.html',
    packageRoot,
    development: false,
    definitionId: 'package:npm:@acme/review:web-panel:review',
    packageSource: 'npm:@acme/review@1.0.0',
    allowNetworkRequests: false
  }
  return { root, panelRoot, config, source }
}

function immutablePath(location: string): string {
  return location.slice(location.indexOf('__treeport/'))
}

describe('WebPanelViteRuntime', () => {
  it('compiles source packages atomically, reuses immutable builds, and keeps old builds available', async () => {
    const { panelRoot, config, source } = await fixture()
    const runtime = new WebPanelViteRuntime(config)
    const logicalBase = '/api/web-panels/panel/assets/'

    const firstRequests = await Promise.all([
      runtime.resolve(source, '', logicalBase),
      runtime.resolve(source, '', logicalBase)
    ])
    expect(firstRequests[0]).toMatchObject({
      kind: 'redirect',
      development: false
    })
    expect(firstRequests[1]).toEqual(firstRequests[0])
    if (firstRequests[0]!.kind !== 'redirect') {
      throw new Error('expected redirect')
    }

    const firstPath = immutablePath(firstRequests[0].location)
    const document = await runtime.resolve(source, firstPath, logicalBase)
    expect(document).toMatchObject({ kind: 'asset', immutable: true })
    if (document.kind !== 'asset') {
      throw new Error('expected compiled document')
    }

    const html = await fs.readFile(document.path, 'utf8')
    const script = /src="\.\/(assets\/[^"]+\.js)"/u.exec(html)?.[1]
    expect(script).toBeTruthy()
    const compiledScript = await runtime.resolve(
      source,
      `${firstPath.slice(0, firstPath.lastIndexOf('/') + 1)}${script}`,
      logicalBase
    )
    if (compiledScript.kind !== 'asset') {
      throw new Error('expected compiled script')
    }

    const compiledSource = await fs.readFile(compiledScript.path, 'utf8')
    expect(compiledSource).toContain('dependency loaded')
    expect(compiledSource).toContain('treeport-panel-v1')

    expect(await runtime.resolve(source, '', logicalBase)).toEqual(
      firstRequests[0]
    )
    await fs.writeFile(
      path.join(panelRoot, 'panel.tsx'),
      "document.querySelector('#root').textContent = 'source changed'\n"
    )
    const changed = await runtime.resolve(source, '', logicalBase)
    expect(changed).toMatchObject({ kind: 'redirect' })
    expect(changed).not.toEqual(firstRequests[0])
    expect(await runtime.resolve(source, firstPath, logicalBase)).toMatchObject(
      {
        kind: 'asset',
        immutable: true
      }
    )

    await expect(
      runtime.resolve(source, '../../outside.js', logicalBase)
    ).rejects.toMatchObject({ code: 'INVALID_ASSET_PATH' })
  })

  it('serves local source panels through Vite with sandbox-compatible headers', async () => {
    const { config, source } = await fixture()
    const runtime = new WebPanelViteRuntime(config)
    const server = http.createServer((request, response) => {
      runtime.handleDevelopmentRequest(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    runtime.attachHttpServer(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    try {
      const address = z
        .object({ port: z.number().int() })
        .safeParse(server.address())
      if (!address.success) {
        throw new Error('expected HTTP listener address')
      }

      const resolution = await runtime.resolve(
        { ...source, development: true, allowNetworkRequests: true },
        '',
        '/api/web-panels/panel/assets/'
      )
      if (resolution.kind !== 'redirect') {
        throw new Error('expected development redirect')
      }

      const browserOrigin = 'https://treeport.example.ts.net:5173'
      const response = await fetch(
        `http://127.0.0.1:${address.data.port}${resolution.location}`,
        {
          headers: {
            referer: `${browserOrigin}/projects/project_1/panels/panel_review`,
            'x-forwarded-host': 'treeport.example.ts.net:5173',
            'x-forwarded-proto': 'https'
          }
        }
      )
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(
        response.headers
          .get('content-security-policy')
          ?.split(';')
          .map((directive) => directive.trim())
      ).toEqual(
        expect.arrayContaining([
          `default-src 'self' ${browserOrigin}`,
          `script-src 'self' ${browserOrigin} 'unsafe-inline'`,
          `style-src 'self' ${browserOrigin} 'unsafe-inline'`,
          `img-src 'self' ${browserOrigin} data: blob:`,
          `connect-src 'self' ${browserOrigin} ws: wss: http: https:`,
          'frame-src http: https:',
          `frame-ancestors 'self' ${browserOrigin}`
        ])
      )
      await expect(response.text()).resolves.toContain('@vite/client')

      const untrustedReferrerResponse = await fetch(
        `http://127.0.0.1:${address.data.port}${resolution.location}`,
        {
          headers: {
            referer: 'https://attacker.example/panel',
            'x-forwarded-host': 'treeport.example.ts.net:5173',
            'x-forwarded-proto': 'https'
          }
        }
      )
      const untrustedReferrerPolicy = untrustedReferrerResponse.headers.get(
        'content-security-policy'
      )
      expect(untrustedReferrerPolicy).toContain(browserOrigin)
      expect(untrustedReferrerPolicy).not.toContain('attacker.example')
    } finally {
      await runtime.dispose()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it('returns an actionable in-frame error when a runtime dependency is missing', async () => {
    const { panelRoot, config, source } = await fixture()
    await fs.writeFile(
      path.join(panelRoot, 'panel.tsx'),
      "import missing from 'not-installed'; document.body.textContent = missing\n"
    )
    const result = await new WebPanelViteRuntime(config).resolve(
      source,
      '',
      '/api/web-panels/panel/assets/'
    )
    expect(result).toMatchObject({ kind: 'error', development: false })
    if (result.kind !== 'error') {
      throw new Error('expected build error')
    }

    expect(result.html).toContain('Web panel could not be compiled')
    expect(result.html).toContain('dependencies')
    expect(result.html).not.toContain(source.packageRoot)
  })
})
