import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { createBrowserDevtoolsBridge } from './browser-devtools'

const servers: Array<http.Server | WebSocketServer> = []
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
  )
})

it('relays only the selected page after the DevTools origin and panel check', async () => {
  const chrome = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  servers.push(chrome)
  await new Promise<void>((resolve) => chrome.once('listening', resolve))
  // SAFETY: ws reports AddressInfo after the listening event.
  const chromePort = (chrome.address() as AddressInfo).port
  chrome.on('connection', (socket) => {
    socket.on('message', (message) => socket.send(message))
  })

  const panelId = `panel_${'a'.repeat(32)}`
  const bridge = createBrowserDevtoolsBridge(async (selected) => {
    if (selected !== panelId) {
      throw new Error('Unknown panel')
    }

    return `ws://127.0.0.1:${chromePort}`
  })
  const treeport = http.createServer()
  servers.push(treeport)
  treeport.on('upgrade', (request, socket, head) => {
    if (!bridge.handleUpgrade(request, socket, head)) {
      socket.destroy()
    }
  })
  await new Promise<void>((resolve) => treeport.listen(0, '127.0.0.1', resolve))
  // SAFETY: the HTTP server has started listening.
  const port = (treeport.address() as AddressInfo).port

  const connect = (origin: string, id = panelId) =>
    new WebSocket(`ws://127.0.0.1:${port}/api/browser-devtools/${id}`, {
      origin
    })
  const denied = connect('https://attacker.example')
  denied.on('error', () => undefined)
  expect(
    await new Promise<number>((resolve) => {
      denied.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0)
      })
    })
  ).toBe(403)

  const missing = connect('devtools://devtools', `panel_${'b'.repeat(32)}`)
  missing.on('error', () => undefined)
  expect(
    await new Promise<number>((resolve) => {
      missing.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0)
      })
    })
  ).toBe(404)

  const viewer = connect('devtools://devtools')
  await new Promise<void>((resolve, reject) => {
    viewer.once('open', resolve)
    viewer.once('error', reject)
  })
  viewer.send('Runtime.evaluate')
  expect(
    await new Promise<string>((resolve) =>
      viewer.once('message', (data) => resolve(data.toString()))
    )
  ).toBe('Runtime.evaluate')
  viewer.close()
  bridge.close()
})
