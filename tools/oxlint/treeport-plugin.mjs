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

const allowedComment =
  /^\s*(?:eslint-disable|eslint-enable|oxlint-disable|oxlint-enable|@ts-expect-error|@ts-ignore|@ts-nocheck|prettier-ignore|oxfmt-ignore|@vite-ignore\b|\/\s*<reference\s|EXTERNAL:)|\bSAFETY\s*:|\bCopyright\b|SPDX-License-Identifier|@license\b/

const noComments = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Ban comments except tool directives, doc comments, SAFETY and EXTERNAL notes, and license headers'
    },
    messages: {
      noComment:
        'Delete this comment. Make the code say it through names, types, or structure. Only behavior forced by a dependency, platform, or protocol may stay, as an `EXTERNAL:` note.'
    },
    schema: []
  },
  create(context) {
    return {
      Program() {
        let allowedLineEnd = -1

        for (const comment of context.sourceCode.getAllComments()) {
          const continuation =
            comment.type === 'Line' &&
            comment.loc.start.line === allowedLineEnd + 1

          const allowed =
            comment.type === 'Shebang' ||
            (comment.type === 'Block' && comment.value.startsWith('*')) ||
            continuation ||
            allowedComment.test(comment.value)

          allowedLineEnd =
            allowed && comment.type === 'Line' ? comment.loc.end.line : -1

          if (!allowed) {
            context.report({ messageId: 'noComment', loc: comment.loc })
          }
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
    'no-browser-test-state': noBrowserTestState,
    'no-comments': noComments
  }
}
