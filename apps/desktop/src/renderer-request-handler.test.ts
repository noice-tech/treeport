import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRendererRequestHandler } from './renderer-request-handler'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('desktop renderer requests', () => {
  it('routes development documents and modules through Vite while preserving API requests', async () => {
    const forwarded: string[] = []
    const handler = await createRendererRequestHandler({
      rendererDirectory: '.',
      developmentServerUrl: 'http://localhost:5174',
      selectedBackendOrigin: () => 'http://127.0.0.1:8733',
      forward: async (request) => {
        forwarded.push(request.url)
        return new Response(request.url)
      }
    })

    await handler(
      new Request(
        'http://127.0.0.1:8733/projects/project-1/worktrees/worktree-1',
        { headers: { accept: 'text/html' } }
      )
    )
    await handler(
      new Request('http://127.0.0.1:8733/app.tsx?version=1', {
        headers: { 'sec-fetch-dest': 'script' }
      })
    )
    await handler(new Request('http://127.0.0.1:8733/api/projects'))

    expect(forwarded).toEqual([
      'http://localhost:5174/',
      'http://localhost:5174/app.tsx?version=1',
      'http://127.0.0.1:8733/api/projects'
    ])
  })

  it('serves packaged routes and assets while forwarding backend requests unchanged', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'treeport-renderer-handler-')
    )
    temporaryDirectories.push(directory)
    await mkdir(path.join(directory, 'assets'))
    await writeFile(path.join(directory, 'index.html'), '<main>Treeport</main>')
    await writeFile(path.join(directory, 'assets', 'app.js'), 'app()')
    const forwarded: Array<{
      url: string
      method: string
      authorization: string | null
      body: string
    }> = []
    const forward = vi.fn(async (request: Request) => {
      forwarded.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get('authorization'),
        body: await request.text()
      })
      return Response.json({ forwarded: true })
    })
    const handler = await createRendererRequestHandler({
      rendererDirectory: directory,
      developmentServerUrl: null,
      selectedBackendOrigin: () => 'http://127.0.0.1:8733',
      forward
    })

    const route = await handler(
      new Request(
        'http://127.0.0.1:8733/projects/project-1/worktrees/worktree-1',
        { headers: { accept: 'text/html' } }
      )
    )
    expect(await route.text()).toBe('<main>Treeport</main>')
    expect(route.headers.get('content-type')).toBe('text/html; charset=utf-8')

    const asset = await handler(
      new Request('http://127.0.0.1:8733/assets/app.js')
    )
    expect(await asset.text()).toBe('app()')
    expect(asset.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8'
    )

    const api = await handler(
      new Request('http://127.0.0.1:8733/api/value', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ value: 1 })
      })
    )
    expect(await api.json()).toEqual({ forwarded: true })
    expect(forwarded).toContainEqual({
      url: 'http://127.0.0.1:8733/api/value',
      method: 'POST',
      authorization: 'Bearer test',
      body: JSON.stringify({ value: 1 })
    })

    await handler(new Request('https://example.test/assets/app.js'))
    expect(forwarded).toContainEqual({
      url: 'https://example.test/assets/app.js',
      method: 'GET',
      authorization: null,
      body: ''
    })

    const malformed = await handler(
      new Request('treeport-app://application/%E0%A4%A')
    )
    expect(malformed.status).toBe(404)
    const traversal = await handler(
      new Request('treeport-app://application/%2e%2e%2fsecret')
    )
    expect(traversal.status).toBe(404)
  })
})
