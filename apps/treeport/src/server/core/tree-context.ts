import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  TREE_CONTEXT_FIELD_MAX_COUNT,
  treeContextFieldDefinitionSchema,
  type TreeContextFieldDefinition,
  type TreeContextFieldDiagnostic,
  type TreeContextFieldListing
} from '@treeport/shared'

export async function loadTreeContextFields({
  dataDir,
  projectRoot
}: {
  dataDir: string
  projectRoot: string
}): Promise<TreeContextFieldListing> {
  const diagnostics: TreeContextFieldDiagnostic[] = []
  const definitionsByScope: TreeContextFieldDefinition[][] = []
  const settingsFiles = [
    { scope: 'global' as const, path: path.join(dataDir, 'settings.json') },
    {
      scope: 'project' as const,
      path: path.join(projectRoot, '.treeport', 'settings.json')
    }
  ]

  for (const settings of settingsFiles) {
    const content = await fs.readFile(settings.path, 'utf8').catch((error) => {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return null
      }

      diagnostics.push({
        scope: settings.scope,
        path: settings.path,
        message: `Could not read ${settings.path}: ${
          error instanceof Error ? error.message : String(error)
        }`
      })
      return null
    })
    if (content === null || content.trim() === '') {
      definitionsByScope.push([])
      continue
    }

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(content)
    } catch (error) {
      diagnostics.push({
        scope: settings.scope,
        path: settings.path,
        message: `Could not parse ${settings.path}: ${
          error instanceof Error ? error.message : String(error)
        }`
      })
      definitionsByScope.push([])
      continue
    }

    const parsedSettings = z
      .looseObject({ treeContext: z.unknown().optional() })
      .safeParse(parsedJson)
    if (!parsedSettings.success) {
      diagnostics.push({
        scope: settings.scope,
        path: settings.path,
        message: `${settings.path} must contain a JSON object`
      })
      definitionsByScope.push([])
      continue
    }

    if (parsedSettings.data.treeContext === undefined) {
      definitionsByScope.push([])
      continue
    }

    const parsedTreeContext = z
      .looseObject({ fields: z.unknown().optional() })
      .safeParse(parsedSettings.data.treeContext)
    const parsedFields = z
      .array(z.unknown())
      .safeParse(
        parsedTreeContext.success
          ? (parsedTreeContext.data.fields ?? [])
          : undefined
      )
    if (!parsedTreeContext.success || !parsedFields.success) {
      diagnostics.push({
        scope: settings.scope,
        path: settings.path,
        message: `${settings.path} treeContext.fields must be an array`
      })
      definitionsByScope.push([])
      continue
    }

    const fields: TreeContextFieldDefinition[] = []
    const ids = new Set<string>()
    for (const [index, input] of parsedFields.data.entries()) {
      if (fields.length === TREE_CONTEXT_FIELD_MAX_COUNT) {
        diagnostics.push({
          scope: settings.scope,
          path: settings.path,
          message: `${settings.path} treeContext.fields cannot contain more than ${TREE_CONTEXT_FIELD_MAX_COUNT} fields`
        })
        break
      }

      const parsedField = treeContextFieldDefinitionSchema.safeParse(input)
      if (!parsedField.success) {
        diagnostics.push({
          scope: settings.scope,
          path: settings.path,
          message: `${settings.path} treeContext.fields[${index}] is invalid: ${parsedField.error.issues[0]?.message ?? 'invalid field'}`
        })
        continue
      }

      if (ids.has(parsedField.data.id)) {
        diagnostics.push({
          scope: settings.scope,
          path: settings.path,
          message: `${settings.path} contains duplicate tree context field ${parsedField.data.id}`
        })
        continue
      }

      ids.add(parsedField.data.id)
      fields.push(parsedField.data)
    }
    definitionsByScope.push(fields)
  }

  const fields = new Map<string, TreeContextFieldDefinition>()
  for (const [index, definitions] of definitionsByScope.entries()) {
    for (const definition of definitions) {
      if (
        !fields.has(definition.id) &&
        fields.size === TREE_CONTEXT_FIELD_MAX_COUNT
      ) {
        const settings = settingsFiles[index]!
        diagnostics.push({
          scope: settings.scope,
          path: settings.path,
          message: `Tree context cannot contain more than ${TREE_CONTEXT_FIELD_MAX_COUNT} fields`
        })
        break
      }

      fields.set(definition.id, definition)
    }
  }

  return { fields: [...fields.values()], diagnostics }
}
