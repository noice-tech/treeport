import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  TerminalPresetDefinition,
  TerminalPresetDefinitionDiagnostic
} from '@treeport/shared'
import {
  repositoryTerminalPresetSchema,
  repositoryTerminalPresetsFileSchema
} from '@treeport/shared'

const CONFIG_PATH = path.join('.treeport', 'terminal-presets.json')

export async function loadRepositoryTerminalPresets(
  projectId: string,
  worktreePath: string
): Promise<{
  definitions: TerminalPresetDefinition[]
  diagnostics: TerminalPresetDefinitionDiagnostic[]
}> {
  const configPath = path.join(worktreePath, CONFIG_PATH)
  const content = await fs
    .readFile(configPath, 'utf8')
    .catch((error: unknown) => {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined
      if (code === 'ENOENT') {
        return null
      }

      return error instanceof Error ? error : new Error(String(error))
    })
  if (content === null) {
    return { definitions: [], diagnostics: [] }
  }

  if (content instanceof Error) {
    return {
      definitions: [],
      diagnostics: [
        {
          path: CONFIG_PATH,
          itemId: null,
          message: `Could not read repository terminal presets: ${content.message}`
        }
      ]
    }
  }

  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    return {
      definitions: [],
      diagnostics: [
        {
          path: CONFIG_PATH,
          itemId: null,
          message: `Could not parse repository terminal presets: ${error instanceof Error ? error.message : String(error)}`
        }
      ]
    }
  }

  const file = repositoryTerminalPresetsFileSchema.safeParse(value)
  if (!file.success) {
    return {
      definitions: [],
      diagnostics: [
        {
          path: CONFIG_PATH,
          itemId: null,
          message: `Invalid repository terminal presets: ${file.error.issues
            .map(
              (issue) => `${issue.path.join('.') || 'value'} ${issue.message}`
            )
            .join('; ')}`
        }
      ]
    }
  }

  const definitions: TerminalPresetDefinition[] = []
  const diagnostics: TerminalPresetDefinitionDiagnostic[] = []
  for (const presetId of Object.keys(file.data.presets).sort()) {
    const preset = repositoryTerminalPresetSchema.safeParse(
      file.data.presets[presetId]
    )
    if (!preset.success) {
      diagnostics.push({
        path: CONFIG_PATH,
        itemId: presetId,
        message: `Invalid repository terminal preset ${presetId}: ${preset.error.issues
          .map((issue) => `${issue.path.join('.') || 'value'} ${issue.message}`)
          .join('; ')}`
      })
      continue
    }

    definitions.push({
      id: `repository:${projectId}:terminal-preset:${presetId}`,
      name: preset.data.name,
      executable: preset.data.executable,
      args: [...preset.data.args],
      cwd: null,
      env: {},
      closeOnSuccess: preset.data.closeOnSuccess,
      source: { type: 'repository', format: 'treeport' }
    })
  }

  return { definitions, diagnostics }
}
