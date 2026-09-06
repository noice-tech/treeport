import crypto from 'node:crypto'
import { BrowserWindow, session, type WebContents } from 'electron'
import { BROWSER_VIDEO_CAPTURE_SOURCE } from '@treeport/shared'
import * as Effect from 'effect/Effect'
import * as Scope from 'effect/Scope'
import { DesktopRuntime } from './desktop-runtime'

const captureGrants = new WeakMap<
  WebContents,
  {
    helper: WebContents
    origin: string
    starting: boolean
    capture: DesktopRuntime
  }
>()

export function permitsBrowserVideoCapture(
  guest: WebContents,
  permission: string,
  details: Electron.MediaAccessPermissionRequest
): boolean {
  const grant = captureGrants.get(guest)
  const origin =
    details.securityOrigin && URL.canParse(details.securityOrigin)
      ? new URL(details.securityOrigin).origin
      : null
  // Electron asks the SOURCE guest's permission handler for tab capture. Only
  // the exact registered helper may capture, during its initial getUserMedia.
  return (
    !!grant &&
    grant.starting &&
    !grant.helper.isDestroyed() &&
    permission === 'media' &&
    details.mediaTypes?.length === 0 &&
    origin === grant.origin &&
    grant.helper.getURL() === `${grant.origin}/`
  )
}

export class ElectronBrowserVideo {
  private helper: BrowserWindow | null = null
  private capture: DesktopRuntime | null = null

  constructor(
    private readonly guest: WebContents,
    private readonly runtime: DesktopRuntime
  ) {}

  start(width: number, height: number, publish: (payload: string) => void) {
    return Effect.gen(this, function* () {
      if (this.helper) {
        return
      }

      const capture = new DesktopRuntime(this.runtime)
      this.capture = capture
      yield* Effect.gen(this, function* () {
        const origin = `https://${crypto.randomUUID()}.treeport-video.invalid`
        const captureSession = session.fromPartition(
          `treeport-video-${crypto.randomUUID()}`
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            captureSession.protocol.handle(
              'https',
              (request) =>
                new Response(
                  request.url === `${origin}/`
                    ? '<!doctype html><title>Treeport Browser capture</title>'
                    : '',
                  {
                    status: request.url === `${origin}/` ? 200 : 403,
                    headers: {
                      'content-type': 'text/html',
                      'content-security-policy':
                        "default-src 'none'; script-src 'none'"
                    }
                  }
                )
            )
          ),
          () =>
            Effect.sync(() => {
              captureSession.protocol.unhandle('https')
              captureSession.setPermissionCheckHandler(() => false)
              captureSession.setPermissionRequestHandler(
                (_contents, _permission, callback) => callback(false)
              )
            })
        )
        const helper = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new BrowserWindow({
                show: false,
                webPreferences: {
                  session: captureSession,
                  nodeIntegration: false,
                  contextIsolation: true,
                  sandbox: true,
                  webSecurity: true,
                  backgroundThrottling: false
                }
              })
          ),
          (helper) =>
            Effect.sync(() => {
              if (captureGrants.get(this.guest)?.capture === capture) {
                captureGrants.delete(this.guest)
              }

              if (this.helper === helper) {
                this.helper = null
              }

              if (this.capture === capture) {
                this.capture = null
              }

              if (!helper.isDestroyed()) {
                helper.destroy()
              }
            })
        )
        this.helper = helper
        const grant = {
          helper: helper.webContents,
          origin,
          starting: true,
          capture
        }
        captureGrants.set(this.guest, grant)
        captureSession.setPermissionCheckHandler(
          (contents, permission) =>
            contents === helper.webContents &&
            permission === 'media' &&
            contents.getURL() === `${origin}/`
        )
        captureSession.setPermissionRequestHandler(
          (contents, permission, callback) =>
            callback(
              contents === helper.webContents &&
                permission === 'media' &&
                contents.getURL() === `${origin}/`
            )
        )
        helper.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        helper.webContents.on('will-navigate', (event) =>
          event.preventDefault()
        )
        const lost = () => {
          if (this.capture !== capture) {
            return
          }

          publish(
            JSON.stringify({
              frame: null,
              error: 'Browser video capture stopped. Reconnect to restart it.'
            })
          )
          this.runtime.fork(this.stop)
        }
        helper.webContents.once('render-process-gone', lost)
        helper.once('closed', lost)
        yield* Effect.tryPromise(() => helper.loadURL(`${origin}/`))
        helper.webContents.debugger.attach('1.3')
        yield* Effect.tryPromise(() =>
          helper.webContents.debugger.sendCommand('Runtime.enable')
        )
        yield* Effect.tryPromise(() =>
          helper.webContents.debugger.sendCommand('Runtime.addBinding', {
            name: '__treeportVideoFrame'
          })
        )
        helper.webContents.debugger.on('message', (_event, method, params) => {
          if (
            this.helper !== helper ||
            method !== 'Runtime.bindingCalled' ||
            params.name !== '__treeportVideoFrame'
          ) {
            return
          }

          publish(params.payload)
          capture.fork(
            Effect.tryPromise(() =>
              helper.webContents.debugger.sendCommand('Runtime.evaluate', {
                expression: 'globalThis.__treeportVideo?.acknowledge()'
              })
            )
          )
        })
        const sourceId = this.guest.getMediaSourceId(helper.webContents)
        const error: string | null = yield* Effect.tryPromise(() =>
          helper.webContents.executeJavaScript(`(async () => {
          globalThis.__treeportVideo = await ${BROWSER_VIDEO_CAPTURE_SOURCE}(${JSON.stringify(sourceId)}, ${width}, ${height}, globalThis.__treeportVideoFrame);
          return null;
        })().catch(error => error.name + ': ' + error.message)`)
        )
        grant.starting = false
        if (error) {
          return yield* Effect.fail(new Error(error))
        }
      }).pipe(
        Scope.extend(capture.scope),
        Effect.timeout('10 seconds'),
        Effect.onError(() => capture.close)
      )
    })
  }

  readonly requestKeyframe = Effect.suspend(() => {
    const helper = this.helper
    return helper
      ? Effect.tryPromise(() =>
          helper.webContents.debugger.sendCommand('Runtime.evaluate', {
            expression: 'globalThis.__treeportVideo?.requestKeyframe()'
          })
        ).pipe(Effect.asVoid)
      : Effect.void
  })

  readonly stop = Effect.suspend(() => {
    const capture = this.capture
    this.capture = null
    this.helper = null
    return capture?.close ?? Effect.void
  })
}
