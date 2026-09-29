import { describe, expect, it } from 'vitest'
import { isBrowserLoopbackHostname } from './browser-loopback'

describe('browser loopback hostnames', () => {
  it.each([
    'http://localhost:3000',
    'http://app.localhost:4000',
    'http://127.0.0.1:5000',
    'http://127.1.2.3:6000',
    'http://[::1]:7000',
    'ws://localhost:8000',
    'https://LOCALHOST:9000'
  ])('recognizes loopback URLs regardless of port or transport: %s', (url) => {
    expect(isBrowserLoopbackHostname(new URL(url).hostname)).toBe(true)
  })

  it.each([
    'https://example.com',
    'https://localhost.example.com',
    'https://notlocalhost',
    'https://127.0.0.1.example.com',
    'http://192.168.1.1',
    'http://128.0.0.1',
    'http://[::2]'
  ])('does not exempt public or LAN hostnames: %s', (url) => {
    expect(isBrowserLoopbackHostname(new URL(url).hostname)).toBe(false)
  })
})
