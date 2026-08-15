const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase())
}

export function assertLoopbackHost(host: string): void {
  if (isLoopbackHost(host)) {
    return
  }

  throw new Error(
    'Treeport supports only loopback listeners. Run `treeport start --host 127.0.0.1`, then use `treeport remote enable` for private remote access.'
  )
}
