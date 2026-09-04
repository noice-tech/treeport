import fs from 'node:fs/promises'
import path from 'node:path'
import * as Either from 'effect/Either'
import * as ParseResult from 'effect/ParseResult'
import * as Schema from 'effect/Schema'
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
  const content = await fs.readFile(configPath, 'utf8').catch((error) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
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

  const file = Schema.decodeUnknownEither(repositoryTerminalPresetsFileSchema)(
    value
  )
  if (Either.isLeft(file)) {
    return {
      definitions: [],
      diagnostics: [
        {
          path: CONFIG_PATH,
          itemId: null,
          message: `Invalid repository terminal presets: ${ParseResult.TreeFormatter.formatErrorSync(file.left)}`
        }
      ]
    }
  }

  const definitions: TerminalPresetDefinition[] = []
  const diagnostics: TerminalPresetDefinitionDiagnostic[] = []
  for (const presetId of Object.keys(file.right.presets).sort()) {
    const preset = Schema.decodeUnknownEither(repositoryTerminalPresetSchema)(
      file.right.presets[presetId]
    )
    if (Either.isLeft(preset)) {
      diagnostics.push({
        path: CONFIG_PATH,
        itemId: presetId,
        message: `Invalid repository terminal preset ${presetId}: ${ParseResult.TreeFormatter.formatErrorSync(preset.left)}`
      })
      continue
    }

    definitions.push({
      id: `repository:${projectId}:terminal-preset:${presetId}`,
      name: preset.right.name,
      executable: preset.right.executable,
      args: [...preset.right.args],
      shellCommand: null,
      cwd: null,
      env: {},
      closeOnSuccess: preset.right.closeOnSuccess,
      source: { type: 'repository', format: 'treeport' }
    })
  }

  return { definitions, diagnostics }
}
