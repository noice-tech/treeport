import crypto from 'node:crypto'
import { BrowserWindow, session, type WebContents } from 'electron'
import { BROWSER_VIDEO_CAPTURE_SOURCE } from '@treeport/shared'

const captureGrants = new WeakMap<
  WebContents,
  { helper: WebContents; origin: string; starting: boolean }
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
  // Electron asks the SOURCE guest's permission handler for tab capture. This
  // exception is only for its registered helper during getUserMedia. Ordinary
  // guest camera/microphone requests and all other origins remain denied.
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
  private readonly partition = `treeport-video-${crypto.randomUUID()}`

  constructor(private readonly guest: WebContents) {}

  async start(
    width: number,
    height: number,
    publish: (payload: string) => void
  ): Promise<void> {
    if (this.helper) {
      return
    }

    const origin = `https://${crypto.randomUUID()}.treeport-video.invalid`
    // This in-memory session serves one trusted, empty document. It cannot load
    // external content and does not share the guest's permission policy or data.
    const captureSession = session.fromPartition(this.partition)
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
              'content-security-policy': "default-src 'none'; script-src 'none'"
            }
          }
        )
    )
    const helper = new BrowserWindow({
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
    this.helper = helper
    const grant = { helper: helper.webContents, origin, starting: true }
    captureGrants.set(this.guest, grant)
    // Electron's tab-source checks supply an empty requestingOrigin. Authorize
    // the exact helper WebContents and its committed, locally served document.
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
    helper.webContents.on('will-navigate', (event) => event.preventDefault())
    helper.webContents.once('render-process-gone', () => {
      if (this.helper === helper) {
        this.stop()
        publish(
          JSON.stringify({
            frame: null,
            error: 'Browser video capture crashed. Select Retry to restart it.'
          })
        )
      }
    })
    helper.once('closed', () => {
      if (captureGrants.get(this.guest) === grant) {
        captureGrants.delete(this.guest)
      }

      captureSession.protocol.unhandle('https')
      captureSession.setPermissionCheckHandler(() => false)
      captureSession.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false)
      )
      if (this.helper === helper) {
        this.helper = null
        publish(
          JSON.stringify({
            frame: null,
            error: 'Browser video capture stopped. Reconnect to restart it.'
          })
        )
      }
    })
    await (async () => {
      await helper.loadURL(`${origin}/`)
      helper.webContents.debugger.attach('1.3')
      await helper.webContents.debugger.sendCommand('Runtime.enable')
      await helper.webContents.debugger.sendCommand('Runtime.addBinding', {
        name: '__treeportVideoFrame'
      })
      helper.webContents.debugger.on('message', (_event, method, params) => {
        if (
          this.helper !== helper ||
          method !== 'Runtime.bindingCalled' ||
          params.name !== '__treeportVideoFrame'
        ) {
          return
        }

        publish(params.payload)
        void helper.webContents.debugger
          .sendCommand('Runtime.evaluate', {
            expression: 'globalThis.__treeportVideo?.acknowledge()'
          })
          .catch(() => undefined)
      })
      const sourceId = this.guest.getMediaSourceId(helper.webContents)
      const error: string | null = await helper.webContents
        .executeJavaScript(`(async () => {
        globalThis.__treeportVideo = await ${BROWSER_VIDEO_CAPTURE_SOURCE}(${JSON.stringify(sourceId)}, ${width}, ${height}, globalThis.__treeportVideoFrame);
        return null;
      })().catch(error => error.name + ': ' + error.message)`)
      grant.starting = false
      if (error) {
        throw new Error(error)
      }
    })().catch((error) => {
      this.stop()
      throw error
    })
  }

  async requestKeyframe(): Promise<void> {
    await this.helper?.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: 'globalThis.__treeportVideo?.requestKeyframe()'
    })
  }

  stop(): void {
    const helper = this.helper
    this.helper = null
    if (captureGrants.get(this.guest)?.helper === helper?.webContents) {
      captureGrants.delete(this.guest)
    }

    if (helper && !helper.isDestroyed()) {
      helper.destroy()
    }
  }
}
