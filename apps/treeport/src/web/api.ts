import { hc } from 'hono/client'
import type { AppType, TreeFilesApiType } from '../server/app'

export class RpcNetworkError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    cause: unknown
  ) {
    super('Treeport could not be reached', { cause })
    this.name = 'RpcNetworkError'
  }
}

const rpcFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init)
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') {
      throw cause
    }

    const request = input instanceof Request ? input : null
    const url = new URL(
      request?.url ?? String(input),
      globalThis.location?.href ?? 'http://localhost'
    )
    const method = String(init?.method ?? request?.method ?? 'GET')
      .toUpperCase()
      .slice(0, 16)
    throw new RpcNetworkError(method, url.pathname.slice(0, 2_048), cause)
  }
}

export const rpc = hc<AppType>('/', { fetch: rpcFetch })
export const treeFilesRpc = hc<TreeFilesApiType>('/', { fetch: rpcFetch })
