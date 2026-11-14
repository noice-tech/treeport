import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

const execute = promisify(execFile)

const serveStatusSchema = Schema.parseJson(
  Schema.Struct({
    Web: Schema.optional(
      Schema.Record({
        key: Schema.String,
        value: Schema.Struct({
          Handlers: Schema.optional(
            Schema.Record({
              key: Schema.String,
              value: Schema.Struct({ Proxy: Schema.optional(Schema.String) })
            })
          )
        })
      })
    )
  })
)

const statusSchema = Schema.parseJson(
  Schema.Struct({
    Self: Schema.Struct({
      HostName: Schema.String,
      UserID: Schema.Number
    }),
    User: Schema.optional(
      Schema.Record({
        key: Schema.String,
        value: Schema.Struct({ LoginName: Schema.String })
      })
    )
  })
)

// EXTERNAL: Tailscale Serve owns the remote address. Read its routes instead of
// configuring one, so routes added by the desktop app or by hand both work.
export async function tailscaleServeUrl(
  port: number
): Promise<{ installed: boolean; url: string | null }> {
  const status = await execute('tailscale', ['serve', 'status', '--json'], {
    timeout: 5_000
  }).then(
    ({ stdout }) =>
      Option.getOrElse(
        Schema.decodeUnknownOption(serveStatusSchema)(stdout),
        () => ({
          Web: undefined
        })
      ),
    () => null
  )

  if (!status) {
    return { installed: false, url: null }
  }

  const hostPort = Object.entries(status.Web ?? {}).find(([, server]) => {
    const proxy = URL.parse(server.Handlers?.['/']?.Proxy ?? '')

    return (
      proxy !== null &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(proxy.hostname) &&
      proxy.port === String(port)
    )
  })?.[0]

  return {
    installed: true,
    url: hostPort ? `https://${hostPort.replace(/:443$/u, '')}` : null
  }
}

export async function tailscaleSelf(): Promise<{
  name: string
  ownerLogin: string | null
} | null> {
  const status = await execute('tailscale', ['status', '--json'], {
    timeout: 5_000
  }).then(
    ({ stdout }) =>
      Option.getOrNull(Schema.decodeUnknownOption(statusSchema)(stdout)),
    () => null
  )

  if (!status) {
    return null
  }

  return {
    name: status.Self.HostName,
    ownerLogin: status.User?.[String(status.Self.UserID)]?.LoginName ?? null
  }
}
