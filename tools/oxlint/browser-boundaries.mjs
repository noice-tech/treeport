import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const pageHost = 'apps/treeport/src/server/browser-page-host.ts'

const allocationMethods = new Set([
  'newPage',
  'newContext',
  'launchPersistentContext'
])

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Keep browser page allocation inside its owning host'
    },
    schema: [],
    messages: {
      allocation:
        'PlaywrightBrowserHost in browser-page-host.ts owns page allocation. Use its page lease/openCapturePage or scoped clipboard reader; helper tabs must not create contexts or pages.',
      viewport:
        'Browser contexts must end their options with viewport: null. PlaywrightBrowser owns per-page sizing; a context default resets other tabs when helpers open.',
      sizing:
        'Only PlaywrightBrowser in playwright-browser.ts may set page viewports. Capture and clipboard helpers receive unsized page capabilities from PlaywrightBrowserHost.',
      signaling:
        'BrowserVideoViewer owns videoReady/videoAnswer. Call resume/offer/suspend on the viewer instead of sending handshake messages directly.',
      receiver:
        'Use connectRemoteBrowser from browser-remote-connection.ts. Signaling and media must share one visibility/disposal boundary.'
    }
  },
  create(context) {
    const source = path
      .relative(root, context.filename)
      .replaceAll(path.sep, '/')

    const server = source.startsWith('apps/treeport/src/server/')
    const web = source.startsWith('apps/treeport/src/web/')

    if ((!server && !web) || /\.test\.tsx?$/.test(source)) {
      return {}
    }

    const propertyName = (node) =>
      node.computed ? node.property.value : node.property.name

    const checkImport = (node, sourceNode, typeOnly = false) => {
      if (
        !web ||
        source === 'apps/treeport/src/web/browser-remote-connection.ts'
      ) {
        return
      }

      const specifier = sourceNode?.value

      if (
        /(?:^|\/)browser-video-receiver(?:\.[jt]s)?$/.test(specifier) ||
        (!typeOnly &&
          /(?:^|\/)browser-session-client(?:\.[jt]s)?$/.test(specifier))
      ) {
        context.report({ node, messageId: 'receiver' })
      }
    }

    return {
      ImportDeclaration(node) {
        checkImport(
          node,
          node.source,
          node.importKind === 'type' ||
            (node.specifiers.length > 0 &&
              node.specifiers.every((item) => item.importKind === 'type'))
        )
      },
      ExportNamedDeclaration(node) {
        if (node.source) {
          checkImport(node, node.source, node.exportKind === 'type')
        }
      },
      ExportAllDeclaration(node) {
        checkImport(node, node.source, node.exportKind === 'type')
      },
      ImportExpression(node) {
        checkImport(node, node.source)
      },
      MemberExpression(node) {
        if (
          server &&
          source !== 'apps/treeport/src/server/playwright-browser.ts' &&
          propertyName(node) === 'setViewportSize'
        ) {
          context.report({ node, messageId: 'sizing' })
        }

        if (
          server &&
          source !== pageHost &&
          allocationMethods.has(propertyName(node))
        ) {
          context.report({ node, messageId: 'allocation' })
        }
      },
      Property(node) {
        if (
          server &&
          source !== 'apps/treeport/src/server/browser-video-viewer.ts' &&
          (node.key.name ?? node.key.value) === 'type' &&
          ['videoReady', 'videoAnswer'].includes(node.value.value)
        ) {
          context.report({ node, messageId: 'signaling' })
        }

        if (
          server &&
          source !== pageHost &&
          node.parent.type === 'ObjectPattern' &&
          allocationMethods.has(node.key.name ?? node.key.value)
        ) {
          context.report({ node, messageId: 'allocation' })
        }
      },
      CallExpression(node) {
        if (source !== pageHost || node.callee.type !== 'MemberExpression') {
          return
        }

        const method = propertyName(node.callee)

        if (method !== 'newContext' && method !== 'launchPersistentContext') {
          return
        }

        const options = node.arguments[method === 'newContext' ? 0 : 1]

        const viewport =
          options?.type === 'ObjectExpression'
            ? options.properties.at(-1)
            : null

        if (
          viewport?.type !== 'Property' ||
          viewport.computed ||
          (viewport.key.name ?? viewport.key.value) !== 'viewport' ||
          viewport.value.type !== 'Literal' ||
          viewport.value.value !== null
        ) {
          context.report({ node, messageId: 'viewport' })
        }
      }
    }
  }
}
