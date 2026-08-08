import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'

describe('configuration', () => {
  it('defaults to loopback and XDG data locations', () => {
    const config = loadConfig({
      XDG_DATA_HOME: '/tmp/data home',
      XDG_CACHE_HOME: '/tmp/cache home',
      XDG_RUNTIME_DIR: '/tmp/run',
      SHELL: '/bin/zsh'
    })
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(8733)
    expect(config.databasePath).toBe('/tmp/data home/treeport/treeport.db')
    expect(config.cacheDir).toBe('/tmp/cache home/treeport')
    expect(config.runtimeDir).toBe('/tmp/run/treeport')
    expect(config.shell).toBe('/bin/zsh')
    expect(config.daemonLifecycle).toBe('treeport')
  })

  it('uses conventional listener variables when Treeport overrides are absent', () => {
    const config = loadConfig({
      HOST: '127.0.0.1',
      PORT: '4567',
      TREEPORT_API_URL: 'https://feature.api.treeport.localhost'
    })

    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(4567)
    expect(config.apiUrl).toBe('https://feature.api.treeport.localhost')
  })

  it('uses explicit Treeport configuration', () => {
    const config = loadConfig({
      TREEPORT_DATA_DIR: '~/treeport-data',
      TREEPORT_DATABASE_PATH: '/tmp/custom/treeport.db',
      TREEPORT_CACHE_DIR: '/tmp/custom/cache',
      TREEPORT_HOST: '0.0.0.0',
      TREEPORT_PORT: '5000',
      TREEPORT_API_URL: 'http://example.test:5000',
      TREEPORT_DAEMON_LIFECYCLE: 'external',
      TREEPORT_WEB_DEVELOPMENT: '1',
      TREEPORT_SHELL: '/bin/bash'
    })

    expect(config.dataDir).toBe(path.join(process.env.HOME!, 'treeport-data'))
    expect(config.databasePath).toBe('/tmp/custom/treeport.db')
    expect(config.cacheDir).toBe('/tmp/custom/cache')
    expect(config.host).toBe('0.0.0.0')
    expect(config.port).toBe(5000)
    expect(config.apiUrl).toBe('http://example.test:5000')
    expect(config.shell).toBe('/bin/bash')
    expect(config.daemonLifecycle).toBe('external')
    expect(config.webDevelopment).toBe(true)
  })

  it('rejects invalid configuration', () => {
    expect(() => loadConfig({ TREEPORT_PORT: '70000' })).toThrow(
      'TREEPORT_PORT must be an integer between 1 and 65535'
    )
    expect(() =>
      loadConfig({ TREEPORT_DAEMON_LIFECYCLE: 'development' })
    ).toThrow('TREEPORT_DAEMON_LIFECYCLE must be either treeport or external')
  })
})
