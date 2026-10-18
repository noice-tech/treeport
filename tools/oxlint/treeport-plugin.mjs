import moduleBoundaries from './module-boundaries.mjs'
import browserBoundaries from './browser-boundaries.mjs'

const noRecordStringUnknown = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require domain types instead of Record<string, unknown>'
    },
    messages: {
      useDomainType:
        'Replace this generic record with a domain type, and parse the data as early and as close to its I/O boundary as possible.'
    },
    schema: []
  },
  create(context) {
    return {
      TSTypeReference(node) {
        const typeArguments = node.typeArguments?.params

        if (
          node.typeName.type === 'Identifier' &&
          node.typeName.name === 'Record' &&
          typeArguments?.length === 2 &&
          typeArguments[0].type === 'TSStringKeyword' &&
          typeArguments[1].type === 'TSUnknownKeyword'
        ) {
          context.report({ messageId: 'useDomainType', node })
        }
      }
    }
  }
}

const noBrowserTestState = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep Playwright specs independent of browser test hooks and storage'
    },
    messages: {
      testHook:
        'Do not access __ test hooks in specs. Assert user-visible behavior or messages received at the mock server boundary instead.',
      browserStorage:
        'Do not inspect browser storage in specs. Verify persistence through UI interactions and reloads; keep fixture setup in support modules.'
    },
    schema: []
  },
  create(context) {
    return {
      MemberExpression(node) {
        const property = node.computed
          ? node.property.type === 'Literal'
            ? String(node.property.value)
            : ''
          : node.property.name
        if (property.startsWith('__')) {
          context.report({ messageId: 'testHook', node })
        } else if (
          property === 'localStorage' ||
          property === 'sessionStorage'
        ) {
          context.report({ messageId: 'browserStorage', node })
        }
      },
      Identifier(node) {
        const testHook =
          node.name.startsWith('__') &&
          node.name !== '__dirname' &&
          node.name !== '__filename'
        if (
          !testHook &&
          node.name !== 'localStorage' &&
          node.name !== 'sessionStorage'
        ) {
          return
        }

        // Member access is reported above, including aliases such as browser.localStorage.
        if (
          node.parent.type === 'MemberExpression' &&
          node.parent.property === node &&
          !node.parent.computed
        ) {
          return
        }

        if (
          testHook &&
          node.parent.type === 'Property' &&
          node.parent.parent.type === 'ObjectPattern'
        ) {
          return
        }

        context.report({
          messageId: testHook ? 'testHook' : 'browserStorage',
          node
        })
      },
      Property(node) {
        if (node.parent.type !== 'ObjectPattern') {
          return
        }

        const property = node.computed
          ? node.key.type === 'Literal'
            ? String(node.key.value)
            : ''
          : (node.key.name ?? String(node.key.value))
        if (property.startsWith('__')) {
          context.report({ messageId: 'testHook', node })
        }
      }
    }
  }
}

export default {
  meta: {
    name: 'treeport'
  },
  rules: {
    'no-record-string-unknown': noRecordStringUnknown,
    'module-boundaries': moduleBoundaries,
    'browser-boundaries': browserBoundaries,
    'no-browser-test-state': noBrowserTestState
  }
}
