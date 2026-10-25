import path from 'node:path'
import { isBuiltin } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ResolverFactory } from 'oxc-resolver'

const root = fileURLToPath(new URL('../../', import.meta.url))

// Package ownership must be known even on a clean checkout, before exported
// declaration files have been built.
const workspaceOwners = new Map()

for (const directory of ['apps', 'packages']) {
  for (const entry of readdirSync(path.join(root, directory), {
    withFileTypes: true
  })) {
    const owner = `${directory}/${entry.name}`
    const manifest = path.join(root, owner, 'package.json')

    if (entry.isDirectory() && existsSync(manifest)) {
      workspaceOwners.set(
        JSON.parse(readFileSync(manifest, 'utf8')).name,
        owner
      )
    }
  }
}

const resolver = new ResolverFactory({
  tsconfig: 'auto',
  conditionNames: ['types', 'import', 'node', 'default'],
  extensions: ['.ts', '.tsx', '.d.ts', '.js', '.mjs', '.json', '.css'],
  extensionAlias: { '.js': ['.ts', '.js'] }
})

const webResolver = resolver.cloneWithOptions({
  tsconfig: { configFile: path.join(root, 'apps/treeport/tsconfig.web.json') }
})

const desktopPackages = new Set([
  '@treeport/desktop-bridge',
  '@treeport/theme/styles.css',
  '@treeport/shared/browser-host',
  '@treeport/shared/tracing'
])

