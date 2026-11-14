import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  WebAppViteRuntime,
  WebAppRuntimeLayer,
  WebAppRuntimePort,
  type ResolvedWebAppSource
} from './web-app-vite-runtime.ts'

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-app-vite-'))
  directories.push(root)
  const packageRoot = path.join(root, 'package')
  const appRoot = path.join(packageRoot, 'web-apps', 'review')
  await fs.mkdir(path.join(packageRoot, 'node_modules', 'app-message'), {
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
          'app-message': '1.0.0',
          react: '19.2.4',
          'react-dom': '19.2.4'
        }
      })
    ),
    fs.writeFile(
      path.join(packageRoot, 'node_modules', 'app-message', 'package.json'),
      JSON.stringify({
        name: 'app-message',
        version: '1.0.0',
        type: 'module',
        exports: './index.js'
      })
    ),
    fs.writeFile(
      path.join(packageRoot, 'node_modules', 'app-message', 'index.js'),
      "export default 'dependency loaded'\n"
    )
  ])
  await fs.mkdir(appRoot, { recursive: true })
  await Promise.all([
    fs.writeFile(
      path.join(appRoot, 'index.html'),
      '<!doctype html><main id="root"></main><script type="module" src="./app.tsx"></script>'
    ),
    fs.writeFile(
      path.join(appRoot, 'app.tsx'),
      "import message from 'app-message'; import { treeport } from '@treeport/app-sdk'; const view = <h1>{message} {treeport.version}</h1>; document.querySelector('#root').textContent = view.props.children\n"
    ),
    fs.writeFile(
      path.join(packageRoot, 'vite.config.ts'),
      "throw new Error('package Vite config was executed')\n"
    )
  ])

  const source: ResolvedWebAppSource = {
    root: appRoot,
    entry: 'index.html',
    packageRoot,
    definitionId: 'package:local:review:web-app:review',
    packageSource: './review',
    allowNetworkRequests: false
  }

  return { source }
}

describe('WebAppViteRuntime', () => {
  it('serves local source apps through Vite with sandbox-compatible headers', async () => {
    const { source } = await fixture()
    const runtime = new WebAppViteRuntime()

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

      const resolution = await Effect.runPromise(
        runtime.resolve({ ...source, allowNetworkRequests: true }, '')
      )

      if (resolution.kind !== 'redirect') {
        throw new Error('expected development redirect')
      }

      const browserOrigin = 'https://treeport.example.ts.net:5173'

      const response = await fetch(
        `http://127.0.0.1:${address.data.port}${resolution.location}`,
        {
          headers: {
            referer: `${browserOrigin}/projects/project_1/apps/app_review`,
            'x-forwarded-host': 'treeport.example.ts.net:5173',
            'x-forwarded-proto': 'https'
          }
        }
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(response.headers.get('cache-control')).toBe('no-cache')
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
      const clientResponse = await fetch(new URL('@vite/client', response.url))
      expect(clientResponse.status).toBe(200)
      const clientCode = await clientResponse.text()
      const base = new URL('.', response.url).pathname
      expect(clientCode).toContain(`${base}@vite-hmr`)
      expect(clientCode).not.toContain(`${base}${base.slice(1)}@vite-hmr`)
      const moduleResponse = await fetch(new URL('app.tsx', response.url))
      expect(moduleResponse.status).toBe(200)
      expect(moduleResponse.headers.get('cache-control')).toBe('no-cache')
      const moduleCode = await moduleResponse.text()
      expect(moduleCode).not.toContain('sourceMappingURL=data:')
      expect(moduleCode).toContain('treeport.version')

      for (const [host, expectedStatus] of [
        ['treeport.example.ts.net', 200],
        ['attacker.example', 403]
      ] as const) {
        const status = await new Promise<number | undefined>(
          (resolve, reject) => {
            http
              .get(response.url, { headers: { host } }, (response) => {
                response.resume()
                response.on('end', () => resolve(response.statusCode))
                response.on('error', reject)
              })
              .on('error', reject)
          }
        )

        expect(status).toBe(expectedStatus)
      }

      const untrustedReferrerResponse = await fetch(
        `http://127.0.0.1:${address.data.port}${resolution.location}`,
        {
          headers: {
            referer: 'https://attacker.example/app',
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
      await Effect.runPromise(runtime.disposeDevelopmentServers())
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it('closes development servers when its layer scope closes', async () => {
    const { source } = await fixture()
    let runtime: WebAppViteRuntime | null = null
    let location = ''

    const server = http.createServer((request, response) => {
      if (!runtime) {
        response.statusCode = 503
        response.end()

        return
      }

      runtime.handleDevelopmentRequest(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            runtime = yield* WebAppRuntimePort
            runtime.attachHttpServer(server)

            const resolution = yield* runtime.resolve(source, '')

            if (resolution.kind !== 'redirect') {
              throw new Error('expected development redirect')
            }

            location = resolution.location
          }).pipe(Effect.provide(WebAppRuntimeLayer()))
        )
      )

      const address = z.object({ port: z.number() }).parse(server.address())

      const response = await fetch(
        `http://127.0.0.1:${address.port}${location}`
      )

      expect(response.status).toBe(404)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})
