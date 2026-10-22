import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Page } from 'playwright'

export async function prepareBrowserVideoExtension(directory: string) {
  // A fresh public identity scopes unattended capture to this host's extension.
  // No signing key is retained, and websites cannot invoke this extension.
  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048
  })
  const key = publicKey.export({ format: 'der', type: 'spki' })
  const id = crypto
    .createHash('sha256')
    .update(key)
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (value) =>
      String.fromCharCode(97 + Number.parseInt(value, 16))
    )
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await Promise.all([
    fs.writeFile(
      path.join(directory, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Treeport Browser capture',
        version: '1.0',
        key: key.toString('base64'),
        // getTargets maps the exact CDP target to its tab. No debugger attaches
        // and no page is selected by URL, title, focus, or screen position.
        permissions: ['tabCapture', 'debugger'],
        background: { service_worker: 'worker.js' },
        // Tab capture paints Chromium's cursor image after native pointer
        // input. A transparent root cursor hides it wherever the page sets no
        // cursor; reported cursors use its `auto` fallback.
        content_scripts: [
          {
            matches: ['<all_urls>'],
            css: ['cursor.css'],
            all_frames: true,
            match_origin_as_fallback: true,
            run_at: 'document_start'
          }
        ]
      }),
      { mode: 0o600 }
    ),
    fs.writeFile(
      path.join(directory, 'cursor.css'),
      `:where(:root) { cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E") 0 0, auto; }`,
      { mode: 0o600 }
    ),
    fs.writeFile(
      path.join(directory, 'worker.js'),
      'chrome.runtime.onInstalled.addListener(() => {});',
      { mode: 0o600 }
    ),
    fs.writeFile(
      path.join(directory, 'capture.html'),
      '<!doctype html><title>Treeport Browser capture</title>',
      { mode: 0o600 }
    )
  ])
  return { id, directory }
}

export interface BrowserCapturePage {
  readonly page: Pick<Page, 'goto' | 'evaluate' | 'once' | 'close'>
  readonly targetId: string
}