// Keep these leaf modules independent too: a facade must not smuggle the
// application protocol back into desktop through a transitive dependency.
const nativeUtilities = new Set([
  'packages/shared/src/browser-host.ts',
  'packages/shared/src/browser-clipboard.ts',
  'packages/shared/src/browser-video.ts',
  'packages/shared/src/schema.ts',
  'packages/shared/src/tracing.ts'
])

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep desktop, daemon workspace, and native contracts independent'
    },
    schema: [],
    messages: {
      boundary: '{{reason}} Import: {{specifier}}',
      declaration:
        'The desktop bridge is a dependency-free, type-only contract. No runtime declarations or imports belong here.',
      optional:
        'DesktopBridge must remain Readonly<Partial<...>>. Native enhancements cannot become workspace prerequisites.',
      computed:
        'Desktop imports must use literal module names so its dependency boundary can be checked.'
    }
  },
  create(context) {
    const filename = context.filename
    const source = path.relative(root, filename).replaceAll(path.sep, '/')
    const owner = source.match(/^(apps|packages)\/[^/]+/)?.[0] ?? null
    const desktop = source.startsWith('apps/desktop/src/')
    const shell = source.startsWith('apps/desktop/src/shell/')
    const bridge = source.startsWith('packages/desktop-bridge/src/')
    const nativeUtility = nativeUtilities.has(source)

    if (!owner) {
      return {}
    }

    function check(node, sourceNode, typeOnly = false) {
      const specifier =
        sourceNode?.type === 'TemplateLiteral' &&
        sourceNode.expressions.length === 0
          ? sourceNode.quasis[0].value.cooked
          : sourceNode?.value

      if (bridge) {
        context.report({ node, messageId: 'declaration' })

        return
      }

      // eslint-disable-next-line anti-slop/no-runtime-typeof -- The parser supplies literal values; distinguish string imports from computed expressions.
      if (typeof specifier !== 'string') {
        if (desktop || nativeUtility) {
          context.report({ node, messageId: 'computed' })
        }

        return
      }

      const resolved =
        (source.startsWith('apps/treeport/src/web/')
          ? webResolver
          : resolver
        ).resolveFileSync(filename, specifier).path ??
        (specifier.startsWith('.') || path.isAbsolute(specifier)
          ? path.resolve(path.dirname(filename), specifier)
          : null)

      const target = resolved
        ? path.relative(root, resolved).replaceAll(path.sep, '/')
        : null

      const packageName = specifier
        .split('/')
        .slice(0, specifier.startsWith('@') ? 2 : 1)
        .join('/')

      const targetOwner =
        target?.match(/^(apps|packages)\/[^/]+/)?.[0] ??
        workspaceOwners.get(packageName) ??
        null

      let reason = null

      if (targetOwner?.startsWith('apps/') && targetOwner !== owner) {
        reason =
          'Applications are independent release units; packages and other applications must not import their implementation.'
      } else if (
        desktop &&
        (specifier.startsWith('@treeport/') ||
          specifier === '@treeport-web' ||
          specifier.startsWith('@treeport-web/')) &&
        !desktopPackages.has(specifier)
      ) {
        reason =
          'Desktop may import only the optional bridge contract, theme, browser-host primitives, and tracing—not workspace APIs or release protocols.'
      } else if (
        desktop &&
        target &&
        targetOwner !== owner &&
        !desktopPackages.has(specifier)
      ) {
        // Third-party dependencies resolve under node_modules. Repository code
        // outside desktop must use one of the explicit package entry points.
        if (!target.startsWith('node_modules/') && !target.startsWith('../')) {
          reason =
            'Do not bypass the desktop package boundary with a source path or alias.'
        }
      }

      if (
        shell &&
        targetOwner === owner &&
        !target?.startsWith('apps/desktop/src/shell/')
      ) {
        if (target !== 'apps/desktop/src/desktop-contract.ts' || !typeOnly) {
          reason =
            'The shell renderer may import only its own implementation and types from desktop-contract; privileged code belongs in main/preload.'
        }
      }

      if (
        shell &&
        (specifier.startsWith('@treeport/shared') ||
          specifier === 'electron' ||
          isBuiltin(specifier))
      ) {
        reason =
          'The shell renderer has no daemon client or Node/Electron access; use its private preload contract.'
      }

      if (
        nativeUtility &&
        target &&
        !target.startsWith('node_modules/') &&
        !target.startsWith('../') &&
        !nativeUtilities.has(target)
      ) {
        reason =
          'Native host utilities must remain leaf modules, independent of workspace schemas and application code.'
      }

      if (
        (desktop || nativeUtility) &&
        /^@effect\/rpc(?:\/|$)/.test(specifier)
      ) {
        reason =
          'Native host code must not depend on the daemon application RPC protocol.'
      }

      if (
        (desktop || nativeUtility) &&
        !resolved &&
        !isBuiltin(specifier) &&
        !desktopPackages.has(specifier)
      ) {
        reason =
          'Native imports must resolve to checkable modules. Use explicit package entry points or TypeScript paths, not hidden bundler aliases.'
      }

      if (specifier === '@treeport/desktop-bridge' && !typeOnly) {
        reason =
          'The optional desktop bridge exports types only; use import type.'
      }

      if (reason) {
        context.report({
          node,
          messageId: 'boundary',
          data: { reason, specifier }
        })
      }
    }

    return {
      ImportDeclaration(node) {
        check(
          node,
          node.source,
          node.importKind === 'type' ||
            (node.specifiers.length > 0 &&
              node.specifiers.every((item) => item.importKind === 'type'))
        )
      },
      ExportNamedDeclaration(node) {
        if (node.source) {
          check(node, node.source, node.exportKind === 'type')
        }
      },
      ExportAllDeclaration(node) {
        check(node, node.source, node.exportKind === 'type')
      },
      ImportExpression(node) {
        check(node, node.source)
      },
      TSImportType(node) {
        check(node, node.source, true)
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type === 'TSExternalModuleReference') {
          check(
            node,
            node.moduleReference.expression,
            node.importKind === 'type'
          )
        }
      },
      CallExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require'
        ) {
          check(node, node.arguments[0])
        }
      },
      Program(node) {
        if (!bridge) {
          return
        }

        for (const statement of node.body) {
          const declaration =
            statement.type === 'ExportNamedDeclaration'
              ? statement.declaration
              : statement

          if (
            !['TSTypeAliasDeclaration', 'TSInterfaceDeclaration'].includes(
              declaration?.type
            )
          ) {
            context.report({ node: statement, messageId: 'declaration' })
          }
        }
      },
      TSInterfaceDeclaration(node) {
        if (bridge && node.id.name === 'DesktopBridge') {
          context.report({ node, messageId: 'optional' })
        }
      },
      TSTypeAliasDeclaration(node) {
        if (!bridge || node.id.name !== 'DesktopBridge') {
          return
        }

        const outer = node.typeAnnotation
        const inner = outer.typeArguments?.params[0]

        if (
          outer.typeName?.name !== 'Readonly' ||
          inner?.typeName?.name !== 'Partial'
        ) {
          context.report({ node, messageId: 'optional' })
        }
      }
    }
  }
}
