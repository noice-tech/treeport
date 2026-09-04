import * as FetchHttpClient from '@effect/platform/FetchHttpClient'
import { RpcClient, RpcSerialization } from '@effect/rpc'
import * as Layer from 'effect/Layer'

export function treeportRpcClientLayer(url: string) {
  return RpcClient.layerProtocolHttp({ url }).pipe(
    Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson])
  )
}
