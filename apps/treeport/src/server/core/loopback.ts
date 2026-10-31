const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase())
}

export function assertLoopbackHost(host: string): void {
  if (isLoopbackHost(host)) {
    return
  }

  throw new Error(
    'Treeport supports only loopback listeners. Run `pnpm start`, then configure `tailscale serve` yourself for private remote access.'
  )
}
