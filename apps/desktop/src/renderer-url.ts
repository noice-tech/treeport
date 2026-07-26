export function parseRendererUrl(value: string): URL {
  if (!URL.canParse(value)) {
    throw new Error('TREEPORT_DESKTOP_URL must be a valid local URL')
  }

  const url = new URL(value)
  const httpLoopback =
    url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (!httpLoopback) {
    throw new Error('TREEPORT_DESKTOP_URL must use HTTP on loopback')
  }

  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url
}
