export function isBrowserLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname) ||
    hostname === '[::1]'
  )
}
