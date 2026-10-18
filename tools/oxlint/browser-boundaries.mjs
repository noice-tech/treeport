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
      sizing:
        'Only PlaywrightBrowser in playwright-browser.ts may set page viewports. Capture and clipboard helpers receive unsized page capabilities from PlaywrightBrowserHost.',
      viewport:
        'Browser contexts must end their options with viewport: null. PlaywrightBrowser owns per-page sizing; a context default resets other tabs when helpers open.'
    }
  },
  create(context) {
    const source = path
      .relative(root, context.filename)
      .replaceAll(path.sep, '/')
    if (
      !source.startsWith('apps/treeport/src/server/') ||
      source.endsWith('.test.ts')
    ) {
      return {}
    }

    const propertyName = (node) =>
      node.computed ? node.property.value : node.property.name

    return {
      MemberExpression(node) {
        if (
          source !== 'apps/treeport/src/server/playwright-browser.ts' &&
          propertyName(node) === 'setViewportSize'
        ) {
          context.report({ node, messageId: 'sizing' })
        }

        if (source !== pageHost && allocationMethods.has(propertyName(node))) {
          context.report({ node, messageId: 'allocation' })
        }
      },
      Property(node) {
        if (
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
