import http, { type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import { RpcClient } from '@effect/rpc'
import {
  EVENT_PROTOCOL_VERSION,
  TreeportRpcs,
  treeportRpcClientLayer,
  type BrowserPanel,
  type ProjectEventsItem,
  type TerminalRuntimeMetadata,
  type WebPanel
} from '@treeport/shared'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductEventBus, type TreeportService } from './core/index'
import { makeRpcHttpApp } from './rpc-server'
import { testAccess } from './test-access'
import type { TerminalMetadataManager } from './terminal-metadata'

interface RpcFixture {
  readonly url: string
  readonly server: HttpServer
  readonly scope: Scope.CloseableScope
  readonly events: ProductEventBus
  readonly metadataSnapshot: ReturnType<
    typeof vi.fn<() => TerminalRuntimeMetadata[]>
  >
  readonly listWebPanels: ReturnType<
    typeof vi.fn<() => Effect.Effect<WebPanel[]>>
  >
  readonly listBrowserPanels: ReturnType<
    typeof vi.fn<() => Effect.Effect<BrowserPanel[]>>
  >
  close(): Promise<void>
}

const fixtures: RpcFixture[] = []

async function fixture(): Promise<RpcFixture> {
  const events = new ProductEventBus()
  const metadata: TerminalRuntimeMetadata = {
    terminalId: 'term',
    title: 'shell',
    program: null,
    progress: null,
    progressStartedAt: null,
    progressClearedAt: null,
    bell: null
  }
  const metadataSnapshot = vi.fn<() => TerminalRuntimeMetadata[]>(() => [
    metadata
  ])
  const terminalMetadata = testAccess<TerminalMetadataManager>({
    initialize: vi.fn(() => Effect.void),
    snapshot: metadataSnapshot
  })
  const listWebPanels = vi.fn<() => Effect.Effect<WebPanel[]>>(() =>
    Effect.succeed([])
  )
  const listBrowserPanels = vi.fn<() => Effect.Effect<BrowserPanel[]>>(() =>
    Effect.succeed([])
  )
  const service = testAccess<TreeportService>({
    events,
    panels: { listWebPanels, listBrowserPanels },
    runEffect: (effect: Effect.Effect<unknown, unknown, any>) =>
      // SAFETY: The fixture's effects require only services installed above.
      Effect.runPromise(effect as Effect.Effect<unknown, unknown, never>)
  })
  const scope = await Effect.runPromise(Scope.make())
  const app = await service.runEffect(
    Scope.extend(makeRpcHttpApp(service, terminalMetadata), scope)
  )
  const listener = await Effect.runPromise(NodeHttpServer.makeHandler(app))
  const server = http.createServer(listener)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // SAFETY: The server is listening on a TCP port.
  const address = server.address() as AddressInfo
  const value: RpcFixture = {
    url: `http://127.0.0.1:${address.port}/api/rpc`,
    server,
    scope,
    events,
    metadataSnapshot,
    listWebPanels,
    listBrowserPanels,
    close: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
  fixtures.push(value)
  return value
}

function collect(url: string, count: number): Promise<ProjectEventsItem[]> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(TreeportRpcs)
      return yield* client
        .WatchProjectEvents({
          protocol: EVENT_PROTOCOL_VERSION
        })
        .pipe(
          Stream.take(count),
          Stream.runCollect,
          // SAFETY: TreeportRpcs decodes every streamed item with its schema.
          Effect.map((items) => Array.from(items) as ProjectEventsItem[])
        )
    }).pipe(Effect.scoped, Effect.provide(treeportRpcClientLayer(url)))
  )
}

afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    await value.close()
  }
})

describe('Effect RPC project event stream', () => {
  it('sends an authoritative snapshot before only unrepresented ordered events', async () => {
    const value = await fixture()
    value.metadataSnapshot.mockImplementationOnce(() => {
      value.events.publish('terminal.metadata', {
        terminalId: 'term',
        title: 'represented-by-snapshot',
        program: null,
        progress: null,
        progressStartedAt: null,
        progressClearedAt: null,
        bell: null
      })
      setTimeout(() => {
        value.events.publish('terminal.metadata', {
          terminalId: 'term',
          title: 'incremental',
          program: null,
          progress: null,
          progressStartedAt: null,
          progressClearedAt: null,
          bell: null
        })
      }, 0)
      return [
        {
          terminalId: 'term',
          title: 'represented-by-snapshot',
          program: null,
          progress: null,
          progressStartedAt: null,
          progressClearedAt: null,
          bell: null
        }
      ]
    })

    const received = await collect(value.url, 2)
    expect(
      received.map((item) =>
        item._tag === 'Snapshot'
          ? `snapshot:${item.snapshot.terminalMetadata[0]?.title}`
          : `event:${item.event.type === 'terminal.metadata' ? item.event.data.title : item.event.type}`
      )
    ).toEqual(['snapshot:represented-by-snapshot', 'event:incremental'])
  })

  it('fails a stream that exceeds its bounded pre-snapshot queue', async () => {
    const value = await fixture()
    value.metadataSnapshot.mockImplementationOnce(() => {
      for (let sequence = 1; sequence <= 257; sequence += 1) {
        value.events.publish('terminal.metadata', {
          terminalId: 'term',
          title: `queued-${sequence}`,
          program: null,
          progress: null,
          progressStartedAt: null,
          progressClearedAt: null,
          bell: null
        })
      }
      return []
    })

    await expect(collect(value.url, 2)).rejects.toThrow(/could not keep up/i)
  })

  it('isolates clients while streaming durable panels and bell acknowledgements to both', async () => {
    const value = await fixture()
    value.listWebPanels.mockReturnValue(
      Effect.succeed([
        {
          id: 'panel_review',
          kind: 'web',
          worktreeId: 'wt',
          definitionId: 'project:review',
          title: 'Review',
          launch: { input: null, cwd: null },
          permissions: [],
          sandbox: { allowSameOrigin: false },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ])
    )
    value.listBrowserPanels.mockReturnValue(
      Effect.succeed([
        {
          id: 'panel_browser',
          kind: 'browser',
          worktreeId: 'wt',
          title: 'Example',
          url: 'https://example.com/',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ])
    )

    const first = collect(value.url, 2)
    const second = collect(value.url, 2)
    await vi.waitFor(() => expect(value.listWebPanels).toHaveBeenCalledTimes(2))
    value.events.publish('terminal.metadata', {
      terminalId: 'term',
      title: 'shell',
      program: null,
      progress: null,
      progressStartedAt: null,
      progressClearedAt: null,
      bell: {
        sequence: 1,
        at: '2026-01-01T00:02:00.000Z',
        unread: false
      }
    })

    const clients = await Promise.all([first, second])
    for (const received of clients) {
      expect(received[0]).toMatchObject({
        _tag: 'Snapshot',
        snapshot: {
          webPanels: [{ id: 'panel_review' }],
          browserPanels: [{ id: 'panel_browser', url: 'https://example.com/' }]
        }
      })
      expect(received[1]).toMatchObject({
        _tag: 'ProductEvent',
        event: {
          type: 'terminal.metadata',
          data: { bell: { sequence: 1, unread: false } }
        }
      })
    }
  })
})
